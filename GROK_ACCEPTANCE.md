# Grok rc.10 acceptance - clean-folder host test

Correlation: xo-ebaybuddy-rc7-accept-20261026

Use only the exact reviewed rc.10 ZIP and SHA256 supplied in its receipt. Preserve
all existing connectors, earlier diagnostic folders and private captured sources.
This retest needs no new mail/order reads or provider consent. No Azure changes.

1. Verify the archive hash, inspect its manifest and extract to a NEW private
   folder on Grok's own cloud computer. Record the absolute path and Python
   version. Do not assume the conversation working directory is the package root.
2. Read GROK_SETUP.md, GMAIL_WORKFLOW.md and the bundled skill. Run Python 3.10+
   unittest discovery over test_*.py (local rc.10 baseline: 98 tests). From a
   DIFFERENT temporary directory invoke the absolute companion/cli.py check path;
   verify it locates this exact rc.10 root. Do not install packages or change the
   existing working hosted MCP connection for this companion retest.
3. Using only bundled SYNTHETIC fixtures, prepare a requested brief through
   absolute cli.py prepare-brief and render via absolute cli.py render-brief,
   supplying JSON on stdin. Test initial empty/all-held states, sale/cancellation/
   refund filters, keyboard selection and missing-photo explanation. A source
   contains no scripts; filters must still work. Unknown timestamps stay unknown.
4. Render identical captured synthetic input twice, including duplicate native
   message IDs. Require unique cards and byte-identical HTML. Hold conflicting,
   truncated or ambiguous identities. Do not invent internalDate or manufacture
   REST IDs/cover URLs. Exact-item images require a successful exact lookup with
   matching identity. Never substitute a title-search photo.
5. Open the private HTML using the actual host artifact flow. Record whether the
   viewer permits native CSS radio filters; if the host strips styles, controls
   or images, report the host limitation. View filtering is not data redaction.
6. Reuse the already approved Browse connection for get_connection_status,
   search_ebay with a small limit and one exact returned get_ebay_item. Label this
   as that existing backend's version, not rc.10 deployment. Asks/current bids
   are not sale prices; unknown shipping is not free. Record provider ranking
   separately from optional local returned-page prefix preference.
7. Inspect native Gmail tool SCHEMAS ONLY for genuine internalDate or equivalent
   provider receipt-time evidence. Do not search or read mail. If absent, retain
   Received time unavailable and exclude automatic alerts. Also report supported
   remote OAuth/public-client setup fields from the host's own schema, without
   adding/updating a connector or printing credentials.

Optional captured-real-source visual regression is separate: only reuse the
previously authorized three private notice/Seller Hub/Browse captures; perform no
new reads. Keep all real order numbers, buyer details and mail bodies off public
source, receipts and artifacts. Report email facts and Seller Hub facts separately.

Return one sanitized JSON receipt with artifact hash/version, Python runtime,
actual test count, clean-root check, synthetic duplicate/render/filter outcomes,
artifact opened, existing tool names/backend version and scoped live read results,
metadata-schema outcome, and any concrete failures. Never mark a missing result
PASS. Do not alter mail, routines, ledgers, credentials, grants or business state;
do not publish, submit or change Azure. No live rc.10 OAuth proof is claimed by
these mocked local tests or by using the earlier backend.
