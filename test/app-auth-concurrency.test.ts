import { afterEach, describe, expect, it, vi } from "vitest";
import { AppAuth } from "../src/browse-core/app-auth.js";
import { EbayClient, type FetchLike } from "../src/ebay/client.js";
import { createBrowseContext, loadBrowseConfig } from "../src/browse-core/runtime.js";
import { requestCancellation } from "../src/security/request-scope.js";

afterEach(() => vi.restoreAllMocks());
const response = (label: string) =>
  new Response(JSON.stringify({ access_token: label, expires_in: 7200 }));
function setup(fetchImpl: FetchLike) {
  const config = loadBrowseConfig(
    {
      EBAY_CLIENT_ID: "synthetic-app",
      EBAY_CLIENT_SECRET: "synthetic-secret",
      EBAY_REQUEST_TIMEOUT_MS: "1000",
    },
    "stdio",
  );
  return {
    config,
    auth: new AppAuth(config, new EbayClient(config, { fetchImpl, maxRetries: 0 })),
  };
}
describe("shared application-token mint", () => {
  it("coalesces concurrent calls and renews once after cached expiry", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let calls = 0;
    const { auth } = setup(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return response("synthetic-result");
    });
    const first = await Promise.all([auth.getAppToken(), auth.getAppToken(), auth.getAppToken()]);
    expect(first.every((value) => value === first[0])).toBe(true);
    expect(calls).toBe(1);
    now += 7200000;
    await Promise.all([auth.getAppToken(), auth.getAppToken()]);
    expect(calls).toBe(2);
  });
  it("clears a failed shared mint and permits a bounded explicit retry", async () => {
    let calls = 0,
      fail = true;
    const { auth } = setup(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return fail ? new Response("{}", { status: 503 }) : response("synthetic-retry");
    });
    const failures = await Promise.allSettled([auth.getAppToken(), auth.getAppToken()]);
    expect(failures.every((r) => r.status === "rejected")).toBe(true);
    expect(calls).toBe(1);
    fail = false;
    await auth.getAppToken();
    expect(calls).toBe(2);
  });
  it("one cancelled waiter cannot abort another waiter's shared mint", async () => {
    let calls = 0,
      aborted = 0;
    const pending: ((value: Response) => void)[] = [];
    const { auth } = setup(async (_url, init) => {
      calls++;
      init?.signal?.addEventListener("abort", () => aborted++);
      return new Promise((resolve) => pending.push(resolve));
    });
    const a = new AbortController(),
      b = new AbortController();
    const first = requestCancellation.run(a.signal, () => auth.getAppToken());
    const second = requestCancellation.run(b.signal, () => auth.getAppToken());
    const firstOutcome = Promise.allSettled([first]);
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    a.abort();
    await firstOutcome;
    for (const resolve of pending) resolve(response("synthetic-shared"));
    await second;
    expect(calls).toBe(1);
    expect(aborted).toBe(0);
  });
  it("aborts abandoned work and prevents its late result overwriting a new mint", async () => {
    const pending: ((value: Response) => void)[] = [];
    let aborted = 0;
    const { auth } = setup(async (_url, init) => {
      init?.signal?.addEventListener("abort", () => aborted++);
      return new Promise((resolve) => pending.push(resolve));
    });
    const controller = new AbortController();
    const first = Promise.allSettled([
      requestCancellation.run(controller.signal, () => auth.getAppToken()),
    ]);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    controller.abort();
    await first;
    const next = auth.getAppToken();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1](response("synthetic-new"));
    await next;
    pending[0](response("synthetic-old"));
    await new Promise((r) => setTimeout(r, 5));
    expect((await auth.getAppToken()) === "synthetic-new").toBe(true);
    expect(aborted).toBe(1);
  });
  it("keeps separate application instances and their credentials independent", async () => {
    let first = 0,
      second = 0;
    const a = setup(async () => {
      first++;
      return response("synthetic-one");
    });
    const b = setup(async () => {
      second++;
      return response("synthetic-two");
    });
    const values = await Promise.all([a.auth.getAppToken(), b.auth.getAppToken()]);
    expect(values[0] !== values[1]).toBe(true);
    expect(first).toBe(1);
    expect(second).toBe(1);
  });
  it("three tool consumers share one backend token mint", async () => {
    let tokens = 0,
      searches = 0;
    const { config } = setup(async () => response("unused"));
    const ctx = createBrowseContext(config, {
      fetchImpl: async (url) => {
        if (url.includes("/identity/")) {
          tokens++;
          await new Promise((r) => setTimeout(r, 10));
          return response("synthetic-backend");
        }
        searches++;
        return new Response('{"total":0,"itemSummaries":[]}');
      },
    });
    await Promise.all(
      Array.from({ length: 3 }, () => ctx.browse.search({ q: "synthetic", limit: 1 })),
    );
    expect(searches).toBe(3);
    expect(tokens).toBe(1);
  });
});
