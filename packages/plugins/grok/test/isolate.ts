import { beforeEach, afterEach, vi } from "vitest";
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network: Grok fixtures must provide a fetch implementation"); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
