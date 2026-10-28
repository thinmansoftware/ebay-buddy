import type { EbayClient } from "../ebay/client.js";
import { ConfigError, EbayApiError } from "../ebay/errors.js";
import { SCOPE_API, browsePaths } from "../ebay/browse-endpoints.js";
import { requestCancellation } from "../security/request-scope.js";

type Mint = {
  controller: AbortController;
  promise: Promise<string>;
  waiters: number;
  finished: boolean;
};

/** Application credentials only. No seller consent, refresh tokens or persistence. */
export class AppAuth {
  private cached?: { token: string; expiresAt: number };
  private inflight?: Mint;
  constructor(
    private readonly config: { clientId: string; clientSecret: string; hasAppCredentials: boolean },
    private readonly client: EbayClient,
  ) {}
  requireAppCredentials(): void {
    if (!this.config.hasAppCredentials)
      throw new ConfigError("Configure your own EBAY_CLIENT_ID and EBAY_CLIENT_SECRET.");
  }
  async getAppToken(): Promise<string> {
    this.requireAppCredentials();
    const incoming = requestCancellation.getStore();
    if (incoming?.aborted) throw new EbayApiError("Request cancelled.", 499);
    if (this.cached && this.cached.expiresAt > Date.now() + 60000) return this.cached.token;
    if (!this.inflight) {
      const operation: Mint = {
        controller: new AbortController(),
        promise: Promise.resolve(""),
        waiters: 0,
        finished: false,
      };
      this.inflight = operation;
      // The mint belongs to its waiters collectively, not to the first caller.
      operation.promise = requestCancellation
        .run(operation.controller.signal, async () => {
          const token = await this.mintToken();
          if (operation.controller.signal.aborted)
            throw new EbayApiError("Request cancelled.", 499);
          if (this.inflight === operation) this.cached = token;
          return token.token;
        })
        .finally(() => {
          operation.finished = true;
          if (this.inflight === operation) this.inflight = undefined;
        });
    }
    const operation = this.inflight;
    operation.waiters++;
    let cancel: (() => void) | undefined;
    try {
      if (!incoming) return await operation.promise;
      const cancelled = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(new EbayApiError("Request cancelled.", 499));
        incoming.addEventListener("abort", cancel, { once: true });
        if (incoming.aborted) cancel();
      });
      return await Promise.race([operation.promise, cancelled]);
    } finally {
      if (cancel) incoming?.removeEventListener("abort", cancel);
      operation.waiters--;
      if (!operation.finished && operation.waiters === 0) {
        if (this.inflight === operation) this.inflight = undefined;
        operation.controller.abort();
      }
    }
  }
  private async mintToken(): Promise<{ token: string; expiresAt: number }> {
    const response = await this.client.request(browsePaths.oauthToken, {
      method: "POST",
      form: new URLSearchParams({ grant_type: "client_credentials", scope: SCOPE_API }),
      marketplaceHeader: false,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`,
      },
    });
    const body = response.json as { access_token?: unknown; expires_in?: unknown } | null;
    if (
      !body ||
      typeof body.access_token !== "string" ||
      !body.access_token ||
      typeof body.expires_in !== "number" ||
      !Number.isFinite(body.expires_in) ||
      body.expires_in <= 0
    )
      throw new EbayApiError("Invalid application token response.", 502);
    return { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  }
}
