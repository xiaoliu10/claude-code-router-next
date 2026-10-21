import { describe, expect, it } from "vitest";
import {
  WORKBUDDY_CHAT_ORIGIN,
  WORKBUDDY_CHAT_UA,
  WORKBUDDY_CHAT_URL,
  WORKBUDDY_CONFIG_UA,
  WORKBUDDY_CONFIG_URL,
  WORKBUDDY_PROVIDER_NAME,
  classifyWorkBuddyError,
  conversationHeaders,
  credentialHeaders,
  isManagedWorkBuddy,
  lockWorkBuddyProvider,
  parseWorkBuddyModels,
  parseWorkBuddySource,
  protectWorkBuddyConfig,
  validDomain,
  workBuddyDesktopPath,
  workBuddySite,
  type WorkBuddyCredential,
} from "../services/workbuddy";

const CRED: WorkBuddyCredential = {
  version: 1,
  kind: "workbuddy",
  tokenType: "",
  uid: "u-1",
  displayName: "Nick",
  domain: "",
  enterpriseId: "",
  accessToken: "access-token",
  expiresAt: 0,
  importedAt: "2026-10-19T00:00:00.000Z",
  source: "desktop",
};

const source = (extra: Record<string, any> = {}) => JSON.stringify({
  account: { uid: "u-1", nickname: "Nick", enterpriseId: "ent-1" },
  auth: { accessToken: "a", refreshToken: "r", expiresAt: 0, refreshExpiresAt: 9999999999999, tokenType: "Bearer", ...extra },
});

describe("WorkBuddy constants", () => {
  it("locks the CN chat URL and distinguishes the two required user agents", () => {
    expect(WORKBUDDY_CHAT_URL).toBe("https://copilot.tencent.com/v2/chat/completions");
    expect(WORKBUDDY_CONFIG_URL).toBe("https://copilot.tencent.com/v3/config");
    expect(WORKBUDDY_CHAT_ORIGIN).toBe("https://copilot.tencent.com");
    expect(WORKBUDDY_CHAT_UA).toBe("WorkBuddy/5.5.6");
    expect(WORKBUDDY_CONFIG_UA).toBe("CLI/2.0.0 WorkBuddy/5.5.6");
    expect(WORKBUDDY_CONFIG_UA).not.toBe(WORKBUDDY_CHAT_UA);
    expect(WORKBUDDY_PROVIDER_NAME).toBe("workbuddy");
  });

  it("derives the desktop login path per platform, with no client-controlled input", () => {
    const CN = workBuddySite("workbuddy"), AI = workBuddySite("workbuddy-ai");
    expect(workBuddyDesktopPath(CN, "darwin", "/Users/x")).toBe("/Users/x/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info");
    expect(workBuddyDesktopPath(AI, "darwin", "/Users/x")).toBe("/Users/x/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop-ai.info");
    expect(workBuddyDesktopPath(CN, "win32", "C:\\Users\\x")).toBe("C:\\Users\\x/AppData/Local/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info");
    expect(workBuddyDesktopPath(CN, "linux", "/home/x")).toBe("/home/x/.local/share/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info");
  });
});

