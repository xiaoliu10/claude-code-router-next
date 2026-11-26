import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getQuotaAdapter,
  volcengineSigV4Sign,
} from "../services/quota-adapters";
import type { LLMProvider } from "../types/llm";

// Tests for the Volcengine Ark Coding Plan quota adapter: V4-variant signing
// (fixed vector with a hand-calculated HMAC chain), hostname+path dispatch,
// request shape, window mapping, and the failure paths that must yield null.
// All credentials below are synthetic; fetch is always mocked (no real calls).

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// --- Fixed signature vector (synthetic AK/SK, hand-calculated once) ---------
// Anchor values produced by an independent step-by-step HMAC chain over the
// canonical request literal below. If the signer drifts, these fail.
const TEST_ACCESS_KEY = "AKLTfake-test-access-key-id";
const TEST_SECRET_KEY = "fake-test-secret-access-key==";
const FIXED_X_DATE = "20261117T080000Z";
const FIXED_NOW = new Date("2026-11-17T08:00:00.000Z");
const EMPTY_BODY_SHA256 =
  "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
const EXPECTED_CANONICAL_REQUEST_HASH =
  "b520b03f3200094167f110d3ba2cc627bf9bd1107706993e8a6522517b52a466";
const EXPECTED_SIGNATURE =
  "34433069a06a7775a7ca2be9227061a5260eef6c2efb9892241b2693dd9e278f";
const EXPECTED_AUTHORIZATION =
  "HMAC-SHA256 Credential=AKLTfake-test-access-key-id/20261117/cn-beijing/ark/request, " +
  "SignedHeaders=host;x-date;x-content-sha256;content-type, " +
  "Signature=34433069a06a7775a7ca2be9227061a5260eef6c2efb9892241b2693dd9e278f";

const CODING_BASE_URL =
  "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions";
const USAGE_ENDPOINT =
  "https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01";

// Reset timestamps used by the mapping tests (epoch seconds), with the ISO
// expectations computed at module load so fake Date cannot shift them.
const SESSION_RESET_SECONDS = 1763370000;
const WEEKLY_RESET_SECONDS = 1763942400;
const SESSION_RESET_ISO = new Date(SESSION_RESET_SECONDS * 1000).toISOString();
const WEEKLY_RESET_ISO = new Date(WEEKLY_RESET_SECONDS * 1000).toISOString();

function makeProvider(overrides: Partial<LLMProvider> = {}): LLMProvider {
  return {
    name: "火山agent plan",
    baseUrl: CODING_BASE_URL,
    apiKey: "ark-inference-key-not-for-control-plane",
    models: ["ark-code-latest"],
    quotaAccessKey: TEST_ACCESS_KEY,
    quotaSecretKey: TEST_SECRET_KEY,
    ...overrides,
  };
}

/**
 * Independent hand-calculation of the Volcengine V4-variant signature over an
 * explicitly built canonical request: string-to-sign assembly plus the
 * kDate -> kRegion -> kService -> kSigning HMAC chain, written out step by
 * step from the spec (no reuse of the implementation's helpers).
 */
function handCalculateSignature(canonicalRequest: string, xDate: string): string {
  const sha256Hex = (value: string) =>
    createHash("sha256").update(value, "utf8").digest("hex");
  const hmac = (key: string | Buffer, value: string) =>
    createHmac("sha256", key).update(value, "utf8").digest();

  const shortDate = xDate.slice(0, 8);
  const stringToSign = [
    "HMAC-SHA256",
    xDate,
    `${shortDate}/cn-beijing/ark/request`,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(TEST_SECRET_KEY, shortDate);
  const kRegion = hmac(kDate, "cn-beijing");
  const kService = hmac(kRegion, "ark");
  const kSigning = hmac(kService, "request");
  return hmac(kSigning, stringToSign).toString("hex");
}

function canonicalRequestFor(query: string, xDate: string): string {
  return [
    "POST",
    "/",
    query,
    `host:open.volcengineapi.com\nx-date:${xDate}\nx-content-sha256:${EMPTY_BODY_SHA256}\ncontent-type:application/json\n`,
    "host;x-date;x-content-sha256;content-type",
    EMPTY_BODY_SHA256,
  ].join("\n");
}

function signUsageRequest(xDate: string, url = new URL(USAGE_ENDPOINT)) {
  return volcengineSigV4Sign({
    accessKey: TEST_ACCESS_KEY,
    secretKey: TEST_SECRET_KEY,
    method: "POST",
    url,
    body: "{}",
    region: "cn-beijing",
    service: "ark",
    xDate,
  });
}

function mockFetchJson(payload: unknown, status = 200) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    })
  );
  globalThis.fetch = fetchMock as any;
  return fetchMock;
}

