import importlib.util,pathlib,tempfile,unittest,json

path=pathlib.Path(__file__).resolve().parents[1]/'companion/mail_watch.py'
class PrepareMailTests(unittest.TestCase):
    def setUp(self):
        spec=importlib.util.spec_from_file_location('mail_watch',path)
        self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
        self.temp=tempfile.TemporaryDirectory();self.state=pathlib.Path(self.temp.name)/'unused.sqlite3'
    def tearDown(self):self.temp.cleanup()
    def notice(self,**extra):
        return dict(gmail_message_id='synthetic-message',from_address='eBay <sale@ebay.com>',kind='sale',
                    text_body='You sold a book\nOrder: 00-00000-00001\nQuantity sold: 2',
                    body_complete=True,internalDate='1792843200000',title='SYNTHETIC fixture',quantity=2,**extra)
    def prepare(self,messages):return self.m.run(self.state,'prepare',{'mailbox_id':'synthetic-account','messages':messages})
    def test_full_labeled_order_and_internal_date_are_normalized_without_storing_body(self):
        result=self.prepare([self.notice()]);self.assertEqual(result['review_needed'],[])
        message=result['messages'][0]
        self.assertEqual(message['order_id'],'00-00000-00001')
        self.assertEqual(message['received_at'],'2026-10-24T12:00:00+00:00')
        self.assertEqual(message['order_id_source'],'email_labeled_order_number')
        self.assertEqual(message['received_at_source'],'gmail_internalDate')
        self.assertNotIn('text_body',message);self.assertFalse(self.state.exists())
    def test_generic_date_never_substitutes_for_missing_internal_date(self):
        message=self.notice();message.pop('internalDate');message['date']='2026-10-24T12:00:00Z'
        result=self.prepare([message]);self.assertEqual(result['messages'],[])
        self.assertIn('gmail_internal_received_time_unavailable',result['review_needed'][0]['reasons'])
        self.assertFalse(self.state.exists())
    def test_tracking_link_and_orderid_link_alone_are_not_labeled_order_evidence(self):
        message=self.notice();message['text_body']='https://www.ebay.com/lbr/go?t=00-00000-00001\nhttps://www.ebay.com/mesh/ord/details?orderid=00-00000-00001'
        result=self.prepare([message]);self.assertEqual(result['messages'],[])
        self.assertIn('labeled_order_number_missing_or_ambiguous',result['review_needed'][0]['reasons'])
    def test_truncated_body_is_held_even_if_one_order_label_is_visible(self):
        message=self.notice();message['body_complete']=False
        result=self.prepare([message]);self.assertEqual(result['messages'],[])
        self.assertIn('complete_email_body_required',result['review_needed'][0]['reasons'])
    def test_conflicting_order_labels_are_held_but_repeated_identical_labels_are_safe(self):
        message=self.notice();message['text_body']+='\nOrder number: 00-00000-00002'
        self.assertEqual(self.prepare([message])['messages'],[])
        message['text_body']='Order: 00-00000-00001\nOrder number: 00-00000-00001'
        self.assertEqual(len(self.prepare([message])['messages']),1)
    def test_foreign_sender_and_invalid_internal_dates_are_held_without_raw_data(self):
        for field,value in [('from_address','bad@ebay.com.attacker.example'),('internalDate','nan'),('internalDate',True),('internalDate','999999999999999999999')]:
            message=self.notice();message[field]=value
            with self.subTest(field=field,value=value):
                result=self.prepare([message]);self.assertEqual(result['messages'],[])
                serialized=json.dumps(result);self.assertNotIn('You sold a book',serialized);self.assertNotIn('bad@',serialized)
    def test_prepared_mail_baselines_and_repeats_quietly_in_an_isolated_ledger(self):
        message=self.prepare([self.notice()])['messages'][0]
        payload={'mailbox_id':'synthetic-account','baseline_before':'2026-10-24T13:00:00Z','messages':[message]}
        self.m.run(self.state,'baseline',payload);self.m.run(self.state,'ingest',payload)
        self.assertEqual(self.m.run(self.state,'claim',{'mailbox_id':'synthetic-account'})['events'],[])
    def test_malformed_whole_order_fields_are_never_accepted_by_prefix(self):
        for body in ['Order: 00-00000-00001abc','Order: 00-00000-00001/extra','Order: ٠٠-٠٠٠٠٠-٠٠٠٠١','Order: 00-00000-00001\nOrder ID: unknown','Order: 00-00000-00001\nOrder: 00-00000-00002/extra']:
            message=self.notice();message['text_body']=body
            with self.subTest(body=body):self.assertEqual(self.prepare([message])['messages'],[])
    def test_full_crlf_label_with_horizontal_whitespace_is_supported(self):
        message=self.notice();message['text_body']='Sold\r\n\tOrder number: 00-00000-00001 \t\r\nQuantity sold: 2\r\n'
        self.assertEqual(self.prepare([message])['messages'][0]['order_id'],'00-00000-00001')
    def test_order_value_on_first_nonblank_line_after_label_is_supported(self):
        message=self.notice();message['text_body']='Sold\r\n\tOrder:\r\n\r\n \t\r\n00-00000-00001\r\n\r\nQuantity sold:\r\n2\r\n'
        result=self.prepare([message]);self.assertEqual(len(result['messages']),1)
        self.assertEqual(result['messages'][0]['order_id'],'00-00000-00001')
    def test_split_label_never_skips_nonblank_text_to_find_an_order_shaped_value(self):
        message=self.notice();message['text_body']='Order:\r\n\r\nNot stated\r\n00-00000-00001\r\n'
        self.assertEqual(self.prepare([message])['messages'],[])
    def test_unresolved_split_label_or_next_label_cannot_hide_ambiguity(self):
        for body in ['Order: 00-00000-00001\nOrder number:\n\n','Order:\nOrder ID: 00-00000-00001']:
            message=self.notice();message['text_body']=body
            with self.subTest(body=body):self.assertEqual(self.prepare([message])['messages'],[])
if __name__=='__main__':unittest.main()
