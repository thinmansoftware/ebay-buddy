import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBrowseServer } from "../src/browse-core/mcp.js";
import { createBrowseContext, loadBrowseConfig } from "../src/browse-core/runtime.js";

describe("comic search evidence and near matches", () => {
  it("preserves issue/cover/condition/bundle/presale differences and exact IDs without inventing a comic match", async () => {
    const listings = [
      {
        itemId: "v1|123456789011|0",
        title: "Synthetic Saga 25 Cover A raw",
        condition: "Like New",
      },
      {
        itemId: "v1|123456789012|0",
        title: "Synthetic Saga 25 Cover B graded 9.8",
        condition: "Brand New",
      },
      {
        itemId: "v1|123456789013|0",
        title: "Synthetic Saga 21-25 lot of 5",
        condition: "Very Good",
      },
      {
        itemId: "v1|123456789014|0",
        title: "Synthetic Saga 25 Cover A PRESALE",
        condition: "Brand New",
      },
      { itemId: "v1|123456789015|0", title: "Synthetic Saga 125 Cover A raw", condition: "Good" },
    ];
    const ctx = createBrowseContext(
      loadBrowseConfig(
        { EBAY_CLIENT_ID: "synthetic-app", EBAY_CLIENT_SECRET: "synthetic-secret" },
        "stdio",
      ),
      {
        fetchImpl: async (url) => {
          const row = listings.find((item) => decodeURIComponent(url).endsWith(item.itemId));
          return new Response(
            JSON.stringify(
              url.includes("/identity/")
                ? { access_token: "synthetic-token", expires_in: 7200 }
                : url.includes("item_summary")
                  ? { total: 5, itemSummaries: listings }
                  : {
                      ...row,
                      localizedAspects: [
                        { name: "Issue Number", value: "25" },
                        { name: "Variant Type", value: "Cover B" },
                        { name: "Grade", value: "9.8" },
                      ],
                      shippingOptions: [{ shippingCost: { value: "5.00", currency: "USD" } }],
                    },
            ),
          );
        },
      },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createBrowseServer(ctx).connect(a);
    const client = new Client({ name: "comic-fixture", version: "1" });
    await client.connect(b);
    try {
      const result = await client.callTool({
        name: "search_ebay",
        arguments: { q: "Saga 25 Cover A", limit: 5 },
      });
      expect(result.structuredContent).toMatchObject({
        match_basis: "provider_search_candidates",
        price_basis: "asking_prices_and_current_bids",
        items: listings.map((row) => ({
          item_id: row.itemId,
          title: row.title,
          condition: row.condition,
          price: null,
        })),
      });
      const detail = await client.callTool({
        name: "get_ebay_item",
        arguments: { item_id: listings[1].itemId },
      });
      expect(detail.structuredContent).toMatchObject({
        item_id: listings[1].itemId,
        title: listings[1].title,
        aspects: { "Issue Number": ["25"], "Variant Type": ["Cover B"], Grade: ["9.8"] },
        shipping_options: [{ shipping_cost: "5.00", currency: "USD" }],
      });
      expect(detail.structuredContent).not.toHaveProperty("verified_grade");
    } finally {
      await client.close();
    }
  });
});
