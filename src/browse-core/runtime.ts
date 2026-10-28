import { BrowseApi } from "../ebay/browse.js";
import { EbayClient, type FetchLike } from "../ebay/client.js";
import { AppAuth } from "./app-auth.js";
import type { BrowseConfig } from "./config.js";
export { loadBrowseConfig } from "./config.js";

export type BrowseContext = {
  config: Pick<
    BrowseConfig,
    | "env"
    | "hasAppCredentials"
    | "marketplaceId"
    | "testExpiresAt"
    | "testTokenHash"
    | "publicBaseUrl"
    | "rateLimitPerMinute"
    | "authMode"
    | "oauth"
  >;
  auth: { requireAppCredentials(): void };
  browse: BrowseApi;
};
export function createBrowseContext(
  config: BrowseConfig,
  options: { fetchImpl?: FetchLike } = {},
): BrowseContext {
  const client = new EbayClient(config, options);
  const auth = new AppAuth(config, client);
  return { config, auth, browse: new BrowseApi(client, auth, true) };
}
