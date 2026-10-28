import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBrowseServer } from "../src/browse-core/mcp.js";
import { createBrowseContext, loadBrowseConfig } from "../src/browse-core/runtime.js";

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});
async function connect(legacyItemId?: string) {
  const calls: string[] = [];
  const ctx = createBrowseContext(
    loadBrowseConfig(
      { EBAY_CLIENT_ID: "synthetic-app", EBAY_CLIENT_SECRET: "synthetic-secret" },
      "stdio",
    ),
    {
      fetchImpl: async (url) => {
        calls.push(url);
        const body = url.includes("/identity/")
          ? { access_token: "synthetic-token", expires_in: 7200 }
          : url.includes("item_summary")
            ? {
                total: 25,
                itemSummaries: [
                  {
                    itemId: "v1|123456789012|0",
                    title: "Synthetic graded comic",
                    price: { value: "25", currency: "USD" },
                  },
                ],
              }
            : { itemId: "v1|123456789012|0", title: "Synthetic graded comic", legacyItemId };
        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createBrowseServer(ctx).connect(a);
  const client = new Client({ name: "core-fixture", version: "1" });
  clients.push(client);
  await client.connect(b);
  return { client, calls };
}
describe("shared Browse core", () => {
  it("rejects contradictory explicit legacy identity even when the Browse ID matches", async () => {
    const { client } = await connect("999999999999");
    expect(
      (
        await client.callTool({
          name: "get_ebay_item",
          arguments: { legacy_item_id: "123456789012" },
        })
      ).isError,
    ).toBe(true);
  });

  it("rejects a mismatched legacy result instead of showing a different listing", async () => {
    const { client } = await connect();
    expect(
      (
        await client.callTool({
          name: "get_ebay_item",
          arguments: { legacy_item_id: "999999999999" },
        })
      ).isError,
    ).toBe(true);
  });
  it("propagates SDK cancellation to actual stdio-style provider work", async () => {
    let started = false;
    let aborted = false;
    const ctx = createBrowseContext(
      loadBrowseConfig(
        { EBAY_CLIENT_ID: "synthetic-app", EBAY_CLIENT_SECRET: "synthetic-secret" },
        "stdio",
      ),
      {
        fetchImpl: async (_url, init) => {
          started = true;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new Error("fixture cancelled"));
              },
              { once: true },
            );
          });
        },
      },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createBrowseServer(ctx).connect(a);
    const client = new Client({ name: "cancel-fixture", version: "1" });
    clients.push(client);
    await client.connect(b);
    const controller = new AbortController();
    const pending = client.callTool({ name: "search_ebay", arguments: { q: "comic" } }, undefined, {
      signal: controller.signal,
    });
    const rejection = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(started).toBe(true));
    controller.abort();
    await rejection;
    await vi.waitFor(() => expect(aborted).toBe(true), { timeout: 250 });
  });
  it("exposes the same three tools without seller routes or private state", async () => {
    const { client, calls } = await connect();
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "get_connection_status",
      "get_ebay_item",
      "search_ebay",
    ]);
    expect(
      (await client.callTool({ name: "get_connection_status", arguments: {} })).structuredContent,
    ).toMatchObject({ read_only: true, provider_access: "not_checked", expires_at: null });
    expect(calls).toEqual([]);
    expect((await client.callTool({ name: "list_orders", arguments: {} })).isError).toBe(true);
  });
  it("validates whitespace, pagination and IDs before provider calls", async () => {
    const { client, calls } = await connect();
    for (const args of [
      { q: "   " },
      { q: "comic", limit: 3, offset: 1 },
      { q: "comic", limit: 50, offset: 10000 },
    ])
      expect((await client.callTool({ name: "search_ebay", arguments: args })).isError).toBe(true);
    for (const args of [
      {},
      { item_id: "https://evil.example/a" },
      { item_id: "123", legacy_item_id: "456" },
    ])
      expect((await client.callTool({ name: "get_ebay_item", arguments: args })).isError).toBe(
        true,
      );
    expect(calls).toEqual([]);
  });
  it("uses category/aspect filters and returns honest pagination and nullable evidence", async () => {
    const { client, calls } = await connect();
    const result = await client.callTool({
      name: "search_ebay",
      arguments: {
        q: "  comic  ",
        limit: 1,
        category_ids: "63",
        aspect_filter: "categoryId:63,Grade:{9.8}",
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      total: 25,
      offset: 0,
      limit: 1,
      next_offset: 1,
      price_basis: "asking_prices_and_current_bids",
      items: [
        {
          item_id: "v1|123456789012|0",
          price_basis: "asking_price",
          current_bid_price: null,
          condition_id: null,
          item_end_date: null,
          shipping_options: [],
        },
      ],
    });
    expect(new URL(calls[1]).searchParams.get("q")).toBe("comic");
    expect(new URL(calls[1]).searchParams.get("aspect_filter")).toBe("categoryId:63,Grade:{9.8}");
  });
  it("keeps HTTP callers authenticated and bounded while stdio requires no fake HTTP key", () => {
    expect(() => loadBrowseConfig({}, "http")).toThrow();
    expect(loadBrowseConfig({}, "stdio").testExpiresAt).toBe(Infinity);
    expect(() =>
      loadBrowseConfig({ EBAY_ENV: "production", CONNECTOR_PROFILE: "development" }, "stdio"),
    ).toThrow();
  });
});