describe("workbuddy source parsing", () => {
  it("accepts a plain desktop login and drops unused refresh secrets", () => {
    const parsed = parseWorkBuddySource(source({ expiresIn: 600 }), 1000);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.credential.accessToken).toBe("a");
    expect(parsed.credential.expiresAt).toBe(601000);
    expect(parsed.credential.uid).toBe("u-1");
    expect(parsed.credential.displayName).toBe("Nick");
    expect(parsed.credential.enterpriseId).toBe("ent-1");
    // Stored for diagnostics; no request path may spend them (contract §14.3).
    expect((parsed.credential as any).refreshToken).toBeUndefined();
    expect((parsed.credential as any).refreshExpiresAt).toBeUndefined();
    expect(parsed.credential.tokenType).toBe("Bearer");
  });

  it("normalizes expiresAt ms over expiresIn seconds", () => {
    const parsed = parseWorkBuddySource(source({ expiresAt: 5000, expiresIn: 60 }), 1000);
    expect(parsed.ok && parsed.credential.expiresAt).toBe(5000);
  });

  it("treats an unknown expiry as zero instead of failing the import", () => {
    const parsed = parseWorkBuddySource(source({ expiresAt: "soon", expiresIn: "later" }), 1000);
    expect(parsed.ok && parsed.credential.expiresAt).toBe(0);
  });

  it("refuses sealed tokens", () => {
    const parsed = parseWorkBuddySource(JSON.stringify({
      account: { uid: "u-1" },
      auth: { accessToken: { $wbEncrypted: 1, envelope: "x" } },
    }), 1000);
    expect(parsed).toEqual({ ok: false, reason: "sealed", site: "workbuddy" });
  });

  it("refuses malformed payloads and missing uid", () => {
    expect(parseWorkBuddySource("not json", 1000)).toEqual({ ok: false, reason: "source_invalid", site: "workbuddy" });
    expect(parseWorkBuddySource(JSON.stringify({ account: {}, auth: { accessToken: "a" } }), 1000)).toEqual({ ok: false, reason: "source_invalid", site: "workbuddy" });
    expect(parseWorkBuddySource(source({ accessToken: 42 }), 1000)).toEqual({ ok: false, reason: "source_invalid", site: "workbuddy" });
    expect(parseWorkBuddySource(JSON.stringify({ account: { uid: "u-1", enterpriseId: 1 }, auth: { accessToken: "a" } }), 1000)).toEqual({ ok: false, reason: "source_invalid", site: "workbuddy" });
  });

  it("refuses a non-string phone number but falls back to uid for a nickname", () => {
    expect(parseWorkBuddySource(JSON.stringify({ account: { uid: "u-1", phoneNumber: 42 }, auth: { accessToken: "a" } }), 1000)).toEqual({ ok: false, reason: "source_invalid", site: "workbuddy" });
  });

  it("refuses control characters in the optional nickname", () => {
    const parsed = parseWorkBuddySource(JSON.stringify({ account: { uid: "u-1", nickname: "n\r\nX-Evil: 1" }, auth: { accessToken: "a" } }), 1000);
    expect(parsed).toEqual({ ok: false, reason: "source_invalid", site: "workbuddy" });
  });

  it("rejects header-injecting CRLF in domain/uid", () => {
    expect(parseWorkBuddySource(source({ domain: "copilot.tencent.com\r\nX-Evil: 1" }), 1000).ok).toBe(false);
    expect(parseWorkBuddySource(JSON.stringify({ account: { uid: "u-1\r\nX-Evil: 1" }, auth: { accessToken: "a" } }), 1000).ok).toBe(false);
  });

  it("rejects an oversized source file", () => {
    expect(parseWorkBuddySource(JSON.stringify({
      account: { uid: "u-1" },
      auth: { accessToken: "a", pad: "x".repeat(1024 * 1024) },
    }), 1000)).toEqual({ ok: false, reason: "source_invalid", site: "workbuddy" });
  });

  it("only accepts known CN domains as a header value", () => {
    expect(validDomain("copilot.tencent.com", workBuddySite("workbuddy"))).toBe("copilot.tencent.com");
    expect(validDomain("www.codebuddy.cn", workBuddySite("workbuddy"))).toBe("www.codebuddy.cn");
    expect(validDomain(undefined, workBuddySite("workbuddy"))).toBe("copilot.tencent.com");
    expect(() => validDomain("evil.example.com", workBuddySite("workbuddy"))).toThrow();
    expect(() => validDomain("copilot.tencent.com/../../other", workBuddySite("workbuddy"))).toThrow();
    // Per-site allowlist: a CN domain is not valid for the international build.
    expect(validDomain("www.workbuddy.ai", workBuddySite("workbuddy-ai"))).toBe("www.workbuddy.ai");
    expect(validDomain(undefined, workBuddySite("workbuddy-ai"))).toBe("www.workbuddy.ai");
    expect(() => validDomain("copilot.tencent.com", workBuddySite("workbuddy-ai"))).toThrow();
  });
});

