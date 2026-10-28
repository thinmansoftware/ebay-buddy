"""Synthetic, script-independent view and initial-state regressions."""
import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class StaticBriefTests(unittest.TestCase):
    def render(self, orders=None, review=None):
        spec = importlib.util.spec_from_file_location('renderer', ROOT / 'companion/render_brief.py')
        renderer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(renderer)
        return renderer.render(dict(source='gmail_ebay_messages', mode='on_demand',
                                    orders=orders or [], review_needed=review or []))

    def order(self):
        return dict(order_id='00-00000-00001', order_id_source='email_labeled_order_number',
                    received_at_source='unavailable', received_at=None, kind='sale',
                    title='SYNTHETIC Book #1', quantity=1, item_id='v1|123456789011|0',
                    cover=dict(source='get_ebay_item', item_id='v1|123456789011|0',
                               url='https://i.ebayimg.com/images/g/fixture/s-l500.jpg'))

    def test_initial_empty_brief_explains_no_input_without_a_click(self):
        doc = self.render()
        self.assertIn('No eBay notices were supplied.', doc)
        self.assertNotIn('<p id="empty" hidden', doc)

    def test_all_held_brief_distinguishes_incomplete_coverage_from_no_mail(self):
        doc = self.render(review=[dict(gmail_message_id='synthetic', reason='incomplete_body')])
        self.assertIn('No notices can be shown; 1 notice(s) need review.', doc)
        self.assertIn('Incomplete coverage', doc)

    def test_filters_and_empty_messages_do_not_require_scripts(self):
        doc = self.render([self.order()])
        self.assertNotIn('<script', doc)
        self.assertIn("script-src 'none'", doc)
        self.assertIn('type="radio"', doc)
        self.assertIn('id="filter-refund"', doc)
        self.assertIn('No refund notices in this brief.', doc)
        self.assertIn(':has(#filter-refund:checked)', doc)

    def test_failed_photo_has_visible_explanation_without_event_handlers(self):
        doc = self.render([self.order()])
        self.assertIn('Cover unavailable if the image does not load.', doc)
        self.assertNotIn('addEventListener', doc)
        self.assertIn('referrerpolicy="no-referrer"', doc)

    def test_known_received_timestamp_has_explicit_timezone_without_client_scripts(self):
        order = self.order()
        order.update(received_at_source='gmail_internalDate', received_at='2026-10-24T12:00:00Z')
        doc = self.render([order])
        self.assertIn('Oct 24, 2026 12:00 UTC', doc)
        self.assertNotIn('Intl.DateTimeFormat', doc)


if __name__ == '__main__':
    unittest.main()
