/**
 * Activation seam: the fixed Google origins must honor the host's explicit
 * SUBSCRIPTION_PROXY_URL opt-in (core >= the seam) while staying fully direct
 * on cores that predate it. The plugin wraps the host dispatcher once — the
 * data plane (lockUpstream), the auth/login exchange and model/project
 * discovery all resolve through the SAME upstreamDispatcher, so asserting
 * lockUpstream pins the shared contract.
 */
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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

describe("gemini-oauth activation — recovery probe account state", () => {
  /** Seed a credential file so requireService() has an account to report on. */
  async function seedAccount(configDir: string, account: Record<string, unknown>): Promise<void> {
    await mkdir(configDir, { recursive: true });
    // 0600 is not cosmetic: the store refuses to read a credential file that is
    // group/other accessible, which would silently look like "no account".
    await writeFile(join(configDir, "gemini-oauth-credentials.json"), JSON.stringify({
      version: 2, kind: "antigravity",
      account: { email: "a@b.invalid", refreshToken: "1//fixture", projectId: "p", tier: "standard-tier",
        importedAt: "2026-01-01T00:00:00.000Z", lastError: null, cooldownUntil: null, ...account },
      rawModelIds: ["gemini-4-argon"],
    }), { mode: 0o600 });
  }

  it("parks an account whose login expired, even after the cooldown lapsed — no real request", async () => {
    // The reported symptom: a dead token kept the model in rotation and the
    // probe spent a real request on it every interval. Level 1 must veto it.
    const configDir = mkdtempSync(join(tmpdir(), "gemini-probe-reauth-"));
    await seedAccount(configDir, {
      lastError: { code: "gemini_oauth_reauth_required" },
      cooldownUntil: Date.now() - 60_000, // already expired
    });
    const dispatchRequest = vi.fn(async () => new Response("{}", { status: 200 }));
    const { ctx, registered } = fakeCtx({
      configDir,
      readConfig: async () => ({}), readRawConfig: async () => ({}),
      writeConfig: async () => {}, reloadRuntime: async () => {},
      getDirectDispatcher: () => DIRECT,
      dispatchRequest,
    });
    await activate(ctx);

    const verdict = await registered.runtime.probeAccountState();
    expect(verdict.available).toBe(false);
    expect(verdict.reason).toBe("reauth_required");
    // Level 1 must veto WITHOUT a network call — the whole point is that
    // discovering a dead token costs nothing.
    expect(dispatchRequest).not.toHaveBeenCalled();
  });

  it("reports available for a healthy account so level 2 can prove reachability", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "gemini-probe-healthy-"));
    await seedAccount(configDir, { lastError: null, cooldownUntil: null });
    const { ctx, registered } = fakeCtx({
      configDir,
      readConfig: async () => ({}), readRawConfig: async () => ({}),
      writeConfig: async () => {}, reloadRuntime: async () => {},
      getDirectDispatcher: () => DIRECT,
    });
    await activate(ctx);

    const verdict = await registered.runtime.probeAccountState();
    expect(verdict.available).toBe(true);
  });

  it("surfaces the reset epoch for a quota-parked account", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "gemini-probe-quota-"));
    const resetsAt = Date.now() + 30 * 60_000;
    await seedAccount(configDir, {
      lastError: { code: "gemini_oauth_quota_exceeded" },
      cooldownUntil: resetsAt,
    });
    const { ctx, registered } = fakeCtx({
      configDir,
      readConfig: async () => ({}), readRawConfig: async () => ({}),
      writeConfig: async () => {}, reloadRuntime: async () => {},
      getDirectDispatcher: () => DIRECT,
    });
    await activate(ctx);

    const verdict = await registered.runtime.probeAccountState();
    expect(verdict.available).toBe(false);
    expect(verdict.reason).toBe("account_cooling");
    expect(verdict.parkedUntil).toBe(resetsAt);
  });
});

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
