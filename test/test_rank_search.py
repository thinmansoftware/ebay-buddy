import importlib.util, json, pathlib, subprocess, sys, unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'companion/rank_search.py'

class RankSearchTests(unittest.TestCase):
    def run_rank(self, query, items, **changes):
        result = subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps(dict(
            q=query, result=dict(total=1606, returned=len(items), offset=0, limit=10,
                                 next_offset=10, match_basis='provider_search_candidates', items=items), **changes)),
            capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)
    def items(self):
        return [dict(item_id='v1|123456789011|0', title='DC All In Saga Darkseid vs The World #1 Cover A', price={'value':'5.63','currency':'USD'}),
                dict(item_id='v1|123456789012|0', title='Saga #1 Cover A Image Comics First Printing', price={'value':'99.00','currency':'USD'}),
                dict(item_id='v1|123456789013|0', title='Saga #10 Cover A'),
                dict(item_id='v1|123456789014|0', title='Saga #1 Cover B'),
                dict(item_id='v1|123456789015|0', title='Saga #1 Cover A reprint')]
    def test_exact_normalized_title_prefix_moves_a_candidate_not_a_false_series(self):
        result = self.run_rank('Saga 1 Cover A', self.items())
        self.assertEqual([i['item_id'] for i in result['items']], ['v1|123456789012|0','v1|123456789015|0','v1|123456789011|0','v1|123456789013|0','v1|123456789014|0'])
        self.assertEqual(result['total'],1606); self.assertEqual(result['next_offset'],10)
        self.assertEqual(result['items'][0]['price'], {'value':'99.00','currency':'USD'})
        self.assertEqual(result['match_basis'], 'provider_search_candidates')
        self.assertEqual(result['local_ranking']['scope'], 'returned_page_only')
        self.assertFalse(result['local_ranking']['verified_exact_comic_match'])
    def test_short_issue_query_distinguishes_issue_one_from_ten(self):
        result = self.run_rank('Saga 1', self.items())
        self.assertEqual([i['item_id'] for i in result['items']][:3], ['v1|123456789012|0','v1|123456789014|0','v1|123456789015|0'])
    def test_explicit_price_and_newly_listed_sorts_are_preserved(self):
        for sort in ['price','-price','newlyListed']:
            result = self.run_rank('Saga 1', self.items(), sort=sort)
            self.assertEqual(result['items'],self.items())
            self.assertEqual(result['local_ranking']['method'],'provider_explicit_sort')
    def test_absent_candidate_is_not_invented_and_one_item_remains_one(self):
        for items in [[],self.items()[:1]]:
            self.assertEqual(self.run_rank('Saga 1', items)['items'],items)
    def test_untrusted_punctuation_does_not_execute_or_modify_titles(self):
        items=[dict(item_id='v1|123456789011|0', title='Saga #1 <script>alert(1)</script>')]
        self.assertEqual(self.run_rank('Saga #1',items)['items'],items)
    def test_malformed_and_oversized_input_are_rejected_without_echo(self):
        for payload in [{'q':'Saga','result':{'items':[{}]}}, {'q':'Saga','result':{'items':self.items()*11}},
                        {'q':' ','result':{'items':[]}}, {'q':'Saga','sort':'other','result':{'items':[]}}]:
            result=subprocess.run([sys.executable,str(SCRIPT)],input=json.dumps(payload),capture_output=True,text=True)
            self.assertEqual(result.returncode,2); self.assertEqual(json.loads(result.stdout),{'error':'search_ranking_rejected'})
            self.assertEqual(result.stderr,'')

if __name__ == '__main__':unittest.main()