function usagePayload(quotaUsage: unknown[]) {
  return {
    ResponseMetadata: {
      RequestId: "fake-request-id",
      Action: "GetCodingPlanUsage",
      Version: "2024-01-01",
    },
    Result: { Status: "active", QuotaUsage: quotaUsage },
  };
}

describe("volcengineSigV4Sign fixed vector", () => {
  it("reproduces the hand-calculated HMAC chain anchor", () => {
    // The canonical request literal pins every variant detail: fixed header
    // order, blank line after the header block, sorted query, payload hash.
    const canonicalRequest = canonicalRequestFor(
      "Action=GetCodingPlanUsage&Version=2024-01-01",
      FIXED_X_DATE
    );
    expect(createHash("sha256").update(canonicalRequest, "utf8").digest("hex"))
      .toBe(EXPECTED_CANONICAL_REQUEST_HASH);

    // The hand-calculated chain must agree with the pre-computed anchor...
    const handSignature = handCalculateSignature(canonicalRequest, FIXED_X_DATE);
    expect(handSignature).toBe(EXPECTED_SIGNATURE);

    // ...and with the implementation under test.
    const headers = signUsageRequest(FIXED_X_DATE);
    expect(headers.Authorization).toBe(EXPECTED_AUTHORIZATION);
    expect(headers["X-Date"]).toBe(FIXED_X_DATE);
    expect(headers["X-Content-Sha256"]).toBe(EMPTY_BODY_SHA256);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("uses the HMAC-SHA256 tag and a 'request' scope, not AWS SigV4 forms", () => {
    const headers = signUsageRequest(FIXED_X_DATE);
    expect(headers.Authorization).toMatch(/^HMAC-SHA256 Credential=/);
    expect(headers.Authorization).not.toContain("AWS4");
    expect(headers.Authorization).not.toContain("aws4_request");
    expect(headers.Authorization).toContain(
      `Credential=${TEST_ACCESS_KEY}/20261117/cn-beijing/ark/request`
    );
    expect(headers.Authorization).toContain(
      "SignedHeaders=host;x-date;x-content-sha256;content-type"
    );
  });

  it("sorts canonical query parameters by key regardless of input order", () => {
    const reversed = signUsageRequest(
      FIXED_X_DATE,
      new URL("https://open.volcengineapi.com/?Version=2024-01-01&Action=GetCodingPlanUsage")
    );
    expect(reversed.Authorization).toBe(EXPECTED_AUTHORIZATION);
  });

  it("RFC3986-encodes canonical query keys and values", () => {
    // Space, !, (, ), *, ' must be percent-encoded; ~ stays literal.
    const url = new URL("https://open.volcengineapi.com/?b=2&a=1 x~y!(z)*'w");
    const headers = signUsageRequest(FIXED_X_DATE, url);
    const expectedSignature = handCalculateSignature(
      canonicalRequestFor("a=1%20x~y%21%28z%29%2A%27w&b=2", FIXED_X_DATE),
      FIXED_X_DATE
    );
    expect(headers.Authorization).toContain(`Signature=${expectedSignature}`);
  });
});

describe("getQuotaAdapter Volcengine dispatch", () => {
  it("matches the ark coding-plan host with an /api/coding/ path", () => {
    const adapter = getQuotaAdapter(CODING_BASE_URL);
    expect(adapter).not.toBeNull();
    expect(adapter!.constructor.name).toBe("VolcengineCodingPlanQuotaAdapter");
    expect(getQuotaAdapter("https://ark.cn-beijing.volces.com/api/coding/v3")).not.toBeNull();
  });

  it("does not match pay-as-you-go /api/v3 or Agent Plan /api/plan paths", () => {
    expect(getQuotaAdapter("https://ark.cn-beijing.volces.com/api/v3/chat/completions")).toBeNull();
    expect(getQuotaAdapter("https://ark.cn-beijing.volces.com/api/plan/v1/chat/completions")).toBeNull();
    expect(getQuotaAdapter("https://ark.cn-beijing.volces.com/api/v3")).toBeNull();
  });

  it("does not match other hostnames even with an /api/coding/ path", () => {
    expect(getQuotaAdapter("https://example.com/api/coding/v3/chat/completions")).toBeNull();
    expect(getQuotaAdapter("https://ark.cn-guangzhou.volces.com/api/coding/v3")).toBeNull();
    expect(getQuotaAdapter("https://ark.cn-beijing.volces.com.evil.example/api/coding/v3")).toBeNull();
    expect(getQuotaAdapter("not-a-url")).toBeNull();
  });

  it("matches on the URL path only, not on query strings", () => {
    expect(
      getQuotaAdapter("https://ark.cn-beijing.volces.com/api/v3?next=/api/coding/")
    ).toBeNull();
  });
});

describe("VolcengineCodingPlanQuotaAdapter request shape", () => {
  it("POSTs the signed GetCodingPlanUsage request with the fixed-vector Authorization", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);

    let capturedUrl: string | undefined;
    let capturedInit: (RequestInit & { dispatcher?: unknown }) | undefined;
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify(usagePayload([
        { Level: "session", Percent: 10, ResetTimestamp: SESSION_RESET_SECONDS },
      ])), { status: 200 });
    }) as any;

    const adapter = getQuotaAdapter(CODING_BASE_URL);
    const result = await adapter!.queryQuota(makeProvider(), 5000);
    expect(result).not.toBeNull();

    expect(capturedUrl).toBe(USAGE_ENDPOINT);
    expect(capturedInit!.method).toBe("POST");
    expect(capturedInit!.body).toBe("{}");

    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers["X-Date"]).toBe(FIXED_X_DATE);
    expect(headers["X-Content-Sha256"]).toBe(EMPTY_BODY_SHA256);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe(EXPECTED_AUTHORIZATION);
    // ProxyAgent gzip hazard guard, same as the other adapters.
    expect(headers["Accept-Encoding"]).toBe("identity");
    // The data-plane inference key must never be sent to the control plane.
    expect(headers.Authorization).not.toContain("ark-inference-key");
    expect(JSON.stringify(headers)).not.toContain("ark-inference-key");
  });

  it("trims whitespace-padded AK/SK before signing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);

    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      capturedInit = init;
      return new Response(JSON.stringify(usagePayload([
        { Level: "session", Percent: 10, ResetTimestamp: SESSION_RESET_SECONDS },
      ])), { status: 200 });
    }) as any;

    const adapter = getQuotaAdapter(CODING_BASE_URL);
    await adapter!.queryQuota(
      makeProvider({
        quotaAccessKey: `  ${TEST_ACCESS_KEY}  `,
        quotaSecretKey: `  ${TEST_SECRET_KEY}  `,
      }),
      5000
    );
    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers.Authorization).toBe(EXPECTED_AUTHORIZATION);
  });

  it("sets the proxy dispatcher when a proxyUrl is provided", async () => {
    let capturedInit: (RequestInit & { dispatcher?: unknown }) | undefined;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      capturedInit = init;
      return new Response(JSON.stringify(usagePayload([
        { Level: "session", Percent: 10, ResetTimestamp: SESSION_RESET_SECONDS },
      ])), { status: 200 });
    }) as any;

    const adapter = getQuotaAdapter(CODING_BASE_URL);
    await adapter!.queryQuota(makeProvider(), 5000, "http://127.0.0.1:7897");
    expect(capturedInit?.dispatcher).toBeDefined();
  });
});

