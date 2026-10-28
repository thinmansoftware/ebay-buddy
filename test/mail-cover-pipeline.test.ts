import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBrowseServer } from "../src/browse-core/mcp.js";
import { createBrowseContext, loadBrowseConfig } from "../src/browse-core/runtime.js";

const notices = JSON.parse(readFileSync("test/fixtures/synthetic_seller_notices.json", "utf8"));
const python = process.env.EBAY_BUDDY_TEST_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"].includes(key.toUpperCase())));
const prepare = (messages: unknown[]) => JSON.parse(execFileSync(python,
  ["companion/mail_watch.py", "prepare-brief"],
  { input: JSON.stringify({ mailbox_id: "synthetic-owner", messages }), encoding: "utf8", env }));

describe("synthetic body -> existing legacy MCP lookup -> exact email cover", () => {
  it.each([false, true])("resolves three exact covers with explicit same-order enrichment=%s", async (useHub) => {
    const titles = ["SYNTHETIC Saga #1 Cover A First Printing", "SYNTHETIC Batman #25 Cover A", "SYNTHETIC Spawn #1 & Variant Cover"];
    const messages = useHub ? notices.map((notice: Record<string, unknown>, index: number) => {
      const order = `00-00000-0000${index + 1}`;
      const legacy = String(123456789011 + index);
      return { ...notice, kind: "sale", text_body: `Order number: ${order}\nQuantity: ${index === 0 ? 2 : 1}`,
        html_body: "<p>SYNTHETIC source without complete title or listing number</p>",
        order_identity: { source: "ebay_seller_hub", order_id: order, complete: true,
          items: [{ title: titles[index], legacy_item_id: legacy,
            item_url: `https://www.ebay.com/itm/${legacy}`, quantity: index === 0 ? 2 : 1 }] } };
    }) : notices;
    const page = prepare(messages);
    expect(page.orders.map((row: { legacy_item_id: string }) => row.legacy_item_id))
      .toEqual(["123456789011", "123456789012", "123456789013"]);
    const paths: string[] = [];
    const ctx = createBrowseContext(loadBrowseConfig({ EBAY_CLIENT_ID: "synthetic-app",
      EBAY_CLIENT_SECRET: "synthetic-secret" }, "stdio"), { fetchImpl: async (url) => {
      const request = new URL(url); paths.push(request.pathname);
      if (request.pathname.includes("/identity/")) return new Response(JSON.stringify({ access_token: "synthetic-token", expires_in: 7200 }));
      if (!request.pathname.endsWith("/get_item_by_legacy_id")) throw new Error("Unexpected provider operation");
      const id = request.searchParams.get("legacy_item_id");
      if (!["123456789011", "123456789012", "123456789013"].includes(id ?? "")) throw new Error("Wrong legacy identity");
      return new Response(JSON.stringify({ itemId: `v1|${id}|0`, legacyItemId: id,
        title: "SYNTHETIC provider listing", image: { imageUrl: `https://i.ebayimg.com/images/g/synthetic${id}/s-l1600.jpg` },
        price: { value: "5.00", currency: "USD" }, buyingOptions: ["FIXED_PRICE"] }));
    } });
    const [a,b] = InMemoryTransport.createLinkedPair(); await createBrowseServer(ctx).connect(a);
    const client = new Client({ name: "synthetic-mail-pipeline", version: "1" }); await client.connect(b);
    try {
      const enriched = [];
      for (let index=0; index<3; index++) {
        const result = await client.callTool({ name: "get_ebay_item", arguments: { legacy_item_id: page.orders[index].legacy_item_id } });
        expect(result.isError).not.toBe(true);
        enriched.push({ ...messages[index], item_lookup: { ...result.structuredContent, source: "get_ebay_item" } });
      }
      const final = prepare(enriched);
      expect(final.review_needed).toEqual([]);
      expect(final.orders.map((row: { item_id: string }) => row.item_id))
        .toEqual(["v1|123456789011|0", "v1|123456789012|0", "v1|123456789013|0"]);
      const html = execFileSync(python, ["companion/render_brief.py"], { input: JSON.stringify(final), encoding: "utf8", env });
      expect(html.match(/<img src=/g)).toHaveLength(3);
      expect(html).toContain("SYNTHETIC Saga #1 Cover A First Printing");
      expect(html).toContain("SYNTHETIC Batman #25 Cover A");
      expect(html).toContain("SYNTHETIC Spawn #1 &amp; Variant Cover");
      expect(html.match(/Received time unavailable/g)).toHaveLength(3);
      expect(html).toContain("Live eBay status not checked");
      expect(html.includes("Item identity: Seller Hub order details")).toBe(useHub);
      expect(final.orders.every((row: Record<string, unknown>) => !("price" in row))).toBe(true);
      expect(prepare([...enriched, ...enriched])).toEqual(final);
      expect(paths.filter(path => path.endsWith("get_item_by_legacy_id"))).toHaveLength(3);
      expect(paths.some(path => path.includes("item_summary"))).toBe(false);
    } finally { await client.close(); }
  });
});
