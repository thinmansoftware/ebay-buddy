"""Synthetic full-size messages; no mailbox captures or provider requests."""
import json
import pathlib
import subprocess
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class CompleteHTMLBatchTests(unittest.TestCase):
    def notice(self, index):
        body = (
            '<html><body><p>Order: 00-00000-%05d</p>'
            '<p>Item title: SYNTHETIC Full HTML Book %d</p>'
            '<p>Item number: %d</p><p>Quantity sold: 1</p>'
            '<!--%s--></body></html>'
        ) % (index + 1, index, 123456789011 + index, 'x' * 69000)
        return dict(gmail_message_id='synthetic-message-%d' % index,
                    from_address='SYNTHETIC <sale@ebay.com>', kind='sale',
                    html_body=body, body_complete=True)

    def call(self, messages, command='prepare-brief'):
        payload = json.dumps(dict(mailbox_id='synthetic-mailbox', messages=messages))
        return subprocess.run(
            [sys.executable, str(ROOT / 'companion/mail_watch.py'), command],
            input=payload, capture_output=True, text=True, timeout=10)

    def test_full_html_duplicate_batch_is_accepted_and_deduped(self):
        messages = [self.notice(i) for i in range(3)]
        first = self.call(messages)
        repeated = self.call(messages + messages)
        self.assertEqual(first.returncode, 0)
        self.assertEqual(repeated.returncode, 0, repeated.stdout)
        self.assertEqual(first.stdout, repeated.stdout)
        result = json.loads(repeated.stdout)
        self.assertEqual(len(result['orders']), 3)
        self.assertEqual(result['review_needed'], [])

    def test_ten_ordinary_complete_html_notices_fit_the_on_demand_limit(self):
        result = self.call([self.notice(i) for i in range(10)])
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(len(json.loads(result.stdout)['orders']), 10)

    def test_on_demand_input_above_two_mib_is_rejected_without_echoing_input(self):
        result = self.call([dict(self.notice(0), html_body='PRIVATE-SYNTHETIC-' + 'x' * (2 * 1024 * 1024))])
        self.assertEqual(result.returncode, 2)
        self.assertNotIn('PRIVATE-SYNTHETIC', result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)['error'], 'mail_companion_rejected')

    def test_individual_body_limit_is_not_relaxed_by_the_batch_fix(self):
        result = self.call([dict(self.notice(0), html_body='x' * 100001)])
        self.assertEqual(result.returncode, 0)
        output = json.loads(result.stdout)
        self.assertEqual(output['orders'], [])
        self.assertEqual(len(output['review_needed']), 1)

    def test_automatic_prepare_retains_its_existing_256_kib_limit(self):
        result = self.call([self.notice(i) for i in range(6)], 'prepare')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)['error'], 'mail_companion_rejected')


if __name__ == '__main__':
    unittest.main()
