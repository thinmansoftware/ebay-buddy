"""Synthetic same-order identity evidence. No real seller or mailbox records."""
import copy
import importlib.util
import pathlib
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'companion' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class OrderIdentityTests(unittest.TestCase):
    def setUp(self):
        self.mail = load('mail_watch')
        self.renderer = load('render_brief')
        self.temp = tempfile.TemporaryDirectory()
        self.state = pathlib.Path(self.temp.name) / 'not-created.sqlite3'

    def tearDown(self):
        self.temp.cleanup()

    def notice(self, index=0):
        order = '00-00000-%05d' % (index + 1)
        legacy = str(123456789011 + index)
        return dict(
            gmail_message_id='synthetic-message-%d' % index,
            from_address='SYNTHETIC <sale@ebay.com>', kind='sale', body_complete=True,
            html_body='<html><body><p>Order: ' + order + '</p><p>Quantity sold: 1</p>'
                      '<img alt="SYNTHETIC Book..." src="https://svcs.ebay.com/imageser?imageId=SYNTHETIC">'
                      '</body></html>',
            order_identity=dict(source='ebay_seller_hub', order_id=order, complete=True,
                                items=[dict(title='SYNTHETIC Book %d Cover A' % index,
                                            legacy_item_id=legacy,
                                            item_url='https://www.ebay.com/itm/' + legacy,
                                            quantity=1)]))

    def prepare(self, messages, on_demand=True):
        result = self.mail.prepare(dict(mailbox_id='synthetic-mailbox', messages=messages),
                                   on_demand=on_demand)
        self.assertFalse(self.state.exists())
        return result

    def test_same_order_single_item_details_supply_identity_with_explicit_source(self):
        result = self.prepare([self.notice(i) for i in range(3)])
        self.assertEqual(result['review_needed'], [])
        self.assertEqual([o['title'] for o in result['orders']],
                         ['SYNTHETIC Book %d Cover A' % i for i in range(3)])
        self.assertEqual([o['legacy_item_id'] for o in result['orders']],
                         ['123456789011', '123456789012', '123456789013'])
        for order in result['orders']:
            self.assertEqual(order['item_identity_source'], 'ebay_seller_hub')
            self.assertEqual(order['status_basis'], 'email_only')
            self.assertEqual(order['live_ebay_status'], 'not_checked')
            self.assertIsNone(order['cover'])
            self.assertNotIn('order_identity', order)
            self.assertNotIn('item_url', order)

    def test_exact_browse_lookup_binds_cover_and_renderer_labels_both_sources(self):
        notice = self.notice()
        notice['item_lookup'] = dict(source='get_ebay_item', item_id='v1|123456789011|0',
                                     legacy_item_id='123456789011',
                                     images=['https://i.ebayimg.com/images/g/synthetic/s-l1600.jpg'])
        result = self.prepare([notice])
        self.assertEqual(result['review_needed'], [])
        self.assertIsNotNone(result['orders'][0]['cover'])
        document = self.renderer.render(result)
        self.assertIn('SYNTHETIC Book 0 Cover A', document)
        self.assertIn('Item identity: Seller Hub order details', document)
        self.assertIn('Live eBay status not checked', document)
        self.assertIn('Listing number 123456789011', document)
        self.assertIn('Marketplace quantity is not proof', document)
        self.assertEqual(document.count('<img src='), 1)

    def test_invalid_source_wrong_order_incomplete_or_multiple_rows_are_held(self):
        base = self.notice()['order_identity']
        alternatives = [dict(base, source='search_ebay'), dict(base, order_id='00-00000-00099'),
                        dict(base, complete=False), dict(base, complete=1),
                        dict(base, items=[]), dict(base, items=base['items'] * 2),
                        dict(base, buyer_address='PRIVATE-SYNTHETIC')]
        for identity in alternatives:
            with self.subTest(identity=identity):
                notice = self.notice()
                notice['order_identity'] = copy.deepcopy(identity)
                result = self.prepare([notice])
                self.assertEqual(result['orders'], [])
                self.assertEqual(len(result['review_needed']), 1)
                self.assertNotIn('PRIVATE-SYNTHETIC', str(result))

    def test_item_link_quantity_and_full_title_must_agree_with_notice(self):
        for change in [dict(item_url='https://www.ebay.com/itm/123456789099'),
                       dict(item_url='https://www.ebay.com.attacker.example/itm/123456789011'),
                       dict(item_url='https://www.ebay.com/itm/123456789011?var=9'),
                       dict(quantity=2), dict(quantity=True), dict(legacy_item_id=123456789011),
                       dict(title='SYNTHETIC Book...'), dict(title='x' * 301),
                       dict(price='PRIVATE-SYNTHETIC')]:
            with self.subTest(change=change):
                notice = self.notice()
                notice['order_identity']['items'][0].update(change)
                self.assertEqual(self.prepare([notice])['orders'], [])
        for suffix in ['<p>Title: A conflicting full title</p>',
                       '<p>Title: A conflicting title...</p>',
                       '<p>Item number: 123456789099</p>']:
            notice = self.notice()
            notice['html_body'] += suffix
            self.assertEqual(self.prepare([notice])['orders'], [])

    def test_compatible_truncated_email_title_can_use_same_order_full_title(self):
        notice = self.notice()
        notice['html_body'] += '<p>Title: SYNTHETIC Book...</p>'
        self.assertEqual(self.prepare([notice])['orders'][0]['title'], 'SYNTHETIC Book 0 Cover A')

    def test_order_identity_cannot_enter_alert_preparation_or_other_notice_kinds(self):
        notice = self.notice()
        notice['internalDate'] = '1792843200000'
        self.assertEqual(self.prepare([notice], on_demand=False)['messages'], [])
        for kind in ['cancellation', 'refund']:
            self.assertEqual(self.prepare([dict(notice, kind=kind)])['orders'], [])

    def test_duplicate_comparison_includes_identity_source_and_matching_batches_stay_identical(self):
        notice = self.notice()
        self.assertEqual(self.prepare([notice]), self.prepare([notice, copy.deepcopy(notice)]))
        changed = copy.deepcopy(notice)
        changed['order_identity']['items'][0]['item_url'] += '?var=9'
        with self.assertRaises(ValueError):
            self.prepare([notice, changed])

    def test_absent_enrichment_retains_unknowns_and_has_no_new_source_claim(self):
        notice = self.notice()
        notice.pop('order_identity')
        order = self.prepare([notice])['orders'][0]
        self.assertIsNone(order['title'])
        self.assertIsNone(order.get('legacy_item_id'))
        self.assertNotIn('item_identity_source', order)

    def test_normalized_enrichment_cannot_enter_automatic_ledger_even_with_real_time(self):
        notice = self.notice()
        notice['internalDate'] = '1792843200000'
        order = self.prepare([notice])['orders'][0]
        for message in [order, dict(order, order_identity=notice['order_identity'])]:
            with self.assertRaises(ValueError):
                self.mail.run(self.state, 'baseline', dict(mailbox_id='synthetic-mailbox', messages=[message]))
            self.assertFalse(self.state.exists())

    def test_explicit_null_identity_is_not_silently_deduped_with_absent_identity(self):
        notice = self.notice()
        notice.pop('order_identity')
        with self.assertRaises(ValueError):
            self.prepare([notice, dict(notice, order_identity=None)])

    def test_untrusted_hub_title_is_escaped_and_source_cannot_inject_markup(self):
        notice = self.notice()
        notice['order_identity']['items'][0]['title'] = 'SYNTHETIC <img src=x onerror=bad()>'
        result = self.prepare([notice])
        document = self.renderer.render(result)
        self.assertIn('&lt;img src=x onerror=bad()&gt;', document)
        self.assertNotIn('<img src=x', document)
        result['orders'][0]['item_identity_source'] = '<script>bad()</script>'
        with self.assertRaises(ValueError):
            self.renderer.render(result)

    def test_normalized_source_claim_requires_complete_bounded_identity(self):
        order = self.prepare([self.notice()])['orders'][0]
        for change in [dict(title=None), dict(legacy_item_id=None), dict(quantity=None)]:
            with self.assertRaises(ValueError):
                self.mail.normalize(dict(order, **change), on_demand=True)

    def test_sanitized_html_only_template_never_mines_tracking_or_render_image_for_identity(self):
        notice = self.notice()
        notice['html_body'] = (ROOT / 'test/fixtures/synthetic_html_only_sale.html').read_text(encoding='utf-8')
        notice.pop('order_identity')
        order = self.prepare([notice])['orders'][0]
        self.assertEqual(order['order_id'], '00-00000-00000')
        self.assertEqual(order['quantity'], 1)
        self.assertIsNone(order['title'])
        self.assertIsNone(order.get('legacy_item_id'))
        self.assertIsNone(order['cover'])
        notice['order_identity'] = dict(source='ebay_seller_hub', order_id=order['order_id'], complete=True,
            items=[dict(title='FAKE COMIC TITLE #0 Cover Z FAKE PRESALE 01/01/2000',
                        legacy_item_id='123456789011', item_url='https://www.ebay.com/itm/123456789011', quantity=1)])
        enriched = self.prepare([notice])['orders'][0]
        self.assertEqual(enriched['item_identity_source'], 'ebay_seller_hub')
        self.assertEqual(enriched['legacy_item_id'], '123456789011')
        self.assertIsNone(enriched['cover'])
        self.assertNotIn('price', enriched)


if __name__ == '__main__':
    unittest.main()
