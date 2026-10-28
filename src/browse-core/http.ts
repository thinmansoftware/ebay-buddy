import { randomUUID } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { testAccess, requestBounds } from "../security/test-access.js";
import { browseOAuthAccess } from "../security/browse-oauth.js";
import { requestCancellation } from "../security/request-scope.js";
import { createBrowseServer } from "./mcp.js";
import type { BrowseContext } from "./runtime.js";

/** Existing lab defaults to stateless; the public CLI opts into bounded session cancellation. */
export function createBrowseApp(
  ctx: BrowseContext,
  options: { sessionCancellation?: boolean } = {},
): Express {
  const app = express();
  app.disable("x-powered-by");
  type Entry = {
    mcp: ReturnType<typeof createBrowseServer>;
    transport: StreamableHTTPServerTransport;
    id?: string;
    timer?: ReturnType<typeof setTimeout>;
    principal?: string;
  };
  const sessions = new Map<string, Entry>();
  let initializing = 0;
  function close(entry: Entry) {
    clearTimeout(entry.timer);
    if (entry.id) sessions.delete(entry.id);
    void Promise.allSettled([entry.transport.close(), entry.mcp.close()]);
  }
  app.locals.closeBrowseSessions = () => {
    for (const entry of sessions.values()) close(entry);
  };
  function makeEntry(stateful: boolean, principal?: string): Entry {
    const mcp = createBrowseServer(ctx);
    const entry: Entry = { mcp, transport: undefined!, principal };
    entry.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: stateful ? randomUUID : undefined,
      enableJsonResponse: true,
      ...(stateful
        ? {
            onsessioninitialized: (id: string) => {
              entry.id = id;
              sessions.set(id, entry);
              entry.timer = setTimeout(
                () => close(entry),
                Math.max(1, Math.min(600000, ctx.config.testExpiresAt - Date.now())),
              );
              entry.timer.unref();
            },
          }
        : {}),
    });
    return entry;
  }
  app.get("/health", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  });
  if (ctx.config.authMode === "oauth") {
    const oauth = ctx.config.oauth;
    if (!oauth) throw new Error("OAuth configuration is required.");
    app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json({resource:oauth.resource,authorization_servers:[oauth.issuer],scopes_supported:[oauth.scope],bearer_methods_supported:["header"]});
    });
    app.use("/mcp", browseOAuthAccess(oauth), requestBounds(ctx.config));
  } else {
    app.use("/mcp", testAccess(ctx.config));
  }
  app.post("/mcp", express.json({ limit: "64kb" }), async (req, res, next) => {
    if (Array.isArray(req.body)) {
      res.status(400).json({ error: "Batch requests are not accepted." });
      return;
    }
    const stateful = Boolean(options.sessionCancellation);
    const header = req.headers["mcp-session-id"];
    const principal = req.auth?.extra?.principal as string | undefined;
    let entry: Entry;
    let created = false;
    if (stateful && header) {
      if (typeof header !== "string" || header.length > 128 || !sessions.has(header)) {
        res.status(404).json({ error: "Session unavailable; initialize again." });
        return;
      }
      entry = sessions.get(header)!;
      if (ctx.config.authMode === "oauth" && (!principal || entry.principal !== principal)) {
        res.status(404).json({ error: "Session unavailable; initialize again." });
        return;
      }
    } else {
      if (stateful && !isInitializeRequest(req.body)) {
        res.status(400).json({ error: "Initialize a session first." });
        return;
      }
      if (stateful && sessions.size + initializing >= 16) {
        res.setHeader("Retry-After", "600");
        res.status(429).json({ error: "Session limit reached." });
        return;
      }
      entry = makeEntry(stateful, principal);
      created = true;
      if (stateful) initializing++;
    }
    const cancellation = new AbortController();
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      cancellation.abort();
      if (!stateful) close(entry);
    };
    res.once("finish", cleanup);
    res.once("close", cleanup);
    try {
      await requestCancellation.run(cancellation.signal, async () => {
        if (created) await entry.mcp.connect(entry.transport);
        await entry.transport.handleRequest(req, res, req.body);
      });
    } catch (error) {
      cleanup();
      if (created && stateful) close(entry);
      next(error);
    } finally {
      if (created && stateful) {
        initializing--;
        if (!entry.id) close(entry);
      }
    }
  });
  app.delete("/mcp", (req, res) => {
    const id = req.headers["mcp-session-id"];
    if (options.sessionCancellation && typeof id === "string" && sessions.has(id)) {
      if (ctx.config.authMode === "oauth" && sessions.get(id)!.principal !== req.auth?.extra?.principal) {
        res.status(404).json({ error: "Session unavailable; initialize again." });
        return;
      }
      close(sessions.get(id)!);
      res.status(204).end();
      return;
    }
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Use POST." });
  });
  app.all("/mcp", (_req, res) => {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Use POST." });
  });
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found." });
  });
  app.use((error: unknown, _req: Request, res: Response, _next: () => void) => {
    const status =
      error &&
      typeof error === "object" &&
      "status" in error &&
      [400, 413].includes(Number(error.status))
        ? Number(error.status)
        : 500;
    if (!res.headersSent)
      res
        .status(status)
        .json({ error: status === 500 ? "Request failed." : "Invalid request body." });
  });
  return app;
}
