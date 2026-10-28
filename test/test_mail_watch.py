import importlib.util,pathlib,tempfile,unittest,concurrent.futures,subprocess,sys,json,sqlite3,contextlib
path=pathlib.Path(__file__).resolve().parents[1]/'companion/mail_watch.py'
def load():
    if not path.exists():return None
    spec=importlib.util.spec_from_file_location('mail_watch',path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
class MailWatchTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.state=pathlib.Path(self.temp.name)/'state.sqlite3';self.m=load()
    def tearDown(self):self.temp.cleanup()
    def message(self,mid='message-a',order='00-00000-00001',kind='sale'):
        return dict(gmail_message_id=mid,from_address='eBay <sale@ebay.com>',order_id=order,order_id_source='email_labeled_order_number',kind=kind,received_at='2026-10-24T12:00:00Z',received_at_source='gmail_internalDate',title='SYNTHETIC FIXTURE Comic25',quantity=2)
    def run_cmd(self,cmd,messages=None,account='account-fixture',**extra):
        self.assertIsNotNone(self.m,'mail companion missing')
        if cmd=='baseline':extra.setdefault('baseline_before','2026-10-24T00:00:00Z')
        return self.m.run(self.state,cmd,dict(mailbox_id=account,messages=messages or [],**extra))
    def test_baseline_does_not_alert_and_requires_explicit_initialization(self):
        with self.assertRaisesRegex(ValueError,'baseline'):self.run_cmd('ingest',[self.message()])
        self.run_cmd('baseline',[self.message()]);self.assertEqual(self.run_cmd('claim')['events'],[])
        self.run_cmd('ingest',[self.message('reminder')]);self.assertEqual(self.run_cmd('claim')['events'],[])
    def test_new_order_repeated_mail_and_restart_are_deduplicated(self):
        self.run_cmd('baseline');self.run_cmd('ingest',[self.message(),self.message('reminder')]);self.m=load();claims=self.run_cmd('claim')['events'];self.assertEqual(len(claims),1);self.assertEqual(claims[0]['quantity'],2);self.assertEqual(self.run_cmd('claim')['events'],[])
        self.run_cmd('finish',delivery_id=claims[0]['delivery_id'],outcome='delivered');self.run_cmd('ingest',[self.message('third')]);self.assertEqual(self.run_cmd('claim')['events'],[])
    def test_accounts_and_material_event_kinds_do_not_mix(self):
        for account in ['a','b']:self.run_cmd('baseline',account=account)
        self.run_cmd('ingest',[self.message()],account='a');self.assertEqual(self.run_cmd('claim',account='b')['events'],[])
        self.run_cmd('ingest',[self.message('cancel',kind='cancellation')],account='a');self.assertEqual(len(self.run_cmd('claim',account='a')['events']),2)
    def test_uncertain_delivery_never_blindly_resends(self):
        self.run_cmd('baseline');self.run_cmd('ingest',[self.message()]);event=self.run_cmd('claim')['events'][0];self.run_cmd('finish',delivery_id=event['delivery_id'],outcome='uncertain');self.assertEqual(self.run_cmd('claim')['events'],[])
    def test_foreign_sender_malformed_order_and_same_message_changed_identity_rejected(self):
        self.run_cmd('baseline');bad=self.message();bad['from_address']='bad@ebay.com.attacker.example'
        with self.assertRaisesRegex(ValueError,'sender'):self.run_cmd('ingest',[bad])
        with self.assertRaisesRegex(ValueError,'order'):self.run_cmd('ingest',[self.message(order='not-an-order')])
        self.run_cmd('ingest',[self.message()])
        with self.assertRaisesRegex(ValueError,'identity'):self.run_cmd('ingest',[self.message(order='00-00000-00002')])
    def test_unknown_units_and_untrusted_cover_never_become_physical_readiness(self):
        self.run_cmd('baseline');m=self.message();m.pop('quantity');m['cover']={'url':'https://evil.example/tracker','item_id':'v1|123456789012|0','source':'get_ebay_item'};self.run_cmd('ingest',[m]);e=self.run_cmd('claim')['events'][0];self.assertIsNone(e['quantity']);self.assertIsNone(e['cover']);self.assertEqual(e['physical_readiness'],'not_checked');self.assertEqual(e['status_basis'],'email_only')
    def test_unidentified_cancellation_never_inherits_sale_item_facts(self):
        self.run_cmd('baseline');sale=self.message();sale['item_id']='v1|123456789012|0';sale['cover']={'url':'https://i.ebayimg.com/images/g/fixture/s-l500.jpg','item_id':sale['item_id'],'source':'get_ebay_item'}
        self.run_cmd('ingest',[sale]);cancel=self.message('cancel',kind='cancellation');cancel.update(received_at='2026-10-24T13:00:00Z',title=None,quantity=None)
        self.run_cmd('ingest',[cancel]);notice=self.run_cmd('brief')['orders'][0]
        self.assertEqual(notice['kind'],'cancellation')
        for key in ['item_id','title','quantity','cover']:self.assertIsNone(notice[key],key)
    def test_concurrent_claims_get_one_durable_event(self):
        self.run_cmd('baseline');self.run_cmd('ingest',[self.message()])
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:self.run_cmd('claim'),range(2)))
        self.assertEqual(sum(len(r['events']) for r in results),1)
    def test_separate_process_claim_and_uncertain_crash_state(self):
        self.run_cmd('baseline');self.run_cmd('ingest',[self.message()])
        def claim(_):
            p=subprocess.run([sys.executable,str(path),'claim','--state',str(self.state)],input=json.dumps({'mailbox_id':'account-fixture'}),text=True,capture_output=True,timeout=10);self.assertEqual(p.returncode,0);return json.loads(p.stdout)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(claim,range(2)))
        self.assertEqual(sum(len(r['events']) for r in results),1)
        self.assertEqual(self.run_cmd('claim')['events'],[]) # A dead worker's unacknowledged claim is never blindly replayed.
    def test_brief_never_borrows_a_different_items_cover(self):
        self.run_cmd('baseline');a=self.message();a['item_id']='v1|123456789012|0';a['cover']={'url':'https://i.ebayimg.com/images/g/fixture/s-l500.jpg','item_id':a['item_id'],'source':'get_ebay_item'};self.run_cmd('ingest',[a]);b=self.message('cancel',kind='cancellation');b['item_id']='v1|987654321012|0';b['received_at']='2026-10-24T13:00:00Z';b.pop('quantity');b.pop('title');self.run_cmd('ingest',[b]);brief=self.run_cmd('brief');self.assertIsNone(brief['orders'][0]['cover']);self.assertEqual(brief['orders'][0]['item_id'],b['item_id'])
    def test_old_email_outside_baseline_page_does_not_become_new_sale(self):
        self.run_cmd('baseline',baseline_before='2026-10-24T13:00:00Z');self.run_cmd('ingest',[self.message('old-not-in-first-page')]);self.assertEqual(self.run_cmd('claim')['events'],[])
    def test_inferred_order_identity_never_becomes_a_pending_event(self):
        self.run_cmd('baseline')
        for source in [None,'tracking_link_t','guessed','email_subject']:
            bad=self.message();bad['order_id_source']=source
            with self.subTest(source=source),self.assertRaisesRegex(ValueError,'order identity provenance'):
                self.run_cmd('ingest',[bad])
        self.assertEqual(self.run_cmd('claim')['events'],[])
    def test_unknown_or_header_timestamp_cannot_drive_alert_cutoff(self):
        self.run_cmd('baseline')
        for source in [None,'date','rfc_date_header','host_first_seen']:
            bad=self.message();bad['received_at_source']=source
            with self.subTest(source=source),self.assertRaisesRegex(ValueError,'received time provenance'):
                self.run_cmd('ingest',[bad])
        self.assertEqual(self.run_cmd('claim')['events'],[])
    def test_verified_provenance_survives_restart_and_order_deduplication(self):
        self.run_cmd('baseline');self.run_cmd('ingest',[self.message(),self.message('repeat')]);self.m=load()
        events=self.run_cmd('claim')['events'];self.assertEqual(len(events),1)
        self.assertEqual(events[0].get('order_id_source'),'email_labeled_order_number')
        self.assertEqual(events[0].get('received_at_source'),'gmail_internalDate')
    def test_legacy_unverified_records_cannot_be_claimed_or_rendered(self):
        self.run_cmd('baseline');self.run_cmd('ingest',[self.message()])
        with contextlib.closing(sqlite3.connect(self.state)) as db,db:
            row=db.execute('SELECT mailbox,id,body FROM events').fetchone();body=json.loads(row[2])
            body.pop('order_id_source',None);body.pop('received_at_source',None)
            db.execute('UPDATE events SET body=? WHERE mailbox=? AND id=?',(json.dumps(body),row[0],row[1]))
        for command in ['claim','brief','ingest']:
            with self.subTest(command=command),self.assertRaisesRegex(ValueError,'provenance'):
                self.run_cmd(command)
        with contextlib.closing(sqlite3.connect(self.state)) as db:
            self.assertEqual(db.execute('SELECT state FROM events').fetchone()[0],'pending')
if __name__=='__main__':unittest.main()