describe("chat headers", () => {
  it("signs the chat request with the fixed header set and no enterprise headers for a personal account", () => {
    const headers = credentialHeaders(CRED);
    expect(headers).toMatchObject({
      Authorization: "Bearer access-token",
      "X-User-Id": "u-1",
      "X-Domain": "copilot.tencent.com",
      "X-Product": "SaaS",
      "X-IDE-Type": "WorkBuddy",
      "User-Agent": "WorkBuddy/5.5.6",
      "X-Requested-With": "XMLHttpRequest",
      "X-Agent-Intent": "craft",
      "X-Agent-Purpose": "conversation",
      "X-IDE-Name": "WorkBuddy",
      "X-IDE-Version": "5.5.6",
    });
    expect(headers["X-Enterprise-Id"]).toBeUndefined();
    expect(headers["X-Tenant-Id"]).toBeUndefined();
  });

  it("sends enterprise headers only for an enterprise account", () => {
    const headers = credentialHeaders({ ...CRED, enterpriseId: "ent-1" });
    expect(headers["X-Enterprise-Id"]).toBe("ent-1");
    expect(headers["X-Tenant-Id"]).toBe("ent-1");
  });

  it("uses the config UA when asked", () => {
    expect(credentialHeaders(CRED, WORKBUDDY_CONFIG_UA)["User-Agent"]).toBe("CLI/2.0.0 WorkBuddy/5.5.6");
  });
});

