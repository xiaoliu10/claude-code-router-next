import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKBUDDY_SITES,
  credentialHeaders,
  conversationHeaders,
  parseWorkBuddyModels,
  parseWorkBuddySource,
  renewWorkBuddyFromDesktop,
  workBuddyChatUrl,
  workBuddyConfigUrl,
  workBuddyImagesDropped,
  workBuddyNeedsRenewal,
  workBuddySite,
  type WorkBuddyCredential,
} from "../services/workbuddy";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.unstubAllGlobals(); });

const CRED: WorkBuddyCredential = {
  version: 1, kind: "workbuddy", uid: "u-1", displayName: "Nick", domain: "",
  enterpriseId: "", accessToken: "old-token", expiresAt: Date.now() + 60_000,
  tokenType: "Bearer",
  importedAt: "2026-10-19T00:00:00.000Z", source: "desktop",
};

const loginBody = (account: Record<string, any> = {}, auth: Record<string, any> = {}) => ({
  account: { uid: "u-1", nickname: "Nick", enterpriseId: "ent-1", ...account },
  auth: { accessToken: "old-token", refreshToken: "r", expiresAt: Date.now() + 60_000, ...auth },
});

describe("WorkBuddy dual-site support (contract §14.1)", () => {
  it("defines both builds with their own origin, login file and domain allowlist", () => {
    expect(WORKBUDDY_SITES.workbuddy.origin).toBe("https://copilot.tencent.com");
    expect(WORKBUDDY_SITES.workbuddy.authId).toBe("workbuddy-desktop");
    expect(WORKBUDDY_SITES.workbuddy.domains).toEqual(["copilot.tencent.com", "www.codebuddy.cn"]);
    expect(WORKBUDDY_SITES["workbuddy-ai"].origin).toBe("https://www.workbuddy.ai");
    expect(WORKBUDDY_SITES["workbuddy-ai"].authId).toBe("workbuddy-desktop-ai");
    expect(WORKBUDDY_SITES["workbuddy-ai"].domains).toEqual(["www.workbuddy.ai", "www.codebuddy.ai"]);
    expect(workBuddyChatUrl(workBuddySite("workbuddy-ai"))).toBe("https://www.workbuddy.ai/v2/chat/completions");
    expect(workBuddyConfigUrl(workBuddySite("workbuddy-ai"))).toBe("https://www.workbuddy.ai/v3/config");
  });

  it("sends X-Agent-Type only for the international build", () => {
    const cn = credentialHeaders({ ...CRED, kind: "workbuddy" });
    const ai = credentialHeaders({ ...CRED, kind: "workbuddy-ai", domain: "www.workbuddy.ai" });
    expect(cn["X-Agent-Type"]).toBeUndefined();
    expect(ai["X-Agent-Type"]).toBe("main");
    expect(ai["X-Domain"]).toBe("www.workbuddy.ai");
    // Everything else is identical (magpie sign()).
    for (const key of ["Authorization", "X-User-Id", "X-Product", "X-IDE-Type", "User-Agent", "X-IDE-Version"]) {
      expect(ai[key]).toBe(cn[key]);
    }
  });

  it("parses an international login file with the international site's domain rules", () => {
    const ok = parseWorkBuddySource(JSON.stringify({
      account: { uid: "u-9", nickname: "Iris" },
      auth: { accessToken: "ai-token", expiresAt: 0, domain: "www.workbuddy.ai" },
    }), 1000, "workbuddy-ai");
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.credential.kind).toBe("workbuddy-ai");
    expect(ok.credential.domain).toBe("www.workbuddy.ai");
    // A CN domain in an international file is invalid, not silently accepted.
    const bad = parseWorkBuddySource(JSON.stringify({
      account: { uid: "u-9" }, auth: { accessToken: "ai", domain: "copilot.tencent.com" },
    }), 1000, "workbuddy-ai");
    expect(bad).toEqual({ ok: false, reason: "source_invalid", site: "workbuddy-ai" });
  });

  it("marks international GLM models as image-dropping whatever /v3/config says", () => {
    const env = { code: 0, data: {
      agents: [{ name: "cli", models: ["glm-5.3", "gpt-5.5"] }],
      models: [
        { id: "glm-5.3", name: "GLM", supportsImages: true },
        { id: "gpt-5.5", name: "GPT", supportsImages: true },
      ],
    } };
    const cn = parseWorkBuddyModels(env, "workbuddy");
    const ai = parseWorkBuddyModels(env, "workbuddy-ai");
    expect(cn.find((m) => m.id === "glm-5.3")?.images).toBe(true);
    // The international build's config lies: the server strips GLM images (magpie P:L86-101).
    expect(ai.find((m) => m.id === "glm-5.3")?.images).toBe(false);
    expect(ai.find((m) => m.id === "gpt-5.5")?.images).toBe(true);
    expect(workBuddyImagesDropped("workbuddy-ai", "glm-5.2")).toBe(true);
    expect(workBuddyImagesDropped("workbuddy", "glm-5.3")).toBe(false);
  });

  it("detects a sealed marker by truthiness, not by the literal 1", () => {
    for (const marker of [1, "1", true, {}]) {
      const parsed = parseWorkBuddySource(JSON.stringify({
        account: { uid: "u-1" }, auth: { accessToken: { $wbEncrypted: marker } },
      }), 1000, "workbuddy");
      expect(parsed).toEqual({ ok: false, reason: "sealed", site: "workbuddy" });
    }
    const refreshSealed = parseWorkBuddySource(JSON.stringify({
      account: { uid: "u-1" }, auth: { accessToken: "a", refreshToken: { $wbEncrypted: 1 } },
    }), 1000, "workbuddy");
    expect(refreshSealed).toEqual({ ok: false, reason: "sealed", site: "workbuddy" });
  });
});

