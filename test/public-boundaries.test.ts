import { describe, expect, it, vi } from "vitest";
import { EbayClient } from "../src/ebay/client.js";
import { createBrowseContext, loadBrowseConfig } from "../src/browse-core/runtime.js";
import { AppAuth } from "../src/browse-core/app-auth.js";
import { requestCancellation } from "../src/security/request-scope.js";

const config = () =>
  loadBrowseConfig(
    {
      EBAY_CLIENT_ID: "synthetic-app",
      EBAY_CLIENT_SECRET: "synthetic-secret",
      EBAY_REQUEST_TIMEOUT_MS: "20",
    },
    "stdio",
  );
describe("packaged provider boundaries", () => {
  it("permits only Browse GET/application token POST and never follows redirects", async () => {
    let calls = 0;
    const client = new EbayClient(config(), {
      fetchImpl: async (_url, init) => {
        calls++;
        expect(init?.redirect).toBe("error");
        return new Response("{}");
      },
    });
    for (const path of ["https://evil.example/a", "//evil.example/a", "/sell/fulfillment/v1/order"])
      await expect(client.request(path)).rejects.toThrow();
    await expect(client.request("/buy/browse/v1/item/123", { method: "DELETE" })).rejects.toThrow();
    expect(calls).toBe(0);
    await client.request("/buy/browse/v1/item/123");
    expect(calls).toBe(1);
  });
  it("bounds oversized, stalled and cancelled work and retains occupied slots", async () => {
    const huge = new EbayClient(config(), {
      fetchImpl: async () => new Response("x".repeat(1048577)),
    });
    await expect(huge.request("/buy/browse/v1/item/123")).rejects.toThrow(/size/);
    const stalled = new EbayClient(config(), { fetchImpl: () => new Promise(() => undefined) });
    await Promise.all(
      Array.from({ length: 4 }, () =>
        expect(stalled.request("/buy/browse/v1/item/123")).rejects.toThrow(/timed out/),
      ),
    );
    await expect(stalled.request("/buy/browse/v1/item/123")).rejects.toThrow(/limit/);
    const controller = new AbortController();
    controller.abort();
    await requestCancellation.run(controller.signal, async () => {
      await expect(huge.request("/buy/browse/v1/item/123")).rejects.toThrow(/cancelled/);
    });
  });
  it("uses app-token cache only and rejects malformed token responses", async () => {
    const settings = config();
    const requests: URLSearchParams[] = [];
    const client = new EbayClient(settings, {
      fetchImpl: async (_url, init) => {
        requests.push(new URLSearchParams(String(init?.body)));
        return new Response(JSON.stringify({ access_token: "synthetic-token", expires_in: 7200 }));
      },
    });
    const auth = new AppAuth(settings, client);
    expect(await auth.getAppToken()).toBe("synthetic-token");
    await auth.getAppToken();
    expect(requests).toHaveLength(1);
    expect(requests[0].get("grant_type")).toBe("client_credentials");
    expect(requests[0].get("scope")).toBe("https://api.ebay.com/oauth/api_scope");
    const broken = new AppAuth(
      settings,
      new EbayClient(settings, {
        fetchImpl: async () =>
          new Response(JSON.stringify({ access_token: "synthetic-token", expires_in: 0 })),
      }),
    );
    await expect(broken.getAppToken()).rejects.toThrow(/token response/);
  });
  it("maps auction, free-vs-unknown shipping and seller claims without inference", async () => {
    const ctx = createBrowseContext(config(), {
      fetchImpl: async (url) =>
        new Response(
          JSON.stringify(
            url.includes("/identity/")
              ? { access_token: "synthetic-token", expires_in: 7200 }
              : {
                  itemId: "v1|123456789012|0",
                  title: "Synthetic comic",
                  currentBidPrice: { value: "3.00", currency: "USD" },
                  bidCount: 0,
                  itemWebUrl: "javascript:alert(1)",
                  shippingOptions: [{ shippingCost: { value: "0.00", currency: "USD" } }, {}],
                  localizedAspects: [{ name: "Grade", value: "9.8" }],
                },
          ),
        ),
    });
    expect(await ctx.browse.getItem("v1|123456789012|0")).toMatchObject({
      priceBasis: "current_bid",
      bidCount: 0,
      itemWebUrl: null,
      conditionId: null,
      shippingOptions: [{ shippingCost: "0.00" }, { shippingCost: null }],
      aspects: { Grade: ["9.8"] },
    });
  });
  it("enforces HTTP expiry without exposing config values in errors", () => {
    const secret = "synthetic-secret-sentinel";
    vi.useFakeTimers();
    try {
      const env = {
        MCP_TEST_TOKEN_SHA256: "a".repeat(64),
        MCP_TEST_EXPIRES_AT: new Date(Date.now() + 7 * 86400000 + 1).toISOString(),
        EBAY_CLIENT_SECRET: secret,
      };
      expect(() => loadBrowseConfig(env, "http")).toThrow(/seven days/);
      expect(() =>
        loadBrowseConfig(
          {
            ...env,
            MCP_TEST_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
            EBAY_ENV: secret,
          },
          "http",
        ),
      ).toThrow("Invalid Browse connector configuration.");
    } finally {
      vi.useRealTimers();
    }
  });
});
