# Grok Bot setup: one backend and a host-local companion

This free source release provides three eBay Browse tools and an optional Gmail
brief workflow. It does not include a public hosted service, eBay developer
approval, a shared API key or seller-account order access. The operator needs its
own eBay application credentials and HTTPS runtime. A shopping login is not a
developer application's client ID/secret. Runtime and provider quotas remain the
operator's responsibility.

## 1. Qualify the source on the machine running it

Obtain the exact reviewed ZIP and verify its receipt SHA256. Extract to a new
folder. Node.js 22+ is required for the MCP server. Python 3.10+ is required for
the companion and the complete source tests. No Python packages are required.
Run from the extracted root:

```sh
npm ci --ignore-scripts
npm run check
npm test
python3 -m unittest discover -s test -p 'test_*.py'
```

On Windows use your installed Python executable. Set EBAY_BUDDY_TEST_PYTHON to
that executable's path if it is not the default python/python3. The check command
reports prerequisites only; it never checks accounts or prints environment values.
The namespace is not published to npm. Do not substitute an unverified npx package.

## 2. Configure the backend for renewable OAuth

Use the host's masked environment/secret settings for EBAY_CLIENT_ID and
EBAY_CLIENT_SECRET. Set EBAY_ENV=production for real listings, marketplace as
needed, PUBLIC_BASE_URL to your HTTPS origin, and PORT behind your TLS proxy.
Never expose the plain HTTP listener or put credentials in chat/source/arguments.

Set MCP_AUTH_MODE=oauth, MCP_OAUTH_ISSUER to the exact HTTPS identity-provider root
including its trailing slash, and MCP_OAUTH_CLIENT_ID to the registered public
client ID. The issuer must publish its RS256 keys at .well-known/jwks.json and
standard OAuth discovery, authorization and token endpoints. The resource/audience
is exactly PUBLIC_BASE_URL + /mcp; the only API permission is ebay:browse:read.
Configure authorization-code + S256 PKCE for this public client, the exact callback
shown by the intended bot, and offline_access/refresh grants under the provider's
own policy. Do not add a client secret to a public bot config or accept seller scopes.
Provider/client configuration is an operator action; this package changes none.

Start node dist/browse-core/cli.js --http. /health returns only {"ok":true}.
An unauthenticated /mcp returns 401 and protected-resource metadata discovery.
Use your host's supported remote MCP OAuth setup for the HTTPS /mcp URL and public
client ID. Request ebay:browse:read and offline_access explicitly. Cursor's current
published static-OAuth shape is supplied in mcp.template.json; replace both
placeholders, review it, and use only on a host that supports that shape. It is a
template, not an installed connection or a promise of identical Dot/Muse settings.
Official reference: https://cursor.com/docs/mcp (checked October 28, 2026).

The client holds refresh credentials and renews through the identity provider;
the resource server never stores refresh tokens. Every MCP request verifies the
access token. Renewed tokens for the same issuer/user/client retain the session.
A different user cannot reuse or close it. Sessions last at most ten minutes;
reinitialize an expired session using current credentials. Sessions are local to
one process: use a single instance or host affinity, not uncoordinated replicas.
The backend does not claim distributed seller-refresh coordination.

Normal expiry should renew without a new prompt when the client has a valid
refresh token. Revocation, inactivity, maximum lifetime or provider security
checks can require sign-in again. Use the same connection's Reconnect/Sign in
control; MFA or consent may add steps. Never promise permanently valid OAuth or
unconditionally one-click completion. Do not replay business writes; these tools
perform reads only. Fixed caller tokens remain explicit MCP_AUTH_MODE=test-token
lab mode with a digest/expiry within seven days, not the consumer renewal route.

## 3. Install the companion on Grok's cloud computer

A remote MCP connection does not copy the ZIP, skill or Python scripts. Attach
this exact reviewed ZIP in the intended Grok conversation. Ask Grok to verify its
hash, extract it to a NEW private folder, and run the Python tests above. Grok's
cloud computer is different from your Windows PC: C:\ paths cannot launch there.
Determine the absolute extracted root, then run:

```sh
python3 /absolute/package/root/companion/cli.py check
```

Read that root's GMAIL_WORKFLOW.md and skills/ebay-mail-watch/SKILL.md. Invoke the
same absolute cli.py with prepare-brief, render-brief or rank-search, feeding JSON
through stdin in the private workspace. These commands work from any directory.
No automatic installation, Gmail grant or notification routine is implied.

Use the user's selected native Gmail account. Missing native Gmail access requires
its normal secure account connection. Read only authorized eBay seller notices;
the sender usage restriction does not narrow the host's Google OAuth grant.
If genuine internalDate is unavailable, requested briefs show Received time
unavailable. Automatic alerts stay excluded; do not invent timestamps.

## 4. Accept, update or remove

Discover exactly get_connection_status, search_ebay, get_ebay_item. Status's
credentials_configured and provider_access=not_checked do not prove live access.
Search, then inspect one exact returned ID. Compare titles, issues, variants,
lots, presales and seller claims; asks/current bids are not sold comps. Unknown
shipping is not free. Run GROK_ACCEPTANCE.md for this exact revision and retain a
sanitized receipt. Historical private rc.6 renewal is not a new-user rc.10 pass.

On 401 allow the client's bounded renewal flow; if reconnect is requested, sign in
through the host. On session 404 reinitialize; on 429 back off. Never paste keys or
headers into chat. Review exact upgrades and new permissions before installing.
Disconnect the bot, revoke its provider grant if desired, remove its configuration,
stop your backend and delete its own private artifacts/companion files to remove.
No Azure resources or existing accounts are changed by these instructions.
