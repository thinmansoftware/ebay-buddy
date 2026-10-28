/** Tarball-only acceptance; all provider responses are synthetic, with no network calls to eBay. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const installation = resolve(process.argv[2]);
const require = createRequire(join(installation, "package.json"));
const moduleAt = (name) => import(pathToFileURL(require.resolve(name)).href);
const { Client } = await moduleAt("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await moduleAt("@modelcontextprotocol/sdk/client/stdio.js");
const { StreamableHTTPClientTransport } = await moduleAt(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
);
const cli = join(
  installation,
  "node_modules/@thinmansoftware/ebay-buddy-core/dist/browse-core/cli.js",
);
const packageJson = JSON.parse(
  await readFile(
    join(installation, "node_modules/@thinmansoftware/ebay-buddy-core/package.json"),
    "utf8",
  ),
);
const { BROWSE_VERSION } = await import(
  pathToFileURL(
    join(installation, "node_modules/@thinmansoftware/ebay-buddy-core/dist/browse-core/release.js"),
  ).href
);
assert.equal(packageJson.version, BROWSE_VERSION);
assert.match(BROWSE_VERSION, /^\d+\.\d+\.\d+-rc\.\d+$/);
assert.equal(packageJson.dependencies.zod, "4.6.7");
const temp = await mkdtemp(join(tmpdir(), "ebay-pack-fixture-"));
const fixture = join(temp, "provider.mjs");
await writeFile(
  fixture,
  `import net from 'node:net';
if(process.argv.includes('--stdio'))net.Server.prototype.listen=()=>{throw new Error('Unexpected stdio HTTP listener');};
globalThis.fetch=async url=>{
 if(!/^https:\\/\\/api(?:\\.sandbox)?\\.ebay\\.com\\//.test(String(url)))throw new Error('Unexpected provider origin');
 return new Response(JSON.stringify(String(url).includes('/identity/')?{access_token:'synthetic-token',expires_in:7200}:String(url).includes('item_summary')?{total:1,itemSummaries:[{itemId:'v1|123456789012|0',title:'Synthetic Saga 1 Cover A',price:{value:'25.00',currency:'USD'},shippingOptions:[{shippingCost:{value:'4.50',currency:'USD'}}]}]}:{itemId:'v1|123456789012|0',legacyItemId:'123456789012',title:'Synthetic Saga 1 Cover A',price:{value:'25.00',currency:'USD'},localizedAspects:[{name:'Issue Number',value:'1'},{name:'Grade',value:'9.8'}]}),{headers:{'content-type':'application/json'}});
};`,
);
const environment = {
  ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
  EBAY_CLIENT_ID: "synthetic-app",
  EBAY_CLIENT_SECRET: "synthetic-secret",
  EBAY_ENV: "sandbox",
};
async function accept(client) {
  assert.equal(client.getServerVersion()?.version, packageJson.version);
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), [
    "get_connection_status",
    "get_ebay_item",
    "search_ebay",
  ]);
  assert.equal(
    (await client.callTool({ name: "get_connection_status", arguments: {} })).structuredContent
      .provider_access,
    "not_checked",
  );
  assert.equal(
    (await client.callTool({ name: "get_connection_status", arguments: {} })).structuredContent
      .connector_version,
    packageJson.version,
  );
  const search = await client.callTool({
    name: "search_ebay",
    arguments: { q: "Saga 1 Cover A", limit: 1 },
  });
  assert.notEqual(search.isError, true);
  const row = search.structuredContent.items[0];
  assert.equal(row.price_basis, "asking_price");
  assert.equal(row.shipping_options[0].shipping_cost, "4.50");
  const item = await client.callTool({
    name: "get_ebay_item",
    arguments: { item_id: row.item_id },
  });
  assert.notEqual(item.isError, true);
  assert.equal(item.structuredContent.item_id, row.item_id);
  assert.deepEqual(item.structuredContent.aspects["Issue Number"], ["1"]);
  assert.equal((await client.callTool({ name: "list_orders", arguments: {} })).isError, true);
}
let child;
let stdio;
try {
  stdio = new Client({ name: "clean-stdio", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", pathToFileURL(fixture).href, cli, "--stdio"],
    env: environment,
    stderr: "pipe",
  });
  let stdioErrors = "";
  transport.stderr?.on("data", (c) => {
    stdioErrors += c.toString();
  });
  await stdio.connect(transport);
  await accept(stdio);
  await stdio.close();
  stdio = undefined;
  assert.equal(stdioErrors, "");
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  const base = `http://127.0.0.1:${port}`;
  const token = "synthetic-" + "a".repeat(43);
  child = spawn(process.execPath, ["--import", pathToFileURL(fixture).href, cli, "--http"], {
    env: {
      ...environment,
      PORT: String(port),
      PUBLIC_BASE_URL: base,
      MCP_TEST_TOKEN_SHA256: createHash("sha256").update(token).digest("hex"),
      MCP_TEST_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (c) => {
    stdout += c.toString();
  });
  child.stderr.on("data", (c) => {
    stderr += c.toString();
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + "/health")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(ready, true, "HTTP CLI did not become healthy");
  assert.equal((await fetch(base + "/mcp", { method: "POST" })).status, 401);
  const http = new Client({ name: "clean-http", version: "1" });
  const httpTransport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  try {
    await http.connect(httpTransport);
    assert.ok(httpTransport.sessionId);
    await accept(http);
    await httpTransport.terminateSession();
  } finally {
    await http.close();
  }
  child.kill();
  await once(child, "exit");
  child = undefined;
  assert.equal(stdout, "");
  assert.equal(stderr, "");
  const receipt = {
    passed: true,
    package: packageJson.name,
    version: packageJson.version,
    provider: "synthetic_only",
    network_to_ebay: false,
    private_checkout_required: false,
    stdio: "PASS: CLI, protocol, no listener, linked search/item",
    http: "PASS: CLI, auth, session, linked search/item",
    seller_tool_rejection: "PASS",
    secret_free_stdout_stderr: "PASS",
    live_azure_changes: false,
  };
  if (process.argv[3])
    await writeFile(resolve(process.argv[3]), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await stdio?.close();
  if (child) {
    child.kill();
    await once(child, "exit");
  }
  assert.ok(
    resolve(temp).startsWith(resolve(tmpdir()) + "/") ||
      resolve(temp).startsWith(resolve(tmpdir()) + "\\"),
  );
  await rm(temp, { recursive: true, force: true });
}