describe("VolcengineCodingPlanQuotaAdapter window mapping", () => {
  it("maps session to the 5h slot and weekly to the 7d slot as percentages", async () => {
    mockFetchJson(usagePayload([
      { Level: "session", Percent: 37.5, ResetTimestamp: SESSION_RESET_SECONDS },
      { Level: "weekly", Percent: 62, ResetTimestamp: WEEKLY_RESET_SECONDS },
      { Level: "monthly", Percent: 80, ResetTimestamp: 1766000000 },
    ]));

    const adapter = getQuotaAdapter(CODING_BASE_URL);
    const result = await adapter!.queryQuota(makeProvider(), 5000);

    // toEqual pins the exact shape: no currency (rateLimit classification) and
    // no remainingBalance; all three windows map onto their UI slots.
    expect(result).toEqual({
      limitDaily: 100,
      usedDailyBalance: 37.5,
      resetTime: SESSION_RESET_ISO,
      totalBalance: 100,
      usedBalance: 62,
      resetTime7d: WEEKLY_RESET_ISO,
      limitMonthly: 100,
      usedMonthlyBalance: 80,
      resetTimeMonthly: new Date(1766000000 * 1000).toISOString(),
    });
  });

  it("maps a session-only response to the 5h slot alone", async () => {
    mockFetchJson(usagePayload([
      { Level: "session", Percent: 5, ResetTimestamp: SESSION_RESET_SECONDS },
    ]));
    const adapter = getQuotaAdapter(CODING_BASE_URL);
    expect(await adapter!.queryQuota(makeProvider(), 5000)).toEqual({
      limitDaily: 100,
      usedDailyBalance: 5,
      resetTime: SESSION_RESET_ISO,
    });
  });

  it("maps a weekly-only response to the 7d slot alone", async () => {
    mockFetchJson(usagePayload([
      { Level: "weekly", Percent: 90, ResetTimestamp: WEEKLY_RESET_SECONDS },
    ]));
    const adapter = getQuotaAdapter(CODING_BASE_URL);
    expect(await adapter!.queryQuota(makeProvider(), 5000)).toEqual({
      totalBalance: 100,
      usedBalance: 90,
      resetTime7d: WEEKLY_RESET_ISO,
    });
  });

  it("skips a window whose ResetTimestamp is -1 (no active limit)", async () => {
    mockFetchJson(usagePayload([
      { Level: "session", Percent: 42, ResetTimestamp: -1 },
      { Level: "weekly", Percent: 62, ResetTimestamp: WEEKLY_RESET_SECONDS },
    ]));
    const adapter = getQuotaAdapter(CODING_BASE_URL);
    expect(await adapter!.queryQuota(makeProvider(), 5000)).toEqual({
      totalBalance: 100,
      usedBalance: 62,
      resetTime7d: WEEKLY_RESET_ISO,
    });
  });

  it("skips a window whose ResetTimestamp is 0", async () => {
    mockFetchJson(usagePayload([
      { Level: "session", Percent: 42, ResetTimestamp: SESSION_RESET_SECONDS },
      { Level: "weekly", Percent: 62, ResetTimestamp: 0 },
    ]));
    const adapter = getQuotaAdapter(CODING_BASE_URL);
    expect(await adapter!.queryQuota(makeProvider(), 5000)).toEqual({
      limitDaily: 100,
      usedDailyBalance: 42,
      resetTime: SESSION_RESET_ISO,
    });
  });

  it("returns null when every window has a non-positive ResetTimestamp", async () => {
    mockFetchJson(usagePayload([
      { Level: "session", Percent: 42, ResetTimestamp: -1 },
      { Level: "weekly", Percent: 62, ResetTimestamp: 0 },
    ]));
    const adapter = getQuotaAdapter(CODING_BASE_URL);
    expect(await adapter!.queryQuota(makeProvider(), 5000)).toBeNull();
  });

  it("maps a monthly-only response to the 30d slot alone", async () => {
    mockFetchJson(usagePayload([
      { Level: "monthly", Percent: 80, ResetTimestamp: 1766000000 },
    ]));
    const adapter = getQuotaAdapter(CODING_BASE_URL);
    expect(await adapter!.queryQuota(makeProvider(), 5000)).toEqual({
      limitMonthly: 100,
      usedMonthlyBalance: 80,
      resetTimeMonthly: new Date(1766000000 * 1000).toISOString(),
    });
  });

  it("ignores entries with a non-numeric Percent", async () => {
    mockFetchJson(usagePayload([
      { Level: "session", Percent: "not-a-number", ResetTimestamp: SESSION_RESET_SECONDS },
    ]));
    const adapter = getQuotaAdapter(CODING_BASE_URL);
    expect(await adapter!.queryQuota(makeProvider(), 5000)).toBeNull();
  });
});

