"""Local eBay-email event ledger. No Gmail API, credentials, network or mail writes.
The host's existing Gmail connection supplies bounded, normalized email facts.
"""
import argparse,datetime,hashlib,html,json,os,pathlib,re,sqlite3,sys,uuid
from email.utils import parseaddr
from html.parser import HTMLParser
from urllib.parse import parse_qs,urlsplit

class NoticeHTML(HTMLParser):
    """Text and native item anchors only; never execute or fetch HTML content."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts=[];self.links=[];self.anchor=None;self.ignored=0
    def handle_starttag(self,tag,attrs):
        if tag in ['script','style','head']:
            self.ignored+=1;return
        if self.ignored:return
        if tag in ['br','p','div','tr','td','th','li','h1','h2','h3','table']:self.parts.append('\n')
        if tag=='a':self.anchor=[dict(attrs).get('href',''),'']
    def handle_endtag(self,tag):
        if tag in ['script','style','head']:
            self.ignored=max(0,self.ignored-1);return
        if self.ignored:return
        if tag=='a' and self.anchor:
            self.links.append(tuple(self.anchor));self.anchor=None
        if tag in ['p','div','tr','td','th','li','h1','h2','h3','table']:self.parts.append('\n')
    def handle_data(self,data):
        if not self.ignored:
            self.parts.append(data)
            if self.anchor:self.anchor[1]+=data

def native_listing(url):
    """A direct native item link, never an order/redirect/tracking query value."""
    try:
        u=urlsplit(html.unescape(url))
        if u.scheme!='https' or u.hostname not in ['ebay.com','www.ebay.com'] or u.username or u.password or u.port:return None
        match=re.fullmatch(r'/itm/(?:[^/]+/)?([0-9]{9,15})/?',u.path)
    except (ValueError,TypeError):return None
    if match and 'var' in parse_qs(u.query,keep_blank_values=True):raise ValueError('listing_variation_requires_review')
    return match.group(1) if match else None

FIELD_LABEL=re.compile(r'(?i)^(Order(?:[ \t]+(?:number|ID))?|Item[ \t]+(?:title|name|number|ID)|Item[ \t]*#|Listing[ \t]+(?:number|ID)|Title|Quantity(?:[ \t]+sold)?)[ \t]*:[ \t]*(.*)$')
def label_kind(label):
    label=' '.join(label.lower().split())
    if label.startswith('order'):return 'order'
    if label.startswith('quantity'):return 'quantity'
    if label in ['title','item title','item name']:return 'title'
    return 'legacy_item_id'
def clean_title(value):
    value=' '.join(html.unescape(value).split())
    return value if 1<=len(value)<=300 and not re.search(r'(?:\.\.\.|\u2026)',value) else None

def is_cta(title):
    return re.fullmatch(r'(?i)(?:(?:view|see|open)(?: (?:your|the|this|purchased|sold))? (?:item|listing|order)(?: details)?(?: on ebay)?|click here)',title)

def order_identity(raw,order_id,*,on_demand):
    """Validate minimal same-order host evidence; this tag is not authentication."""
    if 'order_identity' not in raw:return None
    if not on_demand or raw.get('kind')!='sale':raise ValueError('order_identity_requires_on_demand_sale')
    evidence=raw['order_identity']
    if not isinstance(evidence,dict) or set(evidence)!={'source','order_id','complete','items'}:raise ValueError('invalid_order_identity')
    if evidence['source']!='ebay_seller_hub' or evidence['order_id']!=order_id or evidence['complete'] is not True:raise ValueError('invalid_order_identity')
    rows=evidence['items']
    if not isinstance(rows,list) or len(rows)!=1:raise ValueError('single_order_item_required')
    item=rows[0]
    if not isinstance(item,dict) or set(item)!={'title','legacy_item_id','item_url','quantity'}:raise ValueError('invalid_order_identity')
    title=clean_title(item['title']) if isinstance(item['title'],str) else None
    legacy=item['legacy_item_id'];url=item['item_url'];quantity=item['quantity']
    if not title or not isinstance(legacy,str) or not re.fullmatch(r'[0-9]{9,15}',legacy):raise ValueError('invalid_order_identity')
    if not isinstance(url,str) or len(url)>2048 or native_listing(url)!=legacy:raise ValueError('invalid_order_identity')
    if type(quantity) is not int or not 1<=quantity<=9999:raise ValueError('invalid_order_identity')
    return {'title':title,'legacy_item_id':legacy,'quantity':quantity}

def extract_notice(raw,*,on_demand=False):
    """Fail closed on conflicting explicit facts or multiple item identities.
    Unknown fields stay unknown. These are email facts, not live seller status.
    """
    texts=[];links=[]
    for key in ['text_body','html_body']:
        body=raw.get(key)
        if body is None:continue
        if not isinstance(body,str) or len(body)>100000:raise ValueError('complete_email_body_required')
        if key=='html_body' or re.search(r'<(?:!doctype|html|body|table|div|p|a|tr|td)\b',body,re.I):
            parser=NoticeHTML();parser.feed(body);parser.close()
            texts.append(''.join(parser.parts));links.extend(parser.links)
        else:texts.append(html.unescape(body))
    if raw.get('body_complete') is not True or not texts:raise ValueError('complete_email_body_required')
    found={key:set() for key in ['order','title','quantity','legacy_item_id']};adjacent=[]
    for body in texts:
        lines=[line.strip() for line in body.splitlines() if line.strip()]
        pending=None
        for index,line in enumerate(lines):
            # Inspect links even when this line is consumed as a split field value.
            for title,url in re.findall(r'\[([^\]\n]+)\]\((https://[^\s)]+)\)',line):links.append((url,title))
            for url in re.findall(r'https://[^\s<>"\)]+',line):
                number=native_listing(url)
                if number:found['legacy_item_id'].add(number)
            label=FIELD_LABEL.fullmatch(line)
            if pending:
                # A second label is an unresolved field, not a value to skip.
                found[pending].add('' if label else line);pending=None
                if not label:continue
            if label:
                kind=label_kind(label.group(1));value=label.group(2).strip()
                if value:found[kind].add(value)
                else:pending=kind
                # Common plain seller template: title immediately above Item number.
                if kind=='legacy_item_id' and index>0 and not FIELD_LABEL.fullmatch(lines[index-1]):
                    previous=lines[index-1]
                    consumed=index>1 and FIELD_LABEL.fullmatch(lines[index-2]) and not FIELD_LABEL.fullmatch(lines[index-2]).group(2).strip()
                    if not consumed and not is_cta(previous) and not re.search(r'\[[^\]]+\]\(https://',previous) and re.search(r'[^\W\d_]',previous) and not re.search(r'(?i)^(?:https?://|order\b|you\b|your\b|view\b|refund\b|cancel\b)',previous):adjacent.append(previous)
        if pending:found[pending].add('')
    for url,title in links:
        number=native_listing(url)
        if not number:continue
        found['legacy_item_id'].add(number)
        title=' '.join(html.unescape(title).split())
        if title and not is_cta(title):found['title'].add(title)
    # A supported plain-text title is evidence even when an HTML alternative
    # supplies a title too. Never erase disagreements by preferring one channel.
    found['title'].update(adjacent)
    orders=found['order']
    if len(orders)!=1 or not all(re.fullmatch(r'[0-9]{2}-[0-9]{5}-[0-9]{5}',order) for order in orders):raise ValueError('labeled_order_number_missing_or_ambiguous')
    identity=order_identity(raw,next(iter(orders)),on_demand=on_demand)
    if identity:
        # Merge before conflict checks, retaining every email title/prefix/ID.
        found['title'].add(identity['title']);found['legacy_item_id'].add(identity['legacy_item_id'])
        found['quantity'].add(str(identity['quantity']))
    if len(found['legacy_item_id'])>1 or any(not re.fullmatch(r'[0-9]{9,15}',v) for v in found['legacy_item_id']):raise ValueError('listing_identity_missing_or_ambiguous')
    if raw.get('title') is not None:
        if not isinstance(raw['title'],str):raise ValueError('conflicting_host_item_facts')
        found['title'].add(raw['title'])
    raw_titles={' '.join(html.unescape(t).split()) for t in found['title']}
    if any(len(t)>300 for t in raw_titles):raise ValueError('conflicting_item_title')
    titles={clean_title(t) for t in raw_titles};titles.discard(None)
    if len(titles)>1:raise ValueError('conflicting_item_title')
    prefixes=[re.split(r'\.\.\.|\u2026',t,maxsplit=1)[0].strip().casefold() for t in raw_titles if re.search(r'\.\.\.|\u2026',t)]
    if any(not a.startswith(b) and not b.startswith(a) for a in prefixes for b in prefixes):raise ValueError('conflicting_item_title')
    if titles and any(not next(iter(titles)).casefold().startswith(prefix) for prefix in prefixes):raise ValueError('conflicting_item_title')
    quantities=found['quantity']
    if len(quantities)>1 or any(not re.fullmatch(r'[0-9]{1,4}',v) or not 1<=int(v)<=9999 for v in quantities):raise ValueError('conflicting_item_quantity')
    facts={'order_id':next(iter(orders)), 'title':next(iter(titles),None),
           'legacy_item_id':next(iter(found['legacy_item_id']),None),
           'quantity':int(next(iter(quantities))) if quantities else None}
    if identity:facts['item_identity_source']='ebay_seller_hub'
    for field in ['title','legacy_item_id','quantity']:
        supplied=raw.get(field);derived=facts[field]
        if field=='title' and isinstance(supplied,str):supplied=clean_title(supplied)
        if supplied is not None and derived is not None and supplied!=derived:raise ValueError('conflicting_host_item_facts')
        if derived is None:facts[field]=supplied
    legacy=facts['legacy_item_id'];rest=raw.get('item_id')
    if legacy is not None and (not isinstance(legacy,str) or not re.fullmatch(r'[0-9]{9,15}',legacy)):raise ValueError('listing_identity_missing_or_ambiguous')
    if rest is not None and not isinstance(rest,str):raise ValueError('conflicting_host_item_facts')
    if legacy and rest and not re.fullmatch(r'v1\|'+re.escape(legacy)+r'\|[0-9]{1,20}',rest):raise ValueError('conflicting_host_item_facts')
    facts.update(item_id=rest,cover=raw.get('cover'))
    if legacy:
        # Legacy IDs identify a parent listing. Only an actual exact non-variation
        # lookup result can establish a REST item and image; never append |0 here.
        facts.update(item_id=None,cover=None)
        lookup=raw.get('item_lookup')
        if isinstance(lookup,dict) and lookup.get('source')=='get_ebay_item' and not lookup.get('isError'):
            returned=lookup.get('item_id')
            if lookup.get('legacy_item_id') in [None,legacy] and isinstance(returned,str) and re.fullmatch(r'v1\|'+re.escape(legacy)+r'\|0',returned) and (not rest or rest==returned):
                facts['item_id']=returned
                images=lookup.get('images')
                if isinstance(images,list) and images and isinstance(images[0],str):facts['cover']={'url':images[0],'item_id':returned,'source':'get_ebay_item'}
    return facts

def digest(value):return hashlib.sha256(value.encode('utf-8')).hexdigest()
def bounded(value,size):
    if not isinstance(value,str) or not value or len(value)>size:raise ValueError('invalid bounded field')
    return value
def require_provenance(message):
    if message.get('order_id_source')!='email_labeled_order_number':raise ValueError('verified order identity provenance required')
    if message.get('received_at_source')!='gmail_internalDate':raise ValueError('verified received time provenance required')
def normalize(message,*,on_demand=False):
    if 'order_identity' in message or 'item_identity_source' in message:
        if 'order_identity' in message or not on_demand or message.get('kind')!='sale' or message.get('item_identity_source')!='ebay_seller_hub':raise ValueError('order_identity_requires_on_demand_sale')
    address=parseaddr(bounded(message.get('from_address'),320))[1]
    domain=address.rsplit('@',1)[-1].lower()
    if '@' not in address or not(domain=='ebay.com' or domain.endswith('.ebay.com')):raise ValueError('sender outside eBay filter')
    mid=bounded(message.get('gmail_message_id'),256);order=bounded(message.get('order_id'),64)
    if not re.fullmatch(r'[0-9]{2}-[0-9]{5}-[0-9]{5}',order):raise ValueError('native order ID required')
    unknown_time=on_demand and message.get('received_at_source')=='unavailable' and message.get('received_at') is None
    if unknown_time:
        if message.get('order_id_source')!='email_labeled_order_number':raise ValueError('verified order identity provenance required')
    else:require_provenance(message)
    kind=message.get('kind')
    if kind not in ['sale','cancellation','refund']:raise ValueError('unsupported email event kind')
    date=None
    if not unknown_time:
        stamp=bounded(message.get('received_at'),40)
        try:
            date=datetime.datetime.fromisoformat(stamp.replace('Z','+00:00'))
            if date.tzinfo is None:raise ValueError()
        except ValueError:raise ValueError('timezone-aware email time required') from None
    qty=message.get('quantity')
    if qty is not None and(type(qty) is not int or not 1<=qty<=9999):raise ValueError('invalid marketplace quantity')
    item=message.get('item_id');cover=None
    if item is not None and not re.fullmatch(r'v1\|\d{9,15}\|\d{1,20}',item):raise ValueError('invalid listing item ID')
    image=message.get('cover')
    if isinstance(image,dict) and image.get('source')=='get_ebay_item' and item and image.get('item_id')==item:
        try:
            u=urlsplit(image.get('url',''))
            if u.scheme=='https' and u.hostname=='i.ebayimg.com' and not(u.username or u.password or u.port or u.query or u.fragment) and re.fullmatch(r'/images/[A-Za-z0-9_~./-]+\.(?:jpg|jpeg|png|webp)',u.path,re.I):
                cover={'url':u.geturl(),'item_id':item,'source':'get_ebay_item','label':'Listing photo; physical cover not verified'}
        except (ValueError,TypeError):pass
    title=message.get('title')
    if title is not None and(not isinstance(title,str) or len(title)>300):raise ValueError('invalid title')
    if message.get('item_identity_source')=='ebay_seller_hub' and(not isinstance(title,str) or not clean_title(title) or not isinstance(message.get('legacy_item_id'),str) or not re.fullmatch(r'[0-9]{9,15}',message['legacy_item_id']) or type(qty) is not int):raise ValueError('invalid_order_identity')
    result={'gmail_message_id':mid,'order_id':order,'order_id_source':'email_labeled_order_number','kind':kind,'received_at':date.astimezone(datetime.timezone.utc).isoformat() if date else None,'received_at_source':'unavailable' if unknown_time else 'gmail_internalDate','title':title,'quantity':qty,'item_id':item,'cover':cover,'status_basis':'email_only','live_ebay_status':'not_checked','physical_readiness':'not_checked','refund_clearance':'not_established'}
    if message.get('legacy_item_id') is not None:result['legacy_item_id']=message['legacy_item_id']
    if message.get('item_identity_source')=='ebay_seller_hub':result['item_identity_source']='ebay_seller_hub'
    return result

def prepare(payload,*,on_demand=False):
    """Normalize full native reads without a ledger. The host must supply real
    tool fields: provenance tags are not authentication or proof of access.
    """
    bounded(payload.get('mailbox_id'),320)
    incoming=payload.get('messages',[])
    if not isinstance(incoming,list) or len(incoming)>(10 if on_demand else 100):raise ValueError('bounded batch required')
    ready=[];review=[];seen={}
    for raw in incoming:
        if not isinstance(raw,dict):raise ValueError('invalid email record')
        mid=bounded(raw.get('gmail_message_id'),256);reasons=[]
        if on_demand:
            facts={key:raw.get(key) for key in ['from_address','kind','text_body','html_body','body_complete','internalDate','title','quantity','item_id','legacy_item_id','cover','item_lookup','order_identity']}
            facts['order_identity_supplied']='order_identity' in raw
            if mid in seen:
                if seen[mid]!=facts:raise ValueError('conflicting message identity')
                continue
            seen[mid]=facts
        try:notice=extract_notice(raw,on_demand=on_demand)
        except ValueError as error:reasons.append(str(error))
        stamp=raw.get('internalDate');received=None
        if type(stamp) is str and re.fullmatch(r'[0-9]{1,15}',stamp) and int(stamp)<253402300800000:
            received=(datetime.datetime(1970,1,1,tzinfo=datetime.timezone.utc)+datetime.timedelta(milliseconds=int(stamp))).isoformat()
        elif not on_demand:reasons.append('gmail_internal_received_time_unavailable')
        if not reasons:
            message={key:raw.get(key) for key in ['gmail_message_id','from_address','kind']}
            message.update(notice,order_id_source='email_labeled_order_number',received_at=received,received_at_source='gmail_internalDate' if received else 'unavailable')
            try:ready.append(dict(normalize(message,on_demand=on_demand),from_address=raw['from_address']))
            except (ValueError,TypeError):reasons.append('invalid_email_notice')
        if reasons:review.append({'gmail_message_id':mid,'reasons':reasons})
    if on_demand:
        unique={}
        for notice in ready:
            notice.pop('from_address',None);mid=notice['gmail_message_id']
            if mid in unique and unique[mid]!=notice:raise ValueError('conflicting message identity')
            unique[mid]=notice
        return {'read_only':True,'source':'gmail_ebay_messages','mode':'on_demand','coverage':'requested_email_notices_not_current_order_status','orders':list(unique.values()),'review_needed':review,'live_ebay_status':'not_checked','notifications_sent':0}
    return {'read_only':True,'messages':ready,'review_needed':review,'notifications_sent':0}

def run(path,command,payload):
    if command=='prepare':return prepare(payload)
    if command=='prepare-brief':return prepare(payload,on_demand=True)
    if command not in ['baseline','ingest','claim','finish','inspect','brief']:raise ValueError('unsupported local command')
    mailbox=digest(bounded(payload.get('mailbox_id'),320));messages=payload.get('messages',[])
    if not isinstance(messages,list) or len(messages)>100:raise ValueError('batch limit100')
    facts=[normalize(m) for m in messages]
    path=pathlib.Path(path);path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    if not path.exists():
        fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
    db=sqlite3.connect(path,timeout=5);db.row_factory=sqlite3.Row
    try:
        db.executescript('CREATE TABLE IF NOT EXISTS mailboxes(id TEXT PRIMARY KEY,baseline_before TEXT NOT NULL);CREATE TABLE IF NOT EXISTS messages(mailbox TEXT,id TEXT,event TEXT,PRIMARY KEY(mailbox,id));CREATE TABLE IF NOT EXISTS events(mailbox TEXT,id TEXT,body TEXT,state TEXT,delivery_id TEXT,PRIMARY KEY(mailbox,id));')
        db.execute('BEGIN IMMEDIATE')
        established=db.execute('SELECT baseline_before FROM mailboxes WHERE id=?',(mailbox,)).fetchone()
        # Earlier candidate files may contain guessed IDs/times. Validate their
        # provenance before using or changing alert state; never upgrade by guess.
        if established and command in ['ingest','claim','finish','brief']:
            for row in db.execute('SELECT body FROM events WHERE mailbox=?',(mailbox,)):
                require_provenance(json.loads(row['body']))
        if command=='baseline':
            if established:raise ValueError('baseline already exists; do not reset alert history')
            cutoff=payload.get('baseline_before',datetime.datetime.now(datetime.timezone.utc).isoformat())
            try:
                parsed=datetime.datetime.fromisoformat(cutoff.replace('Z','+00:00'))
                if parsed.tzinfo is None:raise ValueError()
                cutoff=parsed.astimezone(datetime.timezone.utc).isoformat()
            except (ValueError,AttributeError):raise ValueError('valid baseline cutoff required') from None
            db.execute('INSERT INTO mailboxes VALUES(?,?)',(mailbox,cutoff))
        elif not established:raise ValueError('baseline required before monitoring')
        inserted=0
        if command in ['baseline','ingest']:
            for fact in facts:
                event=digest(mailbox+'\0'+fact['order_id']+'\0'+fact['kind']);mid=digest(fact['gmail_message_id'])
                old=db.execute('SELECT event FROM messages WHERE mailbox=? AND id=?',(mailbox,mid)).fetchone()
                if old and old['event']!=event:raise ValueError('message identity changed')
                db.execute('INSERT OR IGNORE INTO messages VALUES(?,?,?)',(mailbox,mid,event))
                prior=db.execute('SELECT body FROM events WHERE mailbox=? AND id=?',(mailbox,event)).fetchone()
                if prior:
                    if json.loads(prior['body'])['received_at']<=fact['received_at']:db.execute('UPDATE events SET body=? WHERE mailbox=? AND id=?',(json.dumps(fact),mailbox,event))
                else:
                    historical=command=='baseline' or fact['received_at']<=established['baseline_before']
                    db.execute('INSERT INTO events VALUES(?,?,?,?,NULL)',(mailbox,event,json.dumps(fact),'baseline' if historical else 'pending'));inserted+=1
            result={'read_only':True,'new_events':inserted,'notifications_sent':0,'baseline':command=='baseline'}
        elif command=='claim':
            limit=payload.get('limit',5)
            if type(limit) is not int or not 1<=limit<=10:raise ValueError('claim limit1-10')
            rows=db.execute("SELECT id,body FROM events WHERE mailbox=? AND state='pending' ORDER BY id LIMIT ?",(mailbox,limit)).fetchall();events=[]
            for row in rows:
                delivery=str(uuid.uuid4());db.execute("UPDATE events SET state='sending',delivery_id=? WHERE mailbox=? AND id=? AND state='pending'",(delivery,mailbox,row['id']));events.append(dict(json.loads(row['body']),event_id=row['id'],delivery_id=delivery))
            result={'read_only':True,'events':events,'notifications_sent':0}
        elif command=='finish':
            delivery=bounded(payload.get('delivery_id'),64);outcome=payload.get('outcome')
            if outcome not in ['delivered','uncertain']:raise ValueError('delivery outcome must be explicit')
            row=db.execute('SELECT id,state FROM events WHERE mailbox=? AND delivery_id=?',(mailbox,delivery)).fetchone()
            if not row:raise ValueError('delivery identity not found')
            if row['state'] not in ['sending',outcome]:raise ValueError('delivery state conflict')
            db.execute('UPDATE events SET state=? WHERE mailbox=? AND id=?',(outcome,mailbox,row['id']));result={'recorded_outcome':outcome,'notifications_sent':0}
        elif command=='brief':
            rows=[json.loads(r['body']) for r in db.execute('SELECT body FROM events WHERE mailbox=?',(mailbox,))]
            latest={}
            for fact in sorted(rows,key=lambda x:x['received_at']):
                # A later notice is its own evidence, not proof that an earlier
                # sale's item, quantity or photo applies to a cancellation/refund.
                latest[fact['order_id']]=fact
            result={'read_only':True,'source':'gmail_ebay_messages','coverage':'latest_known_email_notice_per_order','orders':sorted(latest.values(),key=lambda x:x['received_at'],reverse=True)[:10],'live_ebay_status':'not_checked','notifications_sent':0}
        else:
            result={'read_only':True,'states':dict((r['state'],r['n']) for r in db.execute('SELECT state,count(*) n FROM events WHERE mailbox=? GROUP BY state',(mailbox,))),'notifications_sent':0}
        db.commit();return result
    except Exception:db.rollback();raise
    finally:db.close()

def main():
    p=argparse.ArgumentParser();p.add_argument('command',choices=['prepare','prepare-brief','baseline','ingest','claim','finish','inspect','brief']);p.add_argument('--state');args=p.parse_args()
    try:
        if args.command not in ['prepare','prepare-brief'] and not args.state:raise ValueError('private state path required')
        # Complete HTML bodies are larger than the host's text projection.
        # Keep the existing alert/state command bound unchanged.
        limit=2*1024*1024 if args.command=='prepare-brief' else 262144
        raw=sys.stdin.buffer.read(limit+1)
        if len(raw)>limit:raise ValueError('input limit')
        print(json.dumps(run(args.state,args.command,json.loads(raw))))
    except Exception:print(json.dumps({'error':'mail_companion_rejected','notifications_sent':0}));raise SystemExit(2)
if __name__=='__main__':main()