describe("WorkBuddy on-demand renewal (contract §14.3)", () => {
  it("renews only within the lead window and only from a newer desktop token", async () => {
    expect(workBuddyNeedsRenewal({ ...CRED, expiresAt: Date.now() + 10 * 60_000 })).toBe(false);
    expect(workBuddyNeedsRenewal({ ...CRED, expiresAt: Date.now() + 60_000 })).toBe(true);
    expect(workBuddyNeedsRenewal({ ...CRED, expiresAt: 0 })).toBe(false);
  });

  it("uses the desktop file's newer token in memory and never writes back", async () => {
    // Same account as the credential (the desktop file's site/uid/enterprise must match; §14.3 rule 2).
    // The 60s renewal cache is keyed on site+uid+enterprise+importedAt+token (rule 5).
    const fresh = loginBody({ uid: "u-renew", enterpriseId: "" }, { accessToken: "fresh-token", refreshToken: "r2", expiresAt: Date.now() + 3 * 60 * 60_000 });
    const readSource = vi.fn(() => parseWorkBuddySource(JSON.stringify(fresh), Date.now(), "workbuddy"));
    const renewed = await renewWorkBuddyFromDesktop({ ...CRED, uid: "u-renew" }, readSource);
    expect(renewed.accessToken).toBe("fresh-token");
    expect(renewed.expiresAt).toBeGreaterThan(CRED.expiresAt);
    // The original snapshot object is untouched (callers hold their own copy).
    expect(CRED.accessToken).toBe("old-token");
  });

  it("does not reuse cached credentials after an import replaces the snapshot", async () => {
    const c = { ...CRED, uid: "cache-generation" };
    await renewWorkBuddyFromDesktop(c, () => ({ ok: true, credential: { ...c, accessToken: "newer", expiresAt: c.expiresAt + 3600000 } }));
    const replacement = { ...c, accessToken: "reimported", importedAt: "new-import" };
    const read = vi.fn(() => ({ ok: false as const, reason: "source_missing" as const }));
    expect((await renewWorkBuddyFromDesktop(replacement, read)).accessToken).toBe("reimported");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("rejects a renewed token from a different enterprise", async () => {
    const c = { ...CRED, uid: "enterprise-guard", enterpriseId: "ours" };
    const renewed = await renewWorkBuddyFromDesktop(c, () => ({ ok: true, credential: { ...c, enterpriseId: "theirs", accessToken: "wrong-team", expiresAt: c.expiresAt + 3600000 } }));
    expect(renewed.accessToken).toBe(c.accessToken);
  });

  it("keeps the snapshot when the desktop file has no newer token", async () => {
    const same = await renewWorkBuddyFromDesktop(
      { ...CRED, uid: "u-stale", enterpriseId: "ent-1", expiresAt: Date.now() + 60_000 },
      () => parseWorkBuddySource(JSON.stringify(loginBody({ uid: "u-stale" }, { expiresAt: CRED.expiresAt - 1000 })), Date.now(), "workbuddy")
    );
    expect(same.accessToken).toBe("old-token");
  });

  it("keeps the snapshot when the desktop file is unreadable or belongs to another site/account", async () => {
    const broken = await renewWorkBuddyFromDesktop({ ...CRED, uid: "u-broken" }, () => { throw new Error("EACCES"); });
    expect(broken.accessToken).toBe("old-token");
    const otherSite = await renewWorkBuddyFromDesktop({ ...CRED, uid: "u-othersite" }, () => ({ ok: true, credential: { ...CRED, uid: "u-othersite", kind: "workbuddy-ai", accessToken: "ai", expiresAt: Date.now() + 9_000_000 } }));
    expect(otherSite.accessToken).toBe("old-token");
    const otherUser = await renewWorkBuddyFromDesktop({ ...CRED, uid: "u-mine" }, () => ({ ok: true, credential: { ...CRED, uid: "someone-else", accessToken: "theirs", expiresAt: Date.now() + 9_000_000 } }));
    expect(otherUser.accessToken).toBe("old-token");
  });

  it("never spends the stored refresh token (no refresh endpoint in the module's request paths)", async () => {
    const fetchSpy = vi.fn(async () => { throw new Error("upstream must not be called"); });
    vi.stubGlobal("fetch", fetchSpy);
    const renewed = await renewWorkBuddyFromDesktop({ ...CRED, uid: "u-nofetch" }, () => ({ ok: false, reason: "source_missing" }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(renewed.accessToken).toBe("old-token");
  });

  it("shares one in-flight read per site+account", async () => {
    let calls = 0;
    const readSource = () => { calls += 1; return { ok: false as const, reason: "source_missing" as const }; };
    const [a, b] = await Promise.all([
      renewWorkBuddyFromDesktop({ ...CRED, uid: "shared" }, readSource),
      renewWorkBuddyFromDesktop({ ...CRED, uid: "shared" }, readSource),
    ]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });
});

describe("WorkBuddy conversation ids (contract §14.3c)", () => {
  it("always sends a turn id, even with no derivable turn key", () => {
    const headers = conversationHeaders({
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "" }],
    });
    // No conversation/turn key is derivable from an empty user message, yet the turn id
    // must still be a fresh random 32-hex so WorkBuddy usage attribution works (P:L447-451).
    expect(headers["X-Conversation-Request-ID"]).toMatch(/^[0-9a-f]{32}$/);
    expect(headers["X-Conversation-Message-ID"]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("derives a stable turn id for a normal user turn", () => {
    const body = { messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }, { role: "user", content: "again" }] };
    const first = conversationHeaders(body);
    const second = conversationHeaders(body);
    expect(first["X-Conversation-Request-ID"]).toMatch(/^[0-9a-f]{32}$/);
    expect(first["X-Conversation-Request-ID"]).toBe(second["X-Conversation-Request-ID"]);
    expect(first["X-Conversation-Message-ID"]).not.toBe(second["X-Conversation-Message-ID"]);
  });
});