describe("VolcengineCodingPlanQuotaAdapter failure paths", () => {
  it("returns null when QuotaUsage is missing (reclaimed/unsubscribed plan)", async () => {
    // A reclaimed plan returns Status without QuotaUsage — "no data", not an error.
    mockFetchJson({
      ResponseMetadata: { RequestId: "fake-request-id" },
      Result: { Status: "reclaimed" },
    });
    const adapter = getQuotaAdapter(CODING_BASE_URL);
    expect(await adapter!.queryQuota(makeProvider(), 5000)).toBeNull();
  });

  it("returns null for missing/empty/non-array QuotaUsage", async () => {
    const adapter = getQuotaAdapter(CODING_BASE_URL);

    mockFetchJson({ ResponseMetadata: {}, Result: {} });
    expect(await adapter!.queryQuota(makeProvider(), 5000)).toBeNull();

    mockFetchJson({ ResponseMetadata: {} });
    expect(await adapter!.queryQuota(makeProvider(), 5000)).toBeNull();

    mockFetchJson(usagePayload([]));
    expect(await adapter!.queryQuota(makeProvider(), 5000)).toBeNull();

    mockFetchJson({ Result: { QuotaUsage: "nope" } });
    expect(await adapter!.queryQuota(makeProvider(), 5000)).toBeNull();
  });

  it("returns null on HTTP 200 with a ResponseMetadata.Error envelope", async () => {
    // Auth/business errors are frequently HTTP 200 + error envelope; the
    // envelope must win even if a QuotaUsage array is also present.
    mockFetchJson({
      ResponseMetadata: {
        RequestId: "fake-request-id",
        Error: {
          Code: "InvalidAccessKey.NotFound",
          Message: "The access key does not exist.",
        },
      },
      Result: {
        QuotaUsage: [
          { Level: "session", Percent: 10, ResetTimestamp: SESSION_RESET_SECONDS },
        ],
      },
    });
    const adapter = getQuotaAdapter(CODING_BASE_URL);
    expect(await adapter!.queryQuota(makeProvider(), 5000)).toBeNull();
  });

  it("returns null on non-2xx responses (auth errors are often 400)", async () => {
    const adapter = getQuotaAdapter(CODING_BASE_URL);

    mockFetchJson({ ResponseMetadata: { Error: { Code: "SignatureDoesNotMatch" } } }, 400);
    expect(await adapter!.queryQuota(makeProvider(), 5000)).toBeNull();

    mockFetchJson({}, 403);
    expect(await adapter!.queryQuota(makeProvider(), 5000)).toBeNull();
  });

  it("returns null on network errors without leaking credentials", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("connection refused");
    }) as any;
    const adapter = getQuotaAdapter(CODING_BASE_URL);
    // Must resolve to null silently — never throw, never surface the secret.
    expect(await adapter!.queryQuota(makeProvider(), 5000)).toBeNull();
  });

  it("returns null on an unparseable JSON body", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("<html>gateway error</html>", { status: 200 })
    ) as any;
    const adapter = getQuotaAdapter(CODING_BASE_URL);
    expect(await adapter!.queryQuota(makeProvider(), 5000)).toBeNull();
  });

  it("returns null without any request when quotaAccessKey is missing", async () => {
    const fetchMock = mockFetchJson(usagePayload([]));
    const adapter = getQuotaAdapter(CODING_BASE_URL);
    expect(
      await adapter!.queryQuota(makeProvider({ quotaAccessKey: undefined }), 5000)
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null without any request when quotaSecretKey is missing", async () => {
    const fetchMock = mockFetchJson(usagePayload([]));
    const adapter = getQuotaAdapter(CODING_BASE_URL);
    expect(
      await adapter!.queryQuota(makeProvider({ quotaSecretKey: undefined }), 5000)
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats empty or whitespace-only credentials as unconfigured", async () => {
    const fetchMock = mockFetchJson(usagePayload([]));
    const adapter = getQuotaAdapter(CODING_BASE_URL);
    expect(
      await adapter!.queryQuota(makeProvider({ quotaAccessKey: "", quotaSecretKey: "" }), 5000)
    ).toBeNull();
    expect(
      await adapter!.queryQuota(makeProvider({ quotaAccessKey: "   ", quotaSecretKey: "   " }), 5000)
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
