/** Application OAuth and read-only Browse endpoints only. */
export const SCOPE_API = "https://api.ebay.com/oauth/api_scope";
export const browsePaths = {
  oauthToken: "/identity/v1/oauth2/token",
  browseSearch: "/buy/browse/v1/item_summary/search",
  browseItem: (itemId: string) => `/buy/browse/v1/item/${encodeURIComponent(itemId)}`,
  browseLegacy: "/buy/browse/v1/item/get_item_by_legacy_id",
};
