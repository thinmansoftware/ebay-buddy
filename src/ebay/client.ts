export type ClientConfig = {
  profile: "readonly-test" | "development";
  apiBase: string;
  marketplaceId: string;
  requestTimeoutMs: number;
};
import { EbayApiError, readEbayError } from "./errors.js";
import { setTimeout as delay } from "node:timers/promises";
import { requestCancellation } from "../security/request-scope.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type EbayRequest = {
  method?: string;
  token?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  form?: URLSearchParams;
  headers?: Record<string, string>;
  marketplaceId?: string;
  /** Identity token calls do not use the marketplace header. */
  marketplaceHeader?: boolean;
};

export type EbayResponse = {
  status: number;
  json: unknown;
  headers: Headers;
};

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class EbayClient {
  readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private activeWork = 0;

  constructor(
    private readonly config: ClientConfig,
    options: {
      fetchImpl?: FetchLike;
      sleep?: (ms: number) => Promise<void>;
      maxRetries?: number;
    } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options.maxRetries ?? 2;
  }

  async request(path: string, options: EbayRequest = {}): Promise<EbayResponse> {
    if (this.config.profile !== "readonly-test") return this.perform(path, options);
    const method = options.method ?? (options.form || options.body !== undefined ? "POST" : "GET");
    const browseRead =
      method === "GET" &&
      /^\/buy\/browse\/v1\/(item_summary\/search|item\/[A-Za-z0-9%|_-]+|item\/get_item_by_legacy_id)$/.test(
        path,
      );
    const appToken =
      method === "POST" &&
      path === "/identity/v1/oauth2/token" &&
      options.form?.get("grant_type") === "client_credentials";
    if (
      (!browseRead && !appToken) ||
      !["https://api.ebay.com", "https://api.sandbox.ebay.com"].includes(this.config.apiBase)
    ) {
      throw new EbayApiError("Endpoint is outside this read-only test.", 403);
    }
    const incoming = requestCancellation.getStore();
    if (incoming?.aborted) throw new EbayApiError("Request cancelled.", 499);
    if (this.activeWork >= 4) throw new EbayApiError("Provider work limit reached.", 429);
    const controller = new AbortController();
    let cancel: () => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => {
        reject(new EbayApiError("Request cancelled.", 499));
        controller.abort();
      };
      incoming?.addEventListener("abort", cancel, { once: true });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new EbayApiError("eBay request timed out.", 504));
        controller.abort();
      }, this.config.requestTimeoutMs);
    });
    this.activeWork++;
    // Hold the slot for real work, even when an HTTP caller disconnects or a deadline wins.
    const work = this.perform(path, options, controller.signal).finally(() => {
      this.activeWork--;
    });
    try {
      return await Promise.race([work, deadline, cancelled]);
    } finally {
      clearTimeout(timer);
      incoming?.removeEventListener("abort", cancel);
    }
  }

  private async perform(
    path: string,
    options: EbayRequest,
    signal?: AbortSignal,
  ): Promise<EbayResponse> {
    const url = new URL(path, this.config.apiBase);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }

    const headers = new Headers(options.headers);
    if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
    if (options.marketplaceHeader !== false) {
      headers.set("X-EBAY-C-MARKETPLACE-ID", options.marketplaceId ?? this.config.marketplaceId);
    }
    if (!headers.has("Accept")) headers.set("Accept", "application/json");

    let body: string | undefined;
    if (options.form) {
      body = options.form.toString();
      if (!headers.has("Content-Type")) {
        headers.set("Content-Type", "application/x-www-form-urlencoded");
      }
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    }

    const method = options.method ?? (body ? "POST" : "GET");
    let lastError: EbayApiError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (signal?.aborted) throw new EbayApiError("eBay request timed out.", 504);
      const response = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body,
        ...(signal ? { signal, redirect: "error" as const } : {}),
      });
      const retryable = RETRYABLE.has(response.status);
      if (retryable && attempt < this.maxRetries) {
        if (signal) {
          await response.body?.cancel();
          await delay(this.retryDelay(response, attempt), undefined, { signal });
        } else {
          await response.text().catch(() => undefined);
          await this.sleep(this.retryDelay(response, attempt));
        }
        continue;
      }

      const text = signal ? await boundedText(response, signal) : await response.text();
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text) as unknown;
        } catch {
          json = { message: text.slice(0, 500) };
        }
      }

      if (response.status >= 400) {
        const parsed = readEbayError(response.status, json);
        lastError = new EbayApiError(parsed.message, response.status, parsed.errorId);
        throw lastError;
      }

      return { status: response.status, json, headers: response.headers };
    }

    throw lastError ?? new EbayApiError("eBay request failed", 0);
  }

  private retryDelay(response: Response, attempt: number): number {
    const header = response.headers.get("retry-after");
    const seconds = header ? Number(header) : Number.NaN;
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 8000);
    return Math.min(200 * 2 ** attempt, 8000);
  }
}

async function boundedText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new EbayApiError("eBay request timed out.", 504);
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1_048_576) {
        cancel();
        throw new EbayApiError("eBay response exceeded the test size limit.", 502);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, length).toString("utf8");
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
