import { AsyncLocalStorage } from "node:async_hooks";

/** Carries HTTP cancellation through existing OAuth/Browse calls without global mutable request state. */
export const requestCancellation = new AsyncLocalStorage<AbortSignal>();
