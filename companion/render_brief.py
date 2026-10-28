"""Render a cover-led, read-only host artifact from the local mail brief.
No network requests. Email content is always escaped, never executable markup.
"""
import html,json,re,sys
from datetime import datetime, timezone
from urllib.parse import urlsplit
def esc(value):return html.escape(str(value or ''),quote=True)
def cover_url(order):
    cover=order.get('cover') or {};item=order.get('item_id')
    if cover.get('source')!='get_ebay_item' or not item or cover.get('item_id')!=item:return None
    try:
        u=urlsplit(cover.get('url',''))
        if u.scheme=='https' and u.hostname=='i.ebayimg.com' and not(u.username or u.password or u.port or u.query or u.fragment) and re.fullmatch(r'/images/[A-Za-z0-9_~./-]+\.(?:jpg|jpeg|png|webp)',u.path,re.I):return u.geturl()
    except (ValueError,TypeError):pass
    return None
def render(brief):
    if brief.get('source')!='gmail_ebay_messages' or not isinstance(brief.get('orders'),list) or len(brief['orders'])>10:raise ValueError('bounded email brief required')
    cards=[]
    on_demand=brief.get('mode')=='on_demand'
    review=brief.get('review_needed',[])
    if on_demand and(not isinstance(review,list) or len(review)>10):raise ValueError('bounded review count required')
    for order in brief['orders']:
        unknown_time=on_demand and order.get('received_at_source')=='unavailable' and order.get('received_at') is None
        if order.get('order_id_source')!='email_labeled_order_number' or not(unknown_time or order.get('received_at_source')=='gmail_internalDate'):raise ValueError('verified email provenance required')
        kind=order.get('kind');labels={'sale':'Sale email','cancellation':'Cancellation email','refund':'Refund email'}
        if kind not in labels:raise ValueError('unsupported event kind')
        identity=order.get('item_identity_source')
        if identity is not None and(not on_demand or kind!='sale' or identity!='ebay_seller_hub'):raise ValueError('unsupported item identity provenance')
        identity_label='<p class="meta">Item identity: Seller Hub order details<br>Title, listing ID and quantity</p>' if identity else ''
        source_label='Email notice; item identity and quantity from Seller Hub.' if identity else 'Email-derived.'
        image=cover_url(order);qty=order.get('quantity')
        quantity=(str(qty)+' marketplace unit'+('' if qty==1 else 's')) if type(qty) is int and 1<=qty<=9999 else 'Quantity not stated'
        photo='<img src="'+esc(image)+'" alt="Listing photo" loading="lazy" referrerpolicy="no-referrer"><small class="photo-note">Cover unavailable if the image does not load.</small>' if image else '<span class="missing">Cover unavailable<br><small>No verified listing photo</small></span>'
        listing='<br>Listing number '+esc(order['legacy_item_id']) if isinstance(order.get('legacy_item_id'),str) and re.fullmatch(r'[0-9]{9,15}',order['legacy_item_id']) else ''
        received='<span>Received time unavailable</span>'
        if not unknown_time and isinstance(order.get('received_at'), str):
            try:
                stamp=datetime.fromisoformat(order['received_at'].replace('Z','+00:00'))
                if stamp.tzinfo is not None:
                    received='<time datetime="'+esc(order['received_at'])+'">'+esc(stamp.astimezone(timezone.utc).strftime('%b %d, %Y %H:%M UTC'))+'</time>'
            except ValueError:pass
        cards.append('<article class="order" data-kind="'+kind+'"><div class="art">'+photo+'</div><div class="body"><span class="status '+kind+'">'+labels[kind]+'</span><h2>'+esc(order.get('title') or 'Order item not stated')+'</h2>'+identity_label+'<p class="quantity">'+quantity+'</p><p class="meta">Order '+esc(order.get('order_id'))+'<br>'+received+listing+'</p><details><summary>Source and limits</summary><p>'+source_label+' Live eBay status not checked. Physical stock and refund clearance are not established.</p><p>Message reference: '+esc(order.get('gmail_message_id'))+'</p><p>Listing photo is illustrative of the listing; exact physical variant is not certified.</p></details></div></article>')
    counts={'all':len(cards),**{kind:sum(order.get('kind')==kind for order in brief['orders']) for kind in ('sale','cancellation','refund')}}
    filters='<nav aria-label="Filter email notices"><fieldset class="filters"><legend class="sr-only">Filter email notices</legend>'
    for kind,label in [('all','All notices'),('sale','Sales'),('cancellation','Cancellations'),('refund','Refunds')]:
        filters+='<input class="filter-control" type="radio" name="notice-filter" id="filter-'+kind+'"'+(' checked' if kind=='all' else '')+'><label for="filter-'+kind+'">'+label+' <span class="count">'+str(counts[kind])+'</span></label>'
    filters+='</fieldset></nav>'
    empty=''
    if not cards:
        text=('No notices can be shown; '+str(len(review))+' notice(s) need review.') if review else 'No eBay notices were supplied.'
        empty+='<p class="empty empty-all default-empty" role="status">'+text+'</p>'
    for kind in ('sale','cancellation','refund'):
        if not counts[kind]:empty+='<p class="empty empty-'+kind+'" role="status">No '+kind+' notices in this brief.</p>'
    document='''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https://i.ebayimg.com; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>eBay Buddy - Email order brief</title><style>
:root{color-scheme:light dark;--paper:#f7f9fd;--ink:#172234;--muted:#526278;--line:#d8e0ec;--surface:#fff;--blue:#2455cc;--soft:#eaf0ff}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 system-ui,sans-serif}main{max-width:1000px;margin:auto;padding:28px 24px}header{display:flex;gap:20px;justify-content:space-between;align-items:center}h1{font-size:clamp(25px,4vw,38px);margin:0;line-height:1.1;letter-spacing:-.04em}.brand{color:var(--blue);font-weight:750;margin:0 0 8px}.mode{font-size:12px;background:var(--soft);padding:7px 11px;border-radius:7px;white-space:nowrap}.intro{color:var(--muted);max-width:64ch;margin:18px 0}nav{display:flex;gap:8px;flex-wrap:wrap;margin:22px 0}button{font:inherit;min-height:44px;padding:8px 15px;background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:7px;cursor:pointer}button[aria-pressed=true]{color:var(--surface);background:var(--blue);border-color:var(--blue)}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.order{background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden;display:grid;grid-template-columns:38% minmax(0,1fr)}.order[hidden]{display:none}.art{min-height:245px;display:flex;align-items:center;justify-content:center;background:var(--soft);padding:12px}.art img{width:100%;max-height:285px;object-fit:contain}.missing{font-weight:650;text-align:center;font-size:14px;color:var(--muted)}.missing small{font-size:11px;font-weight:400}.body{padding:19px;min-width:0}h2{font-size:17px;line-height:1.35;margin:12px 0;overflow-wrap:anywhere}.quantity{font-size:18px;font-weight:750;margin:0}.status{font-size:12px;font-weight:650;padding:3px 8px;border-radius:5px;background:var(--soft);color:var(--blue)}.meta{font-size:12px;color:var(--muted);overflow-wrap:anywhere}details{font-size:12px;border-top:1px solid var(--line);margin-top:16px;padding-top:12px}summary{cursor:pointer;min-height:30px}details p{color:var(--muted);overflow-wrap:anywhere}footer{font-size:12px;color:var(--muted);margin:22px 0}#empty{color:var(--muted)}@media(prefers-color-scheme:dark){:root{--paper:#111927;--ink:#eef3fa;--muted:#b1bed0;--line:#354154;--surface:#192436;--blue:#9db8ff;--soft:#24344d}button[aria-pressed=true]{color:#111927}}@media(max-width:760px){.grid{grid-template-columns:1fr}main{padding:20px 16px}.order{grid-template-columns:33% minmax(0,1fr)}header{align-items:flex-start;flex-wrap:wrap}}@media(max-width:360px){.body{padding:12px}.art{padding:6px}.mode{white-space:normal}h2{font-size:15px}}
</style></head><body><main><header><div><p class="brand">eBay Buddy</p><h1>Your email order brief</h1></div><span class="mode">Email-derived / read-only</span></header>
<p class="intro">Recent eBay seller email notices, ready to review. Covers come from exact item lookups when available. Scheduled checks require an enabled host routine.</p>
'''+filters+'''<section class="grid" aria-label="Order notices">'''+''.join(cards)+'''</section>'''+empty+'''<footer>Live eBay status not checked. Email quantity is not proof of physical copies, stock, shipment or refund clearance.</footer></main></body></html>'''
    static_css='''
.filters{border:0;padding:0;margin:0;display:flex;gap:8px;flex-wrap:wrap}.sr-only,.filter-control{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.filters label{display:inline-flex;gap:8px;align-items:center;min-height:44px;padding:8px 14px;background:var(--surface);border:1px solid var(--line);border-radius:7px;cursor:pointer}.filter-control:checked+label{background:var(--blue);color:var(--surface);border-color:var(--blue)}.filter-control:focus-visible+label{outline:3px solid var(--ink);outline-offset:3px}.count{font-size:12px}.empty{display:none;color:var(--muted)}.default-empty{display:block}.photo-note{display:block;font-size:12px;line-height:1.4;text-align:center;color:var(--muted);margin-top:10px}.art{flex-direction:column}.meta,details,footer{font-size:13px}.art img{max-width:100%}main:has(#filter-sale:checked) .order:not([data-kind="sale"]),main:has(#filter-cancellation:checked) .order:not([data-kind="cancellation"]),main:has(#filter-refund:checked) .order:not([data-kind="refund"]){display:none}main:has(#filter-sale:checked) .empty-sale,main:has(#filter-cancellation:checked) .empty-cancellation,main:has(#filter-refund:checked) .empty-refund{display:block}main:has(#filter-sale:checked) .default-empty,main:has(#filter-cancellation:checked) .default-empty,main:has(#filter-refund:checked) .default-empty{display:none}@media(max-width:900px){.grid{grid-template-columns:1fr}}@media(prefers-color-scheme:dark){.filter-control:checked+label{color:#111927}}
'''
    document=document.replace('</style>',static_css+'</style>',1)
    if on_demand:
        document=document.replace('Your email order brief','On-demand email brief',1)
        document=document.replace('Recent eBay seller email notices, ready to review. Covers come from exact item lookups when available. Scheduled checks require an enabled host routine.','Requested eBay email notices. Received times may be unavailable; notices are not ordered by recency and do not establish current order status. No alert or schedule is enabled. Covers come from exact item lookups when available.',1)
        if review:document=document.replace('<nav aria-label="Filter email notices">','<p role="status">Incomplete coverage: '+str(len(review))+' notice(s) held for review. The cards below do not include those notices.</p><nav aria-label="Filter email notices">',1)
    if any(order.get('item_identity_source')=='ebay_seller_hub' for order in brief['orders']):
        document=document.replace('Email quantity is not proof','Marketplace quantity is not proof',1)
    return document

def main():
    try:
        raw=sys.stdin.buffer.read(262145)
        if len(raw)>262144:raise ValueError('input limit')
        sys.stdout.write(render(json.loads(raw)))
    except Exception:print('Invalid bounded email brief',file=sys.stderr);raise SystemExit(2)
if __name__=='__main__':main()
