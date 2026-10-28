# Privacy and data flow

eBay Buddy's Browse server receives the search/item requests the user authorizes,
contacts eBay using operator-supplied application credentials, and returns listing
evidence. It does not receive Gmail credentials or read an inbox. The Browse core
has no application analytics or order database. Operators,package managers,
reverse proxies,eBay and the chosen assistant host have their own policies/logs.

The optional Gmail workflow uses the host's existing authorized Gmail connection.
Its instructions limit usage to eBay seller notices. That usage policy does not
change the OAuth permissions Google/your host presents. Review that consent and
select the intended account in the host's secure connection settings.

The advertised on-demand prepare-brief path uses no database. It transiently
reads complete requested notices, returns normalized facts without body/sender
address, and marks unavailable received time unknown. Artifact files remain in
the owner's private workspace until the owner removes them. It sends no alert.
An optional, separately owner-authorized same-order Seller Hub read can supply
only the order reference and one item's title, listing number, observed native
item link and quantity to this transient path. These facts remain host-local
and visibly sourced; they are not sent to the Browse server. An exact listing
lookup sends only that listing ID to eBay. No buyer fields or prices are accepted.
Private seller sign-in remains in the host browser; the companion receives no
session cookie or seller credential. Missing sign-in requires owner action.

The retained experimental automatic-alert path is outside the advertised release
scope. Only normalized native message/order references,event kind,time,title,explicit
email quantity and optional exact-item photo metadata enter a local SQLite ledger
in the bot's private workspace. The mailbox identifier is hashed; this is an index,
not anonymization or a substitute for filesystem/account authorization. Complete selected mail bodies are read transiently by prepare-brief; they are
not retained in the ledger or normalized output. Customer addresses, payment
details and API credentials are not needed or retained by this helper. The artifact contains email-derived order notices and listing photos.
The prepare command transiently reads a complete email body supplied by the host
to find an explicitly labeled order number. It does not persist or return that
body; held records contain only native message references and reason codes.
The renderer loads optional public eBay image URLs with no-referrer and cannot
make API calls. Recipients of an artifact can see its included order information;
keep it private to the owner rather than publishing it.

No mailbox sends,labels,deletes or archives,provider business writes,purchases or
shipping actions are performed. Notifications are sent by the host only when its
user enables that native routine; this package has no independent sending service.

To stop:pause/remove the host routine,disable/remove the skill and disconnect its
Gmail/eBay connections through the host's settings as desired. Stop the routine
before removing its own private ledger/artifact; losing the ledger loses local
alert history. Keep backups only where the account owner authorizes them. No
operator-hosted retention or public support SLA is promised by this candidate.

This notice is included for publisher review,not a claim that a public website,
marketplace listing or production service has been published. Source/license,
publisher identity and final public policy/support locations require owner approval.

## Optional OAuth identity

In OAuth mode the Browse server verifies an access JWT from the operator's chosen
identity provider for its own MCP resource and registered client. It derives a
session-owner digest from issuer, subject and client; sessions are memory-only
and bounded to ten minutes. It does not persist caller access/refresh tokens,
forward them to eBay, or offer a refresh-token vault. The client/identity provider
controls renewal, grants and retention. Operators must review proxy/provider logs
and never enable credential/header logging. A valid signed JWT may remain usable
until its short expiry after provider logout/revocation; immediate revocation
introspection is not implemented. Remove access at the provider/backend if needed.

Private support/security contact: admin@thinmansoftware.com. Send a sanitized
summary first; never send secrets, mail bodies or buyer details. Public site
publication and a public managed service remain separate release steps.
