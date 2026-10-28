import copy, importlib.util, pathlib, tempfile, unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'companion' / (name + '.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module

class OnDemandBriefTests(unittest.TestCase):
    def setUp(self):
        self.mail = load('mail_watch'); self.renderer = load('render_brief')
        self.temp = tempfile.TemporaryDirectory(); self.state = pathlib.Path(self.temp.name) / 'must-not-exist.sqlite3'
    def tearDown(self): self.temp.cleanup()
    def notice(self, mid='fixture-message', kind='sale'):
        return dict(gmail_message_id=mid, from_address='eBay <sale@ebay.com>', kind=kind,
                    text_body='Order:\r\n\r\n00-00000-00001', body_complete=True,
                    title='SYNTHETIC: <script>bad()</script>', quantity=1)
    def brief(self, messages):
        return self.mail.run(self.state, 'prepare-brief', {'mailbox_id':'fixture-mailbox','messages':messages})
    def test_missing_time_is_explicitly_unknown_and_never_creates_storage(self):
        result = self.brief([self.notice()]); self.assertEqual(result['review_needed'], [])
        self.assertEqual(result['mode'], 'on_demand'); self.assertEqual(len(result['orders']), 1)
        self.assertIsNone(result['orders'][0]['received_at'])
        self.assertEqual(result['orders'][0]['received_at_source'], 'unavailable')
        self.assertFalse(self.state.exists()); self.assertEqual(result['notifications_sent'], 0)
        output = self.renderer.render(result)
        self.assertIn('Received time unavailable', output); self.assertNotIn('<time datetime=""', output)
        self.assertIn('&lt;script&gt;bad()&lt;/script&gt;', output)
        self.assertIn('On-demand', output); self.assertIn('Live eBay status not checked', output)
    def test_envelope_date_is_not_promoted_and_automatic_alerts_still_reject_it(self):
        message = self.notice(); message['date'] = '2026-10-25T12:00:00Z'
        result = self.brief([message]); self.assertIsNone(result['orders'][0]['received_at'])
        alert = self.mail.run(self.state, 'prepare', {'mailbox_id':'fixture-mailbox','messages':[message]})
        self.assertEqual(alert['messages'], []); self.assertIn('gmail_internal_received_time_unavailable', alert['review_needed'][0]['reasons'])
        for command in ['baseline', 'ingest']:
            with self.assertRaises(ValueError): self.mail.run(self.state, command, {'mailbox_id':'fixture-mailbox','messages':result['orders']})
        self.assertFalse(self.state.exists())
    def test_repeated_message_is_shown_once_but_conflicting_notices_remain_separate(self):
        a = self.notice(); b = self.notice('other-message', 'cancellation')
        result = self.brief([a, copy.deepcopy(a), b])
        self.assertEqual(len(result['orders']), 2)
        self.assertEqual([o['kind'] for o in result['orders']], ['sale', 'cancellation'])
        self.assertEqual(result['coverage'], 'requested_email_notices_not_current_order_status')
    def test_same_message_id_with_conflicting_facts_is_rejected(self):
        a = self.notice(); b = self.notice(); b['quantity'] = 2
        with self.assertRaises(ValueError): self.brief([a, b])
        self.assertFalse(self.state.exists())
    def test_truncated_ambiguous_and_foreign_sender_remain_held(self):
        for change in [{'body_complete':False}, {'text_body':'Order: unknown'}, {'from_address':'bad@example.com'}]:
            message = dict(self.notice(), **change); result = self.brief([message])
            self.assertEqual(result['orders'], []); self.assertEqual(len(result['review_needed']), 1)
            self.assertNotIn('text_body', str(result)); self.assertFalse(self.state.exists())
    def test_unknown_time_cannot_render_without_explicit_on_demand_mode(self):
        result = self.brief([self.notice()]); result.pop('mode')
        with self.assertRaises(ValueError): self.renderer.render(result)
    def test_unknown_time_mode_cannot_smuggle_a_claimed_timestamp(self):
        result = self.brief([self.notice()]); result['orders'][0]['received_at'] = '2026-10-25T12:00:00Z'
        with self.assertRaises(ValueError): self.renderer.render(result)
    def test_bounded_batch_and_real_internal_date_remain_supported(self):
        with self.assertRaises(ValueError): self.brief([self.notice(str(i)) for i in range(11)])
        message = self.notice(); message['internalDate'] = '1792843200000'
        order = self.brief([message])['orders'][0]
        self.assertEqual(order['received_at_source'], 'gmail_internalDate')
        self.assertEqual(order['received_at'], '2026-10-24T12:00:00+00:00')
    def test_artifact_keeps_held_count_and_incomplete_coverage_visible(self):
        bad = self.notice('held-message'); bad['body_complete'] = False
        for messages, count in [([self.notice(), bad], 1), ([bad], 1)]:
            result = self.brief(messages); output = self.renderer.render(result)
            self.assertIn('Incomplete coverage', output)
            self.assertIn(str(count) + ' notice(s) held for review', output)
    def test_conflicting_message_is_rejected_even_if_one_copy_is_invalid(self):
        a = self.notice(); b = self.notice(kind='refund'); b['quantity'] = 0
        for messages in [[a,b], [b,a]]:
            with self.assertRaises(ValueError): self.brief(messages)
        self.assertFalse(self.state.exists())
    def test_identical_held_message_is_counted_once(self):
        bad = self.notice(); bad['body_complete'] = False
        self.assertEqual(len(self.brief([bad, copy.deepcopy(bad)])['review_needed']), 1)

if __name__ == '__main__': unittest.main()