describe("conversation ids", () => {
  const body = {
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", tool_calls: [{ id: "t1", function: { name: "read" } }] },
      { role: "tool", tool_call_id: "t1", content: "out" },
    ],
  };

  it("gives each request a new message id equal to the request id", () => {
    const a = conversationHeaders(body);
    const b = conversationHeaders(body);
    expect(a["X-Conversation-Message-ID"]).toMatch(/^[0-9a-f]{32}$/);
    expect(a["X-Request-ID"]).toBe(a["X-Conversation-Message-ID"]);
    expect(b["X-Conversation-Message-ID"]).not.toBe(a["X-Conversation-Message-ID"]);
  });

  it("keeps the turn id stable across a tool round trip", () => {
    const turn = conversationHeaders(body);
    const afterTool = conversationHeaders({ messages: [...body.messages, { role: "user", content: "hello" }] });
    expect(afterTool["X-Conversation-Request-ID"]).toBe(turn["X-Conversation-Request-ID"]);
    expect(afterTool["X-Conversation-ID"]).toBe(turn["X-Conversation-ID"]);
  });

  it("changes the turn id for a new user message", () => {
    const before = conversationHeaders({ messages: [...body.messages, { role: "user", content: "again" }] })["X-Conversation-Request-ID"];
    const next = conversationHeaders({ messages: [...body.messages, { role: "user", content: "again" }, { role: "user", content: "and again" }] })["X-Conversation-Request-ID"];
    expect(next).toMatch(/^[0-9a-f]{32}$/);
    expect(next).not.toBe(before);
  });

  it("omits ids when nothing is signable", () => {
    expect(conversationHeaders({ messages: [] })["X-Conversation-ID"]).toBeUndefined();
    expect(conversationHeaders({ messages: [{ role: "user", content: "" }] })["X-Conversation-Request-ID"]).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("managed provider guardrails", () => {
  it("recognises only a ccr_managed workbuddy provider", () => {
    expect(isManagedWorkBuddy({ name: "workbuddy", ccr_managed: true })).toBe(true);
    expect(isManagedWorkBuddy({ name: "workbuddy" })).toBe(false);
    expect(isManagedWorkBuddy({ name: "other", ccr_managed: true })).toBe(false);
  });

  it("re-locks the marker provider so generic saves cannot redirect transport", () => {
    expect(lockWorkBuddyProvider({ name: "workbuddy", ccr_managed: true, api_base_url: "https://evil.example.com", api_key: "stolen", models: ["x"] })).toEqual({
      name: "workbuddy",
      ccr_managed: true,
      workbuddy_kind: "workbuddy",
      workbuddyManaged: true,
      api_base_url: WORKBUDDY_CHAT_URL,
      api_key: "ccr-managed-workbuddy",
      transformer: { use: ["workbuddy"] },
      models: ["x"],
    });
  });

  it("restores the managed provider after a generic save that tried to move it", () => {
    const config = { Providers: [{ name: "other" }, { name: "workbuddy", ccr_managed: true, api_base_url: "https://evil.example.com", api_key: "stolen" }], Router: { default: "workbuddy,glm-5.3" } };
    protectWorkBuddyConfig(config);
    expect(config.Providers[1]).toMatchObject({ api_base_url: WORKBUDDY_CHAT_URL, api_key: "ccr-managed-workbuddy", ccr_managed: true });
    expect(config.Providers[0]).toEqual({ name: "other" });
    expect(config.Router).toEqual({ default: "workbuddy,glm-5.3" });
  });
});

describe("model discovery parsing", () => {
  const env = {
    code: 0,
    msg: "ok",
    data: {
      agents: [{ name: "ide", models: ["not-cli"] }, { name: "cli", models: ["glm-5.3", "kimi-k3-1", "glm-5.3"] }],
      models: [
        { id: "glm-5.3", name: "GLM-5.3", maxInputTokens: 1000000, maxOutputTokens: 8192, supportsImages: true, reasoning: { supportedEfforts: ["low", "high"], canDisableThinking: true } },
        { id: "kimi-k3-1", name: "GLM-5.3", onlyReasoning: true, reasoning: { supportedEfforts: ["low"], canDisableThinking: true } },
      ],
    },
  };

  it("only takes cli models, joins metadata and de-duplicates ids", () => {
    const models = parseWorkBuddyModels(env);
    expect(models).toEqual([
      { id: "glm-5.3", name: "GLM-5.3", context: 1000000, output: 8192, images: true, efforts: ["none", "low", "high"] },
      { id: "kimi-k3-1", name: "GLM-5.3 (kimi-k3-1)", images: false, efforts: ["low"] },
    ]);
  });

  it("keeps routing ids untouched when display names collide", () => {
    expect(parseWorkBuddyModels(env).map(m => m.id)).toEqual(["glm-5.3", "kimi-k3-1"]);
  });

  it("fails closed on envelope errors and empty lists", () => {
    expect(() => parseWorkBuddyModels({ code: 500, msg: "boom" })).toThrow(/上游请求失败/);
    expect(() => parseWorkBuddyModels({ data: { agents: [{ name: "cli", models: [] }] } })).toThrow(/未返回 cli 模型/);
  });
});

describe("upstream error classification", () => {
  it("maps the documented failure matrix without copying raw bodies", () => {
    expect(classifyWorkBuddyError(400, { code: 10085 })).toMatchObject({ code: "workbuddy_protocol_error", nonRetryable: true });
    expect(classifyWorkBuddyError(403, { code: 11140 })).toMatchObject({ code: "workbuddy_account_restricted", accountRestricted: true, cooldownSeconds: 7200 });
    expect(classifyWorkBuddyError(429, { code: 6004 })).toMatchObject({ code: "rate_limit", cooldownSeconds: 900 });
    expect(classifyWorkBuddyError(400, { code: 14018 })).toMatchObject({ code: "insufficient_quota" });
    expect(classifyWorkBuddyError(403, { error: { message: "Illegal API invocation from an unapproved channel" } })).toMatchObject({ code: "permission_error" });
    expect(classifyWorkBuddyError(400, { code: 11150 })).toMatchObject({ code: "invalid_request_error" });
    expect(classifyWorkBuddyError(400, { code: 11153 })).toMatchObject({ code: "invalid_request_error" });
    expect(classifyWorkBuddyError(500, { code: 11128 })).toMatchObject({ code: "provider_response_error", upstreamCode: 11128 });
  });

  it("reads a stated reset time for a rate limit", () => {
    const until = Date.now() + 30 * 60 * 1000;
    const iso = new Date(until + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
    const error = classifyWorkBuddyError(429, { code: 6004, msg: `您的使用量已超出频率限制，将在 ${iso} 重置` });
    expect(error.cooldownSeconds).toBeGreaterThan(1500);
  });

  it("never leaks a token into a classified error message", () => {
    const message = classifyWorkBuddyError(400, { code: 10085, msg: "token access-token leaked" }).message;
    expect(message).not.toContain("access-token");
  });
});
