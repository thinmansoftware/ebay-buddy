import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import type { BrowseConfig } from "../browse-core/config.js";

/** One short-lived test principal. Never use IP headers as identity or unbounded map keys. */
export function testAccess(
  config: Pick<
    BrowseConfig,
    "testTokenHash" | "testExpiresAt" | "publicBaseUrl" | "rateLimitPerMinute"
  >,
): RequestHandler {
  const digest = Buffer.from(config.testTokenHash, "hex");
  const bounds = requestBounds(config);
  return (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const authorization = req.headers.authorization ?? "";
    const match = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(authorization);
    const candidate = createHash("sha256")
      .update(match?.[1] ?? "")
      .digest();
    if (
      !match ||
      digest.length !== candidate.length ||
      !timingSafeEqual(digest, candidate) ||
      Date.now() >= config.testExpiresAt
    ) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="readonly-test"');
      res.status(401).json({ error: "Authentication required or test credential expired." });
      return;
    }
    bounds(req, res, next);
  };
}

/** Shared HTTP bounds; authentication remains a separate mandatory middleware. */
export function requestBounds(
  config: Pick<BrowseConfig, "publicBaseUrl" | "rateLimitPerMinute">,
): RequestHandler {
  const origin = new URL(config.publicBaseUrl).origin;
  const hostname = new URL(origin).hostname;
  let windowStart = Date.now();
  let requests = 0;
  let active = 0;
  return (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (Object.keys(req.query).length) {
      res.status(400).json({ error: "Query parameters are not accepted on this endpoint." });
      return;
    }
    let requestHostname = "";
    try {
      requestHostname = new URL("http://" + req.headers.host).hostname;
    } catch {
      /* deny below */
    }
    if (requestHostname !== hostname || (req.headers.origin && req.headers.origin !== origin)) {
      res.status(403).json({ error: "Origin or host is not allowed." });
      return;
    }
    if (Date.now() - windowStart >= 60_000) {
      windowStart = Date.now();
      requests = 0;
    }
    requests += 1;
    if (requests > config.rateLimitPerMinute || active >= 4) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "Test request limit reached." });
      return;
    }
    active += 1;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        active -= 1;
      }
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  };
}
