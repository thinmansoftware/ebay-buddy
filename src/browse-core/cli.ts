#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBrowseContext, loadBrowseConfig } from "./runtime.js";
import { createBrowseServer } from "./mcp.js";
import { createBrowseApp } from "./http.js";

try {
  if (
    process.argv.length > 3 ||
    (process.argv[2] && !["--stdio", "--http"].includes(process.argv[2]))
  )
    throw new Error("Invalid arguments");
  const mode = process.argv[2] === "--http" ? "http" : "stdio";
  const config = loadBrowseConfig(process.env, mode);
  const ctx = createBrowseContext(config);
  if (mode === "stdio") {
    const server = createBrowseServer(ctx);
    await server.connect(new StdioServerTransport());
  } else {
    const app = createBrowseApp(ctx, { sessionCancellation: true });
    const listener = app.listen(
      config.port,
      new URL(config.publicBaseUrl).protocol === "https:" ? "0.0.0.0" : "127.0.0.1",
    );
    listener.on("error", () => {
      console.error("Browse HTTP listener failed.");
      process.exitCode = 1;
    });
    const close = () => {
      app.locals.closeBrowseSessions();
      listener.close();
      listener.closeAllConnections();
    };
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
  }
} catch {
  console.error("Browse connector could not start. Check configuration and transport.");
  process.exitCode = 1;
}
