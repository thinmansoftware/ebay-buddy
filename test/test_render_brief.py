import importlib.util,pathlib,unittest,subprocess,sys,json
path=pathlib.Path(__file__).resolve().parents[1]/'companion/render_brief.py'
class RenderTests(unittest.TestCase):
    def load(self):
        self.assertTrue(path.exists(),'visual renderer missing');s=importlib.util.spec_from_file_location('render_brief',path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
    def test_covers_escape_untrusted_titles_and_never_offer_shipping_actions(self):
        m=self.load();e={'source':'gmail_ebay_messages','orders':[{'order_id':'00-00000-00001','order_id_source':'email_labeled_order_number','received_at_source':'gmail_internalDate','gmail_message_id':'fixture','kind':'sale','received_at':'2026-10-24T12:00:00Z','title':'<script>bad</script>','quantity':2,'item_id':'v1|123456789012|0','cover':{'source':'get_ebay_item','item_id':'v1|123456789012|0','url':'https://i.ebayimg.com/images/g/fixture/s-l500.jpg'}}]};html=m.render(e)
        self.assertIn('https://i.ebayimg.com/images/g/fixture/s-l500.jpg',html);self.assertIn('&lt;script&gt;bad&lt;/script&gt;',html);self.assertNotIn('<script>bad</script>',html);self.assertIn('Email-derived',html);self.assertIn('Live eBay status not checked',html);self.assertNotIn('Buy postage',html)
    def test_foreign_cover_and_missing_units_stay_unknown(self):
        m=self.load();html=m.render({'source':'gmail_ebay_messages','orders':[{'order_id':'00-00000-00001','order_id_source':'email_labeled_order_number','received_at_source':'gmail_internalDate','kind':'sale','cover':{'url':'https://evil.example/pixel'},'quantity':None}]});self.assertNotIn('evil.example',html);self.assertIn('Cover unavailable',html);self.assertIn('Quantity not stated',html)
    def test_legacy_and_unknown_provenance_cannot_render_an_order_artifact(self):
        for source in [{},{'order_id_source':'tracking_link_t','received_at_source':'gmail_internalDate'},{'order_id_source':'email_labeled_order_number','received_at_source':'date'}]:
            with self.subTest(source=source),self.assertRaisesRegex(ValueError,'provenance'):
                self.load().render({'source':'gmail_ebay_messages','orders':[dict(kind='sale',order_id='00-00000-00001',**source)]})
    def test_cli_rejects_legacy_brief_without_emitting_order_data(self):
        result=subprocess.run([sys.executable,str(path)],input=json.dumps({'source':'gmail_ebay_messages','orders':[{'kind':'sale','order_id':'00-00000-00001'}]}),capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,2);self.assertEqual(result.stdout,'');self.assertNotIn('00-00000-00001',result.stderr)
if __name__=='__main__':unittest.main()
