"""Synthetic templates only. No real mailbox captures or order details."""
import copy, importlib.util, json, pathlib, tempfile, unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('mail_watch_rc8', ROOT / 'companion/mail_watch.py')
mail = importlib.util.module_from_spec(spec); spec.loader.exec_module(mail)
spec = importlib.util.spec_from_file_location('render_rc8', ROOT / 'companion/render_brief.py')
renderer = importlib.util.module_from_spec(spec); spec.loader.exec_module(renderer)

class NoticeExtractionTests(unittest.TestCase):
    def setUp(self):
        self.fixtures = json.loads((ROOT / 'test/fixtures/synthetic_seller_notices.json').read_text())
        self.tmp = tempfile.TemporaryDirectory(); self.state = pathlib.Path(self.tmp.name) / 'unused.sqlite3'
    def tearDown(self): self.tmp.cleanup()
    def prepare(self, messages):
        result = mail.run(self.state, 'prepare-brief', {'mailbox_id':'synthetic-mailbox', 'messages': messages})
        self.assertFalse(self.state.exists()); return result
    def lookup(self, legacy='123456789011', **changes):
        return dict(source='get_ebay_item', item_id='v1|' + legacy + '|0', legacy_item_id=legacy,
                    images=['https://i.ebayimg.com/images/g/synthetic/s-l1600.jpg'], **changes)
    def test_body_only_sale_cancel_refund_extract_title_number_and_quantity(self):
        result = self.prepare(self.fixtures)
        self.assertEqual(result['review_needed'], [])
        self.assertEqual([(o['kind'], o['title'], o.get('legacy_item_id'), o['quantity']) for o in result['orders']], [
            ('sale', 'SYNTHETIC Saga #1 Cover A First Printing', '123456789011', 2),
            ('cancellation', 'SYNTHETIC Batman #25 Cover A', '123456789012', 1),
            ('refund', 'SYNTHETIC Spawn #1 & Variant Cover', '123456789013', 1)])
        for order in result['orders']:
            self.assertIsNone(order['item_id']); self.assertIsNone(order['cover'])
            self.assertIsNone(order['received_at']); self.assertNotIn('text_body', order)
    def test_exact_legacy_lookup_binds_cover_without_fabricating_rest_id(self):
        message = self.fixtures[0]; message['item_lookup'] = self.lookup()
        order = self.prepare([message])['orders'][0]
        self.assertEqual(order['item_id'], 'v1|123456789011|0')
        self.assertIsNotNone(order['cover'])
        self.assertEqual(order['cover']['url'], 'https://i.ebayimg.com/images/g/synthetic/s-l1600.jpg')
        output = renderer.render(self.prepare([message]))
        self.assertIn('SYNTHETIC Saga #1 Cover A First Printing', output)
        self.assertIn('src="https://i.ebayimg.com/images/g/synthetic/s-l1600.jpg"', output)
        self.assertIn('Listing number 123456789011', output)
    def test_mismatch_failed_and_variation_lookup_never_attaches_a_cover(self):
        cases = [self.lookup('123456789099'), dict(self.lookup(), isError=True),
                 dict(self.lookup(), item_id='v1|123456789011|123456789099'),
                 dict(self.lookup(), legacy_item_id='123456789099'),
                 dict(self.lookup(), source='search_ebay'),
                 dict(self.lookup(), images=['https://attacker.example/cover.jpg'])]
        for lookup in cases:
            with self.subTest(lookup=lookup):
                message = dict(self.fixtures[0], item_lookup=lookup)
                order = self.prepare([message])['orders'][0]; self.assertIsNone(order['cover'])
    def test_multiple_listings_or_conflicting_labels_are_held(self):
        for suffix in ['\nItem number: 123456789099', '\nTitle: Other synthetic title',
                       '\nQuantity: 9', '\nItem number: unknown', '\nItem number: 123456789011abc']:
            with self.subTest(suffix=suffix):
                result = self.prepare([dict(self.fixtures[0], text_body=self.fixtures[0]['text_body'] + suffix)])
                self.assertEqual(result['orders'], []); self.assertEqual(len(result['review_needed']), 1)
    def test_conflicting_host_fields_cannot_override_explicit_body_identity(self):
        for changes in [dict(title='Other title'), dict(legacy_item_id='123456789099'),
                        dict(item_id='v1|123456789099|0'), dict(quantity=8)]:
            result = self.prepare([dict(self.fixtures[0], **changes)])
            self.assertEqual(result['orders'], []); self.assertEqual(len(result['review_needed']), 1)
    def test_direct_markdown_item_link_extracts_only_allowlisted_native_listing(self):
        message = dict(self.fixtures[0], text_body='Order: 00-00000-00001\n[SYNTHETIC Saga #1](https://www.ebay.com/itm/Saga-1/123456789011?mkcid=synthetic)')
        order = self.prepare([message])['orders'][0]
        self.assertEqual(order['title'], 'SYNTHETIC Saga #1'); self.assertEqual(order['legacy_item_id'], '123456789011')
        for url in ['https://www.ebay.com.attacker.example/itm/123456789011', 'https://www.ebay.com/lbr/go?item=123456789011', 'https://www.ebay.com/mesh/ord/details?orderid=00-00000-00001']:
            message['text_body'] = 'Order: 00-00000-00001\n[SYNTHETIC Saga #1](' + url + ')'
            order = self.prepare([message])['orders'][0]; self.assertIsNone(order.get('legacy_item_id'))
            self.assertIsNone(order['cover'])
    def test_missing_and_truncated_titles_remain_unknown_but_item_number_survives(self):
        for body in ['Order: 00-00000-00001\nItem number: 123456789011',
                     'Order: 00-00000-00001\nTitle: SYNTHETIC Saga...\nItem number: 123456789011']:
            order = self.prepare([dict(self.fixtures[0], text_body=body)])['orders'][0]
            self.assertIsNone(order['title']); self.assertEqual(order['legacy_item_id'], '123456789011')
    def test_duplicate_prepared_and_enriched_notices_render_byte_identically(self):
        enriched = [dict(message, item_lookup=self.lookup(str(123456789011+i))) for i, message in enumerate(self.fixtures)]
        first = self.prepare(enriched); repeated = self.prepare(enriched + copy.deepcopy(enriched))
        self.assertEqual(first, repeated); self.assertEqual(renderer.render(first), renderer.render(repeated))
        self.assertEqual(len(first['orders']), 3)
    def test_html_body_as_native_only_body_and_split_cells_are_supported(self):
        message = dict(self.fixtures[2]); message.pop('text_body')
        order = self.prepare([message])['orders'][0]
        self.assertEqual(order['title'], 'SYNTHETIC Spawn #1 & Variant Cover')
        self.assertEqual(order['legacy_item_id'], '123456789013')
    def test_hidden_script_never_supplies_listing_identity_or_title(self):
        message = dict(self.fixtures[0], text_body='Order: 00-00000-00001',
                       html_body='<p>Order: 00-00000-00001</p><script>Item number: 123456789011</script>')
        order = self.prepare([message])['orders'][0]
        self.assertIsNone(order.get('legacy_item_id')); self.assertIsNone(order['title'])
    def test_duplicate_identity_checks_include_html_and_lookup_fields(self):
        for field, value in [('html_body','<p>Order: 00-00000-00002</p>'), ('item_lookup', self.lookup()), ('legacy_item_id','123456789099')]:
            a = self.fixtures[0]; b = dict(a, **{field:value})
            with self.assertRaises(ValueError): self.prepare([a,b])
    def test_html_conflicting_order_cannot_hide_behind_plain_text_alternative(self):
        result = self.prepare([dict(self.fixtures[0], html_body='<p>Order: 00-00000-00099</p>')])
        self.assertEqual(result['orders'], []); self.assertEqual(len(result['review_needed']), 1)
    def test_numeric_item_number_does_not_erase_explicit_variation_in_link(self):
        message = dict(self.fixtures[0], item_lookup=self.lookup(), text_body=self.fixtures[0]['text_body'] +
                       '\nhttps://www.ebay.com/itm/123456789011?var=123456789099')
        result = self.prepare([message])
        self.assertEqual(result['orders'], []); self.assertEqual(len(result['review_needed']),1)
    def test_malformed_optional_host_fact_is_held_without_breaking_other_notices(self):
        for changes in [dict(legacy_item_id=123456789011), dict(item_id=12), dict(html_body={})]:
            bad=dict(self.fixtures[0], gmail_message_id='bad-fixture', **changes)
            result=self.prepare([bad,self.fixtures[1]])
            self.assertEqual(len(result['orders']),1); self.assertEqual(len(result['review_needed']),1)
    def test_adjacent_order_quantity_and_price_values_are_not_item_titles(self):
        for preceding in ['Order number:\n00-00000-00001', 'Quantity sold:\n2', 'Item price:\n$5.00', 'View item']:
            body='Order: 00-00000-00001\n' + preceding + '\nItem number: 123456789011'
            order=self.prepare([dict(self.fixtures[0],text_body=body)])['orders'][0]
            self.assertIsNone(order['title'])
    def test_conflicting_truncated_title_does_not_disappear_behind_unrelated_full_title(self):
        message=dict(self.fixtures[0], text_body='Order: 00-00000-00001\nTitle: SYNTHETIC Batman...\nItem number: 123456789011',
                     html_body='<p>Order: 00-00000-00001</p><a href="https://www.ebay.com/itm/123456789011">SYNTHETIC Saga #1 Cover A</a>')
        result=self.prepare([message]); self.assertEqual(result['orders'],[])
    def test_matching_truncated_alternative_can_use_the_full_item_anchor_title(self):
        message=dict(self.fixtures[0], text_body='Order: 00-00000-00001\nTitle: SYNTHETIC Saga...\nItem number: 123456789011',
                     html_body='<p>Order: 00-00000-00001</p><a href="https://www.ebay.com/itm/123456789011">SYNTHETIC Saga #1 Cover A</a>')
        order=self.prepare([message])['orders'][0]; self.assertEqual(order['title'],'SYNTHETIC Saga #1 Cover A')
    def test_split_field_value_cannot_hide_another_listing_or_a_variation(self):
        for url in ['https://www.ebay.com/itm/123456789011?var=123456789099', 'https://www.ebay.com/itm/123456789099']:
            message=dict(self.fixtures[0], text_body='Order: 00-00000-00001\nTitle:\n'+url+'\nItem number: 123456789011',item_lookup=self.lookup())
            result=self.prepare([message]); self.assertEqual(result['orders'],[])
    def test_incompatible_truncated_only_candidates_are_held(self):
        message=dict(self.fixtures[0],text_body='Order: 00-00000-00001\nTitle: SYNTHETIC Saga...\nTitle: SYNTHETIC Batman...\nItem number: 123456789011')
        self.assertEqual(self.prepare([message])['orders'],[])
    def test_native_item_link_call_to_action_is_not_a_title(self):
        for title in ['View item on eBay','View purchased item','See your listing details','Click here']:
            message=dict(self.fixtures[0],text_body='Order: 00-00000-00001',
                         html_body='<a href="https://www.ebay.com/itm/123456789011">'+title+'</a>')
            order=self.prepare([message])['orders'][0]; self.assertIsNone(order['title'])
            self.assertEqual(order['legacy_item_id'],'123456789011')
    def test_adjacent_plain_title_must_agree_with_html_item_anchor(self):
        message=dict(self.fixtures[0],text_body='Order: 00-00000-00001\nSYNTHETIC Batman #25 Cover A\nItem number: 123456789011',
                     html_body='<p>Order: 00-00000-00001</p><a href="https://www.ebay.com/itm/123456789011">SYNTHETIC Saga #1 Cover A</a>')
        self.assertEqual(self.prepare([message])['orders'],[])
    def test_provider_rest_identity_can_bind_when_optional_legacy_field_is_null(self):
        message=dict(self.fixtures[0], item_lookup=dict(self.lookup(),legacy_item_id=None))
        order=self.prepare([message])['orders'][0]
        self.assertEqual(order['item_id'],'v1|123456789011|0'); self.assertIsNotNone(order['cover'])
    def test_markdown_anchor_above_numeric_item_label_does_not_conflict_with_itself(self):
        message=dict(self.fixtures[0],text_body='Order: 00-00000-00001\n[SYNTHETIC Saga #1](https://www.ebay.com/itm/123456789011)\nItem number: 123456789011')
        result=self.prepare([message]); self.assertEqual(result['review_needed'],[])
        self.assertEqual(result['orders'][0]['title'],'SYNTHETIC Saga #1')
    def test_adjacent_cta_uses_same_exclusions_as_item_anchor(self):
        for cta in ['See your listing details','Click here','View purchased item']:
            message=dict(self.fixtures[0],text_body='Order: 00-00000-00001\n'+cta+'\nItem number: 123456789011')
            order=self.prepare([message])['orders'][0]; self.assertIsNone(order['title'])

if __name__ == '__main__': unittest.main()
