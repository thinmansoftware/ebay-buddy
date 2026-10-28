import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it, vi } from "vitest";
import { createBrowseContext, loadBrowseConfig } from "../src/browse-core/runtime.js";
import { createBrowseApp } from "../src/browse-core/http.js";
import { BROWSE_VERSION } from "../src/browse-core/release.js";

const fakeProvider = (url: string) =>
  new Response(
    JSON.stringify(
      url.includes("/identity/")
        ? { access_token: "synthetic-token", expires_in: 7200 }
        : url.includes("item_summary")
          ? {
              total: 1,
              itemSummaries: [{ itemId: "v1|123456789012|0", title: "Synthetic fixture comic" }],
            }
          : { itemId: "v1|123456789012|0", title: "Synthetic fixture comic" },
    ),
    { headers: { "content-type": "application/json" } },
  );
async function check(client: Client) {
  expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
    "get_connection_status",
    "get_ebay_item",
    "search_ebay",
  ]);
  expect(
    (await client.callTool({ name: "get_connection_status", arguments: {} })).structuredContent,
  ).toMatchObject({ read_only: true, provider_access: "not_checked" });
  const result = await client.callTool({ name: "search_ebay", arguments: { q: "comic" } });
  expect(result.isError).not.toBe(true);
  const id = (result.structuredContent!.items as { item_id: string }[])[0].item_id;
  expect(
    (await client.callTool({ name: "get_ebay_item", arguments: { item_id: id } }))
      .structuredContent,
  ).toMatchObject({
    item_id: id,
    title: "Synthetic fixture comic",
    price: null,
    price_basis: "unavailable",
  });
  expect((await client.callTool({ name: "create_listing", arguments: {} })).isError).toBe(true);
}
describe("public runtime wrappers", () => {
  it("serves three independent SDK sessions from one backend and reports one release", async () => {
    const credential = "synthetic-" + "m".repeat(43);
    let tokens = 0;
    const config = loadBrowseConfig({
      EBAY_CLIENT_ID: "synthetic-app",
      EBAY_CLIENT_SECRET: "synthetic-secret",
      MCP_TEST_TOKEN_SHA256: createHash("sha256").update(credential).digest("hex"),
      MCP_TEST_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
      MCP_RATE_LIMIT_PER_MINUTE: "120",
    });
    const app = createBrowseApp(
      createBrowseContext(config, {
        fetchImpl: async (url) => {
          if (url.includes("/identity/")) {
            tokens++;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          return fakeProvider(url);
        },
      }),
      { sessionCancellation: true },
    );
    const listener = app.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const endpoint = new URL(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`);
    // These are SDK emulations, not acceptance tests in the actual bot apps.
    const clients = ["Grok", "Dot", "Muse"].map(
      (name) => new Client({ name: `emulated-${name}`, version: "1" }),
    );
    const transports = clients.map(
      () =>
        new StreamableHTTPClientTransport(endpoint, {
          requestInit: { headers: { Authorization: `Bearer ${credential}` } },
        }),
    );
    try {
      await Promise.all(clients.map((client, i) => client.connect(transports[i])));
      expect(new Set(transports.map((transport) => transport.sessionId)).size).toBe(3);
      await Promise.all(
        clients.map(async (client) => {
          expect(client.getServerVersion()?.version).toBe(BROWSE_VERSION);
          expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
            "get_connection_status",
            "get_ebay_item",
            "search_ebay",
          ]);
          const status = await client.callTool({ name: "get_connection_status", arguments: {} });
          expect(status.structuredContent).toMatchObject({
            connector_version: BROWSE_VERSION,
            provider_access: "not_checked",
          });
          await check(client);
        }),
      );
      expect(tokens).toBe(1);
    } finally {
      await Promise.all(
        transports.map((transport) => transport.terminateSession().catch(() => undefined)),
      );
      await Promise.all(clients.map((client) => client.close()));
      app.locals.closeBrowseSessions();
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });
  it("caps authenticated session allocation and frees only an explicitly closed session", async () => {
    const token = "synthetic-" + "b".repeat(43);
    const config = loadBrowseConfig({
      MCP_TEST_TOKEN_SHA256: createHash("sha256").update(token).digest("hex"),
      MCP_TEST_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
      MCP_RATE_LIMIT_PER_MINUTE: "120",
    });
    const app = createBrowseApp(createBrowseContext(config), { sessionCancellation: true });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };
    const initialize = () =>
      fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "bounded-fixture", version: "1" },
          },
        }),
      });
    try {
      let session: string | null = null;
      for (let i = 0; i < 16; i++) {
        const response = await initialize();
        expect(response.status).toBe(200);
        session = response.headers.get("mcp-session-id");
        await response.text();
      }
      expect((await initialize()).status).toBe(429);
      expect(
        (
          await fetch(url, {
            method: "DELETE",
            headers: { ...headers, "Mcp-Session-Id": "unknown" },
          })
        ).status,
      ).toBe(405);
      expect(
        (
          await fetch(url, {
            method: "DELETE",
            headers: { ...headers, "Mcp-Session-Id": session! },
          })
        ).status,
      ).toBe(204);
      const reopened = await initialize();
      expect(reopened.status).toBe(200);
      await reopened.text();
    } finally {
      app.locals.closeBrowseSessions();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("routes HTTP SDK cancellation only to the matching bounded session", async () => {
    const token = "synthetic-" + "a".repeat(43);
    const config = loadBrowseConfig({
      EBAY_CLIENT_ID: "synthetic-app",
      EBAY_CLIENT_SECRET: "synthetic-secret",
      MCP_TEST_TOKEN_SHA256: createHash("sha256").update(token).digest("hex"),
      MCP_TEST_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
    });
    const started = new Set<string>();
    const aborted = new Set<string>();
    const ctx = createBrowseContext(config, {
      fetchImpl: async (url, init) => {
        if (url.includes("/identity/")) return fakeProvider(url);
        const q = new URL(url).searchParams.get("q")!;
        started.add(q);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted.add(q);
              reject(new Error("fixture cancelled"));
            },
            { once: true },
          );
        });
      },
    });
    const server = createBrowseApp(ctx, { sessionCancellation: true }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
    const clients = [
      new Client({ name: "cancel-A", version: "1" }),
      new Client({ name: "cancel-B", version: "1" }),
    ];
    const transports = clients.map(
      () =>
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
    );
    const controllers = [new AbortController(), new AbortController()];
    try {
      await Promise.all(clients.map((client, i) => client.connect(transports[i])));
      const promises = clients.map((client, i) =>
        client
          .callTool({ name: "search_ebay", arguments: { q: String(i) } }, undefined, {
            signal: controllers[i].signal,
          })
          .catch(() => undefined),
      );
      await vi.waitFor(() => expect(started.size).toBe(2));
      controllers[0].abort();
      await vi.waitFor(() => expect(aborted.has("0")).toBe(true), { timeout: 500 });
      expect(aborted.has("1")).toBe(false);
      controllers[1].abort();
      await vi.waitFor(() => expect(aborted.size).toBe(2), { timeout: 500 });
      await Promise.all(promises);
    } finally {
      await Promise.all(transports.map((t) => t.terminateSession().catch(() => undefined)));
      await Promise.all(clients.map((c) => c.close()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("runs the built stdio executable with a real SDK client and no private runtime", async () => {
    const temp = await mkdtemp(join(tmpdir(), "ebay-fixture-"));
    const fixture = join(temp, "provider.mjs");
    await writeFile(
      fixture,
      `import net from "node:net"; net.Server.prototype.listen = () => { throw new Error("Unexpected stdio listener"); }; globalThis.fetch = async (url) => (${fakeProvider.toString()})(String(url));`,
    );
    const client = new Client({ name: "stdio-fixture", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        pathToFileURL(fixture).href,
        resolve("dist/browse-core/cli.js"),
        "--stdio",
      ],
      env: {
        EBAY_CLIENT_ID: "synthetic-app",
        EBAY_CLIENT_SECRET: "synthetic-secret",
        EBAY_ENV: "sandbox",
      },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    try {
      await client.connect(transport);
      await check(client);
      expect(stderr).toBe("");
    } finally {
      await client.close();
      await rm(temp, { recursive: true, force: true });
    }
  });
  it("runs shared HTTP with authentication, bad-body, origin, expiry and seller-route rejection", async () => {
    const token = "synthetic-" + "a".repeat(43);
    const config = loadBrowseConfig({
      EBAY_CLIENT_ID: "synthetic-app",
      EBAY_CLIENT_SECRET: "synthetic-secret",
      MCP_TEST_TOKEN_SHA256: createHash("sha256").update(token).digest("hex"),
      MCP_TEST_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
    });
    const ctx = createBrowseContext(config, { fetchImpl: async (url) => fakeProvider(url) });
    const server = createBrowseApp(ctx).listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = new Client({ name: "http-fixture", version: "1" });
    const headers = { Authorization: `Bearer ${token}` };
    try {
      for (const method of ["GET", "POST", "DELETE"])
        expect((await fetch(base + "/mcp", { method })).status).toBe(401);
      expect(
        (await fetch(base + "/mcp", { headers: { ...headers, Origin: "https://evil.example" } }))
          .status,
      ).toBe(403);
      expect(
        (
          await fetch(base + "/mcp", {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: "[{}]",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(base + "/mcp", {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: "x".repeat(65537),
          })
        ).status,
      ).toBe(413);
      expect((await fetch(base + "/auth/ebay/start")).status).toBe(404);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers } }),
      );
      await check(client);
      config.testExpiresAt = Date.now() - 1;
      expect((await fetch(base + "/mcp", { headers })).status).toBe(401);
    } finally {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
