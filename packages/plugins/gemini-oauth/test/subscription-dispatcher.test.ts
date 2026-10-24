/**
 * Activation seam: the fixed Google origins must honor the host's explicit
 * SUBSCRIPTION_PROXY_URL opt-in (core >= the seam) while staying fully direct
 * on cores that predate it. The plugin wraps the host dispatcher once — the
 * data plane (lockUpstream), the auth/login exchange and model/project
 * discovery all resolve through the SAME upstreamDispatcher, so asserting
 * lockUpstream pins the shared contract.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GEMINI_OAUTH_DATA_PLANE, GEMINI_OAUTH_SSE_PATH } from "../src/protocol";
import { activate } from "../src/plugin";

const DIRECT = { marker: "direct-agent" };
const SUBSCRIPTION = { marker: "subscription-proxy-agent" };

function fakeCtx(host: Record<string, unknown>) {
  const registered: { runtime?: any } = {};
  const ctx: any = {
    manifest: { name: "gemini-oauth", version: "0", coreApi: "1" },
    log: { info() {}, warn() {}, error() {} },
    host,
    registerTransformer: () => {},
    registerManagedRuntime: (rt: any) => { registered.runtime = rt; },
    registerAdminRoutes: () => {},
    registerConfigProtector: () => {},
    registerUiCard: () => {},
    registerLocales: () => {},
  };
  return { ctx, registered };
}

describe("gemini-oauth activation — subscription dispatcher seam", () => {
  it("lockUpstream uses the host subscription dispatcher when the core provides it", async () => {
    const { ctx, registered } = fakeCtx({
      configDir: mkdtempSync(join(tmpdir(), "gemini-sub-dispatcher-")),
      readConfig: async () => ({}),
      readRawConfig: async () => ({}),
      writeConfig: async () => {},
      reloadRuntime: async () => {},
      getDirectDispatcher: () => DIRECT,
      getSubscriptionDispatcher: () => SUBSCRIPTION,
    });
    await activate(ctx);

    const config: any = { url: "https://evil.example.com", redirect: "follow" };
    await registered.runtime.lockUpstream(config, {} as any);
    expect(config.url).toBe(new URL(GEMINI_OAUTH_SSE_PATH, GEMINI_OAUTH_DATA_PLANE).toString());
    expect(config.redirect).toBe("error");
    expect(config.dispatcher).toBe(SUBSCRIPTION);
  });

  it("falls back to the direct dispatcher on cores predating the seam", async () => {
    const { ctx, registered } = fakeCtx({
      configDir: mkdtempSync(join(tmpdir(), "gemini-sub-dispatcher-")),
      readConfig: async () => ({}),
      readRawConfig: async () => ({}),
      writeConfig: async () => {},
      reloadRuntime: async () => {},
      getDirectDispatcher: () => DIRECT,
    });
    await activate(ctx);

    const config: any = {};
    await registered.runtime.lockUpstream(config, {} as any);
    expect(config.dispatcher).toBe(DIRECT);
  });
});
