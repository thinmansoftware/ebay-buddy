# One eBay Buddy backend, Grok / Dot / Muse clients

Run one authorized HTTPS MCP backend instance. Connect each bot to that same
instance using its supported remote MCP setup and masked credential facility.
Keep each client's configuration separate; do not put credentials in chat, URLs,
command arguments or source. No client-specific eBay server is required.

Grok's historical hosted connection is proven; this release's actual Grok, Dot and
Muse acceptance must be recorded separately. Do not guess their setup schemas or
assume they can run commands or access files on the operator's PC. Where a host
supports stdio, it must run on the machine holding that installed package. Use
README's stdio/HTTP entrypoints and GROK_SETUP's supported masked setup flow.

## Operator update and three-client acceptance

1. Review the exact new source, package/hash and configuration delta. Stop or drain
   the old host connection before a controlled update; do not roll out an unreviewed
   package. Preserve the previous immutable package/image for rollback.
2. Update the shared backend once under the applicable deployment authorization,
   keeping the remote URL and supported tool contracts stable. Self-hosted operators
   update their own instance of the same code. No update is applied by this guide.
3. Reconnect/refresh Grok, Dot and Muse as each host requires. Automatic tool-list
   refresh and dynamic change notifications are not assumed or enabled by this
   version. Existing sessions must be refreshed after server replacement.
4. In EACH actual bot, discover exactly `get_connection_status`, `search_ebay` and
   `get_ebay_item`. Status must report the reviewed `connector_version` and
   `provider_access: not_checked`; status alone does not prove eBay access.
5. Search for a supplied term. Inspect an exact ID from that search. Check the
   returned ID/title, asking-price/current-bid basis and explicit shipping evidence.
   Repeat the same sequence in all three bots, then run concurrent searches.
6. Record the bot/app version, backend version, time, discovery and actual results.
   A passing SDK fixture cannot fill an actual bot's acceptance row. On failure,
   retain the error without secrets and restore the prior reviewed backend version
   if an authorized rollout occurred. No rollback or deployment occurred here.

The updated candidate keeps three Browse tools; Gmail, seller orders, purchases,
listing writes and printing are not exposed. No new Google or eBay seller consent
is needed for this Browse increment. Existing operator app credentials and ordinary
provider access are still required. New capability scopes require separate review.

## Base search + Gmail companion

Use the bundled [eBay mail-watch skill](skills/ebay-mail-watch/SKILL.md) with the
assistant's existing native Gmail connection. The Browse MCP tool list stays at
three. The companion is a host-local workflow, not a new Gmail tool on that server.

Follow [GMAIL_WORKFLOW.md](GMAIL_WORKFLOW.md) and [GROK_ACCEPTANCE.md](GROK_ACCEPTANCE.md).
The following ledger guidance applies only to excluded experimental alert commands, not the advertised requested brief. The local SQLite ledger suppresses repeated message/order-event notices and
coordinates workers using the SAME file. Independent host files do not coordinate
with one another. Choose one notifying bot per mailbox. Initial history is quiet;
uncertain delivery is held for reconciliation rather than blindly sent again.

The requested stateless brief needs no ledger or routine. Optional same-order
Seller Hub identity runs in the assistant's authorized browser, with its source
visible; it adds no backend tool or seller API grant. See GMAIL_WORKFLOW.md.
The private Auth0 pilot's automatic renewal is proven in Grok; it is separate
from a fresh installation. This candidate includes the optional OAuth verifier and local mocked renewal tests; each operator still configures its own provider/client and records actual-host acceptance.

Actual combined candidate Grok brief/artifact acceptance is pending. Dot and Muse
acceptance remains separate; an SDK session with their names is not an app test.
