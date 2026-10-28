import { z } from "zod";

export type BrowseOAuthConfig = {
  issuer: string;
  clientId: string;
  resource: string;
  scope: "ebay:browse:read";
};
export type BrowseConfig = {
  profile: "readonly-test";
  env: "sandbox" | "production";
  clientId: string;
  clientSecret: string;
  hasAppCredentials: boolean;
  apiBase: string;
  marketplaceId: string;
  requestTimeoutMs: number;
  testTokenHash: string;
  testExpiresAt: number;
  rateLimitPerMinute: number;
  publicBaseUrl: string;
  port: number;
  authMode: "test-token" | "oauth";
  oauth?: BrowseOAuthConfig;
};

export function loadBrowseConfig(
  env: NodeJS.ProcessEnv = process.env,
  transport: "http" | "stdio" = "http",
): BrowseConfig {
  const fields = z
    .object({
      CONNECTOR_PROFILE: z.literal("readonly-test").default("readonly-test"),
      EBAY_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
      EBAY_CLIENT_ID: z.string().default(""),
      EBAY_CLIENT_SECRET: z.string().default(""),
      EBAY_MARKETPLACE_ID: z
        .string()
        .regex(/^EBAY_[A-Z_]{2,20}$/)
        .default("EBAY_US"),
      EBAY_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(10).max(15000).default(10000),
      MCP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(120).default(30),
      MCP_TEST_TOKEN_SHA256: z.string().default(""),
      MCP_TEST_EXPIRES_AT: z.string().default(""),
      PUBLIC_BASE_URL: z.string().default("http://127.0.0.1:8080"),
      PORT: z.coerce.number().int().min(1).max(65535).default(8080),
      MCP_AUTH_MODE: z.enum(["test-token", "oauth"]).default("test-token"),
      MCP_OAUTH_ISSUER: z.string().default(""),
      MCP_OAUTH_CLIENT_ID: z.string().default(""),
    })
    .safeParse(env);
  if (!fields.success) throw new Error("Invalid Browse connector configuration.");
  const e = fields.data;
  const expires = transport === "stdio" || e.MCP_AUTH_MODE === "oauth" ? Infinity : Date.parse(e.MCP_TEST_EXPIRES_AT);
  if (
    transport === "http" && e.MCP_AUTH_MODE === "test-token" &&
    (!/^[a-f0-9]{64}$/i.test(e.MCP_TEST_TOKEN_SHA256) ||
      !Number.isFinite(expires) ||
      expires <= Date.now() ||
      expires > Date.now() + 7 * 86400000)
  ) {
    throw new Error("HTTP requires a caller digest and an expiration within seven days.");
  }
  const url = new URL(e.PUBLIC_BASE_URL);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
  ) {
    throw new Error("Use an HTTPS public origin or an HTTP loopback origin.");
  }
  let oauth: BrowseOAuthConfig | undefined;
  if (e.MCP_AUTH_MODE === "oauth") {
    if (transport !== "http") throw new Error("OAuth requires HTTP transport.");
    const issuer = new URL(e.MCP_OAUTH_ISSUER);
    if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash || issuer.pathname !== "/" || e.MCP_OAUTH_ISSUER !== issuer.href || !/^[A-Za-z0-9_-]{1,128}$/.test(e.MCP_OAUTH_CLIENT_ID)) {
      throw new Error("OAuth requires an exact HTTPS issuer and registered client ID.");
    }
    oauth = { issuer:issuer.href, clientId:e.MCP_OAUTH_CLIENT_ID, resource:url.origin+"/mcp", scope:"ebay:browse:read" };
  }
  return {
    profile: "readonly-test",
    env: e.EBAY_ENV,
    clientId: e.EBAY_CLIENT_ID.trim(),
    clientSecret: e.EBAY_CLIENT_SECRET.trim(),
    hasAppCredentials: Boolean(e.EBAY_CLIENT_ID.trim() && e.EBAY_CLIENT_SECRET.trim()),
    apiBase: e.EBAY_ENV === "production" ? "https://api.ebay.com" : "https://api.sandbox.ebay.com",
    marketplaceId: e.EBAY_MARKETPLACE_ID,
    requestTimeoutMs: e.EBAY_REQUEST_TIMEOUT_MS,
    testTokenHash: e.MCP_TEST_TOKEN_SHA256.toLowerCase(),
    testExpiresAt: expires,
    rateLimitPerMinute: e.MCP_RATE_LIMIT_PER_MINUTE,
    publicBaseUrl: url.origin,
    port: e.PORT,
    authMode: e.MCP_AUTH_MODE,
    oauth,
  };
}
