import { AsyncLocalStorage } from "node:async_hooks";

/** Carries a probe's budget through the engine's existing injected fetch seam. */
export const cursorTransportSignal = new AsyncLocalStorage<AbortSignal>();
