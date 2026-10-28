"""Optional local preference over one captured Browse page. No network or state.
Titles are seller text; lexical preference does not verify a comic or its cover.
"""
import json,re,sys,unicodedata

def tokens(text):
    return re.findall(r'[^\W_]+',unicodedata.normalize('NFKC',text).casefold())

def rank(payload):
    query=payload.get('q');result=payload.get('result');sort=payload.get('sort')
    if not isinstance(query,str) or not query.strip() or len(query)>400:raise ValueError()
    if sort not in [None,'price','-price','newlyListed']:raise ValueError()
    if not isinstance(result,dict):raise ValueError()
    items=result.get('items')
    if not isinstance(items,list) or len(items)>50:raise ValueError()
    for item in items:
        if not isinstance(item,dict) or not isinstance(item.get('title'),str) or not item['title'].strip() or len(item['title'])>1000 or not isinstance(item.get('item_id'),str) or not item['item_id']:raise ValueError()
    wanted=tokens(query)
    if not wanted:raise ValueError()
    ordered=items if sort else sorted(items,key=lambda item:tokens(item['title'])[:len(wanted)]!=wanted)
    return dict(result,items=ordered,local_ranking={
        'method':'provider_explicit_sort' if sort else 'normalized_title_prefix',
        'scope':'returned_page_only','verified_exact_comic_match':False,
        'limitation':'No extra provider calls; issue, variant, printing, grade, lots and presales require review.'})

def main():
    try:
        raw=sys.stdin.buffer.read(262145)
        if len(raw)>262144:raise ValueError()
        result=rank(json.loads(raw))
        output=json.dumps(result,ensure_ascii=False)
        if len(output.encode('utf-8'))>262144:raise ValueError()
        print(output)
    except Exception:
        print(json.dumps({'error':'search_ranking_rejected'}));raise SystemExit(2)

if __name__=='__main__':main()
