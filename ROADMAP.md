# eBay Buddy roadmap and release status

The base marketplace submission is **search + native Gmail**. Its release path
is independent of the private seller-order backend and temporary packing desk.
One shared eBay Browse backend can serve multiple bot clients. Each host supplies
its own Gmail connection, routine and artifacts; designate one notifying bot per
mailbox. Self-hosted Browse requires the operator's approved eBay developer app.

## Current evidence

- The three Browse tools have historical actual Grok search/item evidence. This
  rc.3 revision is locally tested using mocked provider responses; its combined
  Gmail/routine/artifact workflow still needs actual host acceptance.
- The new standard-library Gmail companion has isolated local tests for quiet
  baselines, account separation, repeated notices, restarts, same-file concurrent
  processes, unknown covers/units and uncertain delivery. It never calls Gmail,
  sends notifications or enables a schedule itself.
- Seller-email status is email-derived, not current seller API status. Photos
  require an explicit exact item lookup. The brief is not a complete order/cart,
  physical-stock ledger, shipping desk or refund-clearance check.
- Private owner-authorized seller API reads, Dashboard and shipping are later
  capabilities, not prerequisites for this marketplace submission. Their source
  tests and private prototypes do not establish availability in the base package.
- Marketplace publication and the local AND in-app submission attestation remain
  separate from local test completion. No directory approval is implied.

## Core Buddy capabilities: independent of CE

Search, the planned seller Dashboard, sold alerts and label workflow are category-agnostic and do not require buying Comic Edition. Free software does not mean free postage, provider services or hosting.

1. **Own-order reads and sold alerts.** Bind access to the authenticated seller owner. Establish the first historical baseline without notifications; detect intended new/changed orders with stable identities, overlapping windows, durable deduplication and pending state. Keep unpaid, cancellation, refunds, holds, partial fulfillment and unknown evidence explicit. Verify delivery/acknowledgment and use stable event IDs before enabling any sender or schedule.
2. **Seller Dashboard.** Monitor currently-for-sale items, sales, outstanding work, last successful sync and errors, with relevant actions only where supported. A paid order is not proof of physical stock, packing readiness or a cleared refund state.
3. **Shipping labels.** Review the exact order/parcel and quote/service/cost/address, then explicitly approve postage purchase. Buy once, reconcile uncertain results, and print purchased labels using the established Workroom path with durable duplicate/reprint controls. No purchase, print or fulfillment automation is available in the current Browse release.

## Optional Comic Edition capability: comics only

An optional CE account could add collection-file import, identification/matching, covers, listing-file preparation and the full CE workspace. The proposed 14-day trial/subscription terms—including price, renewal/opt-in and cancellation—remain unfinalized. No billing or account-linking implementation is included here, and Buddy's general capabilities must not disappear when a CE trial ends.

The intended conversion destination is a user-reviewed, downloadable **eBay upload file** that the user uploads themselves. CE's eBay export is unfinished and under work. Reuse its approved services only after account authorization, exact export-template/matching contracts, image rights/stable URLs and compute quotas are established. BYO eBay keys do not authorize CE access. No live listing publication is implied.

## Distribution

The reviewed Browse archives remain a distinct frozen candidate. Later roadmap/source-doc changes do not silently replace those files or prove new capabilities. Publish only a reviewed public-safe source tree, documentation/assets actually present, chosen license/notices and exact approved artifacts. Exclude operator identity, private accounts/order data, keys, lab endpoints, private configuration and Git history. Portable seller packaging follows accepted personal workflow evidence; broad consumer hosting is not the current launch.
