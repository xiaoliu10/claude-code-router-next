import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getQuotaAdapter,
  parseAliyunTokenPlanUsage,
} from "../services/quota-adapters";
import type { LLMProvider } from "../types/llm";

// Tests for getQuotaAdapter hostname dispatch (no network) and the
// AliyunTokenPlanQuotaAdapter request/parsing behaviour (network mocked).

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function makeProvider(overrides: Partial<LLMProvider> = {}): LLMProvider {
  return {
    name: "test-aliyun-maas",
    baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages",
    apiKey: "dummy-api-key",
    models: ["qwen-plus"],
    quotaToken: "dummy_cookie=abc123",
    ...overrides,
  };
}

describe("getQuotaAdapter hostname dispatch", () => {
  it("routes Aliyun DashScope hostnames to the coding-plan adapter", () => {
    expect(
      getQuotaAdapter("https://dashscope.aliyuncs.com/api/v1/services/aigc/...")
    ).not.toBeNull();
    expect(
      getQuotaAdapter("https://coding.dashscope.aliyuncs.com/v1/messages")
    ).not.toBeNull();
  });

  it("routes the Aliyun maas.aliyuncs.com token-plan gateway to a quota adapter", () => {
    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    expect(adapter).not.toBeNull();
  });

  it("uses DIFFERENT adapters for maas token-plan and dashscope endpoints", () => {
    // The maas.aliyuncs.com token-plan gateway has a dedicated adapter that
    // queries cs-data.qianwenai.com, separate from the DashScope coding-plan
    // adapter that queries the Bailian console.
    const maasAdapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    const dashscopeAdapter = getQuotaAdapter(
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/..."
    );
    expect(maasAdapter).not.toBe(dashscopeAdapter);
  });

  it("returns null for unknown hostnames", () => {
    expect(getQuotaAdapter("https://example.com/v1/messages")).toBeNull();
    expect(getQuotaAdapter("not-a-url")).toBeNull();
  });
});

describe("parseAliyunTokenPlanUsage", () => {
  it("parses the confirmed authenticated token-plan response", () => {
    // Real sample from cs-data.qianwenai.com tokenplan usage endpoint.
    const result = parseAliyunTokenPlanUsage({
      code: "200",
      data: {
        DataV2: {
          ret: ["SUCCESS::接口调用成功"],
          data: {
            msg: "Success.",
            code: "SUCCESS",
            data: {
              per5HourPercentage: 0.06636184285714286,
              per1WeekResetTime: 1785058140000,
              per5HourResetTime: 1784546640000,
              per1WeekPercentage: 0.3743061456,
            },
            requestId: "b4a46a31",
            success: true,
          },
        },
        success: true,
        httpStatus: 200,
        errorCode: "",
        api: "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage",
        errorMsg: "",
      },
      httpStatusCode: "200",
      requestId: "b4a46a31",
      successResponse: true,
    });
    // 5h: 0.0663 -> 6.64%, limit 100
    expect(result).not.toBeNull();
    expect(result!.usedDailyBalance).toBeCloseTo(6.64, 2);
    expect(result!.limitDaily).toBe(100);
    // 7d: 0.3743 -> 37.43%, total 100
    expect(result!.usedBalance).toBeCloseTo(37.43, 2);
    expect(result!.totalBalance).toBe(100);
    // Reset times are ms-epoch -> ISO strings.
    expect(result!.resetTime).toBe(new Date(1784546640000).toISOString());
    expect(result!.resetTime7d).toBe(new Date(1785058140000).toISOString());
  });

  it("parses a flat (un-enveloped) percentage payload", () => {
    const result = parseAliyunTokenPlanUsage({
      per5HourPercentage: 0.5,
      per1WeekPercentage: 0.25,
    });
    expect(result).toEqual({
      usedDailyBalance: 50,
      limitDaily: 100,
      usedBalance: 25,
      totalBalance: 100,
    });
  });

  it("parses only the 5h window when 7d is absent", () => {
    const result = parseAliyunTokenPlanUsage({
      per5HourPercentage: 0.1,
      per5HourResetTime: 1784546640000,
    });
    expect(result).toEqual({
      usedDailyBalance: 10,
      limitDaily: 100,
      resetTime: new Date(1784546640000).toISOString(),
    });
  });

  it("parses only the 7d window when 5h is absent", () => {
    const result = parseAliyunTokenPlanUsage({
      per1WeekPercentage: 0.8,
      per1WeekResetTime: 1785058140000,
    });
    expect(result).toEqual({
      usedBalance: 80,
      totalBalance: 100,
      resetTime7d: new Date(1785058140000).toISOString(),
      resetTime: new Date(1785058140000).toISOString(),
    });
  });

  it("returns null when the gateway reports a login/business error", () => {
    // Confirmed shape of an unauthenticated token-plan gateway response.
    const result = parseAliyunTokenPlanUsage({
      code: "200",
      data: {
        success: false,
        httpStatus: 200,
        errorCode: "BailianGateway.Login.NotLogined",
        api: "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage",
        errorMsg: "BailianGateway.Login.NotLogined",
      },
      successResponse: true,
    });
    expect(result).toBeNull();
  });

  it("returns null when no recognised quota fields are present", () => {
    expect(parseAliyunTokenPlanUsage({ foo: "bar", baz: 42 })).toBeNull();
  });

  it("returns null for non-object payloads", () => {
    expect(parseAliyunTokenPlanUsage(null)).toBeNull();
    expect(parseAliyunTokenPlanUsage("string")).toBeNull();
    expect(parseAliyunTokenPlanUsage(42)).toBeNull();
  });

  it("does not treat unknown fields as quota values", () => {
    const result = parseAliyunTokenPlanUsage({
      randomField: 999,
      anotherField: "abc",
    });
    expect(result).toBeNull();
  });

  it("clamps a negative percentage to 0", () => {
    const result = parseAliyunTokenPlanUsage({
      per5HourPercentage: -0.2,
      per1WeekPercentage: -0.5,
    });
    expect(result).toEqual({
      usedDailyBalance: 0,
      limitDaily: 100,
      usedBalance: 0,
      totalBalance: 100,
    });
  });

  it("ignores a NaN percentage (treated as missing)", () => {
    // NaN is not finite, so parseOptionalNumber returns undefined and the slot
    // is treated as absent rather than zero — matching how the other adapters
    // handle non-numeric quota values.
    const result = parseAliyunTokenPlanUsage({
      per5HourPercentage: NaN,
      per1WeekPercentage: NaN,
    });
    expect(result).toBeNull();
  });
});

describe("AliyunTokenPlanQuotaAdapter request behaviour", () => {
  it("POSTs to the gateway with Cookie auth, a params body, and no Bearer header", async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | undefined;

    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({
        data: { DataV2: { data: { data: { per5HourPercentage: 0.1, per1WeekPercentage: 0.2 } } } },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    expect(adapter).not.toBeNull();

    const result = await adapter!.queryQuota(makeProvider(), 5000);
    expect(result).not.toBeNull();
    expect(result!.usedDailyBalance).toBe(10);
    expect(result!.limitDaily).toBe(100);
    expect(result!.usedBalance).toBe(20);
    expect(result!.totalBalance).toBe(100);

    // The gateway rejects GET — the adapter must POST.
    expect(capturedInit!.method).toBe("POST");

    // The URL targets the confirmed token-plan usage endpoint on
    // cs-data.qianwenai.com, with the token-plan api path.
    expect(capturedUrl).toContain("https://cs-data.qianwenai.com/data/api.json");
    expect(capturedUrl).toContain("action=BroadScopeAspnGateway");
    expect(capturedUrl).toContain("api=zeldaHttp.apikeyMgr.");
    expect(capturedUrl).toContain("tokenplan");

    const headers = capturedInit!.headers as Record<string, string>;
    // Cookie auth is set from quotaToken (trimmed) and is the ONLY auth.
    expect(headers.Cookie).toBe("dummy_cookie=abc123");
    expect(headers.Authorization).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    // The BroadScope gateway requires the form-encoded params envelope.
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = String(capturedInit!.body);
    expect(body).toContain("params=");
    expect(body).toContain("region=cn-beijing");
    expect(body).toContain(encodeURIComponent("zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage"));
  });

  it("sets the proxy dispatcher when a proxyUrl is provided", async () => {
    let capturedInit: RequestInit & { dispatcher?: unknown } | undefined;

    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      capturedInit = init;
      const payload = { data: { DataV2: { data: { data: { per5HourPercentage: 0.05 } } } } };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    await adapter!.queryQuota(makeProvider(), 5000, "http://127.0.0.1:7897");
    // getProxyDispatcher returns an undici ProxyAgent; just assert a dispatcher
    // was attached (proves the proxy branch ran rather than being skipped).
    expect(capturedInit?.dispatcher).toBeDefined();
  });

  it("trims a whitespace-padded cookie before sending", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      capturedInit = init;
      const payload = { data: { DataV2: { data: { data: { per5HourPercentage: 0.05 } } } } };
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as any;

    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    await adapter!.queryQuota(makeProvider({ quotaToken: "  dummy_cookie=abc123  " }), 5000);
    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers.Cookie).toBe("dummy_cookie=abc123");
  });

  it("returns null when quotaToken is missing", async () => {
    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    const result = await adapter!.queryQuota(
      makeProvider({ quotaToken: undefined }),
      5000
    );
    expect(result).toBeNull();
  });

  it("returns null on HTTP error", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("Forbidden", { status: 403 })
    ) as any;

    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    const result = await adapter!.queryQuota(makeProvider(), 5000);
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network error");
    }) as any;

    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    const result = await adapter!.queryQuota(makeProvider(), 5000);
    expect(result).toBeNull();
  });
});

describe("AliyunTokenPlanQuotaAdapter official sec_token request", () => {
  it("prefers the official bailian-cs gateway when quotaSecToken is set", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({
        data: { DataV2: { data: { data: { per5HourPercentage: 0.15, per1WeekPercentage: 0.45 } } } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as any;

    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    const result = await adapter!.queryQuota(
      makeProvider({ quotaSecToken: "my-sec-token-123" }),
      5000
    );

    expect(result).not.toBeNull();
    expect(result!.usedDailyBalance).toBe(15);
    expect(result!.usedBalance).toBe(45);

    // The gateway rejects GET — the adapter must POST.
    expect(capturedInit!.method).toBe("POST");

    // The official endpoint uses the literal version placeholder from the
    // console request rather than the stale frontend version.
    expect(capturedUrl).toContain("https://bailian-cs.console.aliyun.com/data/api.json");
    expect(capturedUrl).toContain("action=BroadScopeAspnGateway");
    expect(capturedUrl).toContain("_v=undefined");
    expect(capturedUrl).not.toContain("_v=3.5.613");

    // Cookie auth is the only authentication header.
    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers.Cookie).toBe("dummy_cookie=abc123");
    expect(headers.Authorization).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");

    // The form body must include params, region, and sec_token.
    const body = String(capturedInit!.body);
    expect(body).toContain("params=");
    expect(body).toContain("region=cn-beijing");
    expect(body).toContain("sec_token=my-sec-token-123");

    // Decode the params envelope and pin the stable official console fields.
    const paramsMatch = body.match(/params=([^&]+)/);
    expect(paramsMatch).not.toBeNull();
    const params = JSON.parse(decodeURIComponent(paramsMatch![1]));
    const cornerstoneParam = params.Data.cornerstoneParam;
    expect(cornerstoneParam.protocol).toBe("V2");
    expect(cornerstoneParam.console).toBe("ONE_CONSOLE");
    expect(cornerstoneParam.productCode).toBe("p_efm");
    expect(cornerstoneParam.switchAgent).toBe(10736808);
    expect(cornerstoneParam.switchUserType).toBe(3);
    expect(cornerstoneParam.domain).toBe("bailian.console.aliyun.com");
    expect(cornerstoneParam.consoleSite).toBe("BAILIAN_ALIYUN");
    expect(cornerstoneParam.userNickName).toBe("");
    expect(cornerstoneParam.userPrincipalName).toBe("");
    expect(cornerstoneParam.xsp_lang).toBe("zh-CN");
    expect(cornerstoneParam.feURL).toBe(
      "https://bailian.console.aliyun.com/cn-beijing/?tab=plan#/efm/subscription/token-plan/personal"
    );
    expect(cornerstoneParam.feURL).not.toContain("spm=");
    expect(cornerstoneParam["X-Anonymous-Id"]).toBeDefined();

    // Referer must point at the token-plan console page.
    expect(headers.Referer).toBe("https://bailian.console.aliyun.com/cn-beijing/?tab=plan");
  });

  it("extracts X-Anonymous-Id from the cna cookie value", async () => {
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      capturedInit = init;
      return new Response(JSON.stringify({
        data: { DataV2: { data: { data: { per5HourPercentage: 0.1 } } } },
      }), { status: 200 });
    }) as any;

    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    await adapter!.queryQuota(
      makeProvider({
        quotaToken: "cna=abc-def-123; other_cookie=xyz",
        quotaSecToken: "sec-456",
      }),
      5000
    );

    const body = String(capturedInit!.body);
    const paramsMatch = body.match(/params=([^&]+)/);
    const decoded = decodeURIComponent(paramsMatch![1]);
    expect(decoded).toContain('"X-Anonymous-Id":"abc-def-123"');
  });

  it("sets X-Anonymous-Id to empty string when cna cookie is absent", async () => {
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      capturedInit = init;
      return new Response(JSON.stringify({
        data: { DataV2: { data: { data: { per5HourPercentage: 0.1 } } } },
      }), { status: 200 });
    }) as any;

    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    await adapter!.queryQuota(
      makeProvider({ quotaSecToken: "sec-token" }),
      5000
    );

    const body = String(capturedInit!.body);
    const paramsMatch = body.match(/params=([^&]+)/);
    const decoded = decodeURIComponent(paramsMatch![1]);
    expect(decoded).toContain('"X-Anonymous-Id":""');
  });

  it("does NOT send the sec_token body field when no quotaSecToken is configured", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({
        data: { DataV2: { data: { data: { per5HourPercentage: 0.1 } } } },
      }), { status: 200 });
    }) as any;

    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    await adapter!.queryQuota(makeProvider(), 5000);

    // Without sec_token, the legacy endpoint is used (no _v param, no sec_token).
    expect(capturedUrl).toContain("https://cs-data.qianwenai.com/data/api.json");
    expect(capturedUrl).not.toContain("_v=");
    const body = String(capturedInit!.body);
    expect(body).not.toContain("sec_token=");
  });
});

describe("AliyunTokenPlanQuotaAdapter sec_token fallback", () => {
  it("falls back to the legacy endpoint when the official request returns HTTP error", async () => {
    const calls: Array<{ url: string; status: number }> = [];

    globalThis.fetch = vi.fn(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes("bailian-cs.console.aliyun.com")) {
        calls.push({ url: urlStr, status: 403 });
        return new Response("Forbidden", { status: 403 });
      }
      calls.push({ url: urlStr, status: 200 });
      return new Response(JSON.stringify({
        data: { DataV2: { data: { data: { per5HourPercentage: 0.3, per1WeekPercentage: 0.6 } } } },
      }), { status: 200 });
    }) as any;

    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    const result = await adapter!.queryQuota(
      makeProvider({ quotaSecToken: "sec-token" }),
      5000
    );

    // Official failed (403), fallback to legacy succeeded.
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("bailian-cs.console.aliyun.com");
    expect(calls[1].url).toContain("cs-data.qianwenai.com");
    expect(result).not.toBeNull();
    expect(result!.usedDailyBalance).toBe(30);
    expect(result!.usedBalance).toBe(60);
  });

  it("falls back to the legacy endpoint when the official response parses to null", async () => {
    const calls: Array<{ url: string }> = [];

    globalThis.fetch = vi.fn(async (url: any) => {
      const urlStr = String(url);
      calls.push({ url: urlStr });
      if (urlStr.includes("bailian-cs.console.aliyun.com")) {
        // Valid HTTP 200 but unparseable payload (gateway login error).
        return new Response(JSON.stringify({
          data: { success: false, errorCode: "BailianGateway.Login.NotLogined" },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: { DataV2: { data: { data: { per5HourPercentage: 0.2 } } } },
      }), { status: 200 });
    }) as any;

    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    const result = await adapter!.queryQuota(
      makeProvider({ quotaSecToken: "sec-token" }),
      5000
    );

    // Official returned null parse, fallback to legacy succeeded.
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("bailian-cs.console.aliyun.com");
    expect(calls[1].url).toContain("cs-data.qianwenai.com");
    expect(result).not.toBeNull();
    expect(result!.usedDailyBalance).toBe(20);
  });

  it("falls back to the legacy endpoint when the official request throws a network error", async () => {
    const calls: Array<{ url: string }> = [];

    globalThis.fetch = vi.fn(async (url: any) => {
      const urlStr = String(url);
      calls.push({ url: urlStr });
      if (urlStr.includes("bailian-cs.console.aliyun.com")) {
        throw new Error("network timeout");
      }
      return new Response(JSON.stringify({
        data: { DataV2: { data: { data: { per5HourPercentage: 0.05 } } } },
      }), { status: 200 });
    }) as any;

    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    const result = await adapter!.queryQuota(
      makeProvider({ quotaSecToken: "sec-token" }),
      5000
    );

    expect(calls).toHaveLength(2);
    expect(result).not.toBeNull();
    expect(result!.usedDailyBalance).toBe(5);
  });

  it("returns null when both official and legacy endpoints fail", async () => {
    const calls: Array<{ url: string }> = [];

    globalThis.fetch = vi.fn(async (url: any) => {
      const urlStr = String(url);
      calls.push({ url: urlStr });
      return new Response("Service Unavailable", { status: 503 });
    }) as any;

    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    const result = await adapter!.queryQuota(
      makeProvider({ quotaSecToken: "sec-token" }),
      5000
    );

    expect(calls).toHaveLength(2);
    expect(result).toBeNull();
  });

  it("does not output credentials in any error path", async () => {
    // Even when both endpoints fail, the adapter must return null silently —
    // it must never throw or leak sec_token/cookie values in error messages.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("connection refused");
    }) as any;

    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    const result = await adapter!.queryQuota(
      makeProvider({
        quotaToken: "super-secret-cookie",
        quotaSecToken: "super-secret-sec-token",
      }),
      5000
    );

    expect(result).toBeNull();
    // No exception thrown — errors are caught internally.
  });

  it("falls back to the legacy endpoint when the official setup throws (malformed cna cookie)", async () => {
    // extractCookieValue calls decodeURIComponent, which throws URIError on a
    // dangling '%'. That setup code runs outside queryOfficialEndpoint's try
    // block, so queryQuota must still catch it and degrade to the legacy path
    // rather than letting the whole probe crash.
    const calls: Array<{ url: string }> = [];

    globalThis.fetch = vi.fn(async (url: any) => {
      const urlStr = String(url);
      calls.push({ url: urlStr });
      return new Response(JSON.stringify({
        data: { DataV2: { data: { data: { per5HourPercentage: 0.25 } } } },
      }), { status: 200 });
    }) as any;

    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    // cna value ends in a dangling '%' -> decodeURIComponent throws URIError.
    const result = await adapter!.queryQuota(
      makeProvider({
        quotaToken: "cna=abc-def%",
        quotaSecToken: "sec-token",
      }),
      5000
    );

    // Official setup threw, so only the legacy endpoint is hit and it succeeds.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("cs-data.qianwenai.com");
    expect(result).not.toBeNull();
    expect(result!.usedDailyBalance).toBe(25);
  });
});

describe("ZhipuQuotaAdapter quota fetch (gzip/identity regression)", () => {
  const zhipuBaseUrl = "https://open.bigmodel.cn/api/anthropic/v1/messages";
  const makeZhipu = (): LLMProvider => ({
    name: "智谱 Coding Plan -lite",
    baseUrl: zhipuBaseUrl,
    apiKey: "zhipu-raw-key",
    models: ["glm-5.3"],
  } as LLMProvider);

  // Real upstream shape captured 2026-11-10: the 5h TOKENS_LIMIT carries only
  // a percentage (no currentValue/usage/remaining). Without Accept-Encoding:
  // identity the response arrived gzip-compressed over an explicit ProxyAgent
  // and undici did not gunzip it, so response.json() threw and the adapter
  // returned null — the provider card showed no quota at all.
  const realPayload = {
    code: 200,
    msg: "Operation successful",
    data: {
      limits: [
        {
          type: "TIME_LIMIT", unit: 5, number: 1, usage: 100,
          currentValue: 28, remaining: 72, percentage: 28,
          nextResetTime: 1796007632999,
        },
        {
          type: "TOKENS_LIMIT", unit: 3, number: 5,
          percentage: 100, nextResetTime: 1794313562965,
        },
      ],
    },
  };

  it("dispatches bigmodel.cn to the Zhipu adapter", () => {
    expect(getQuotaAdapter(zhipuBaseUrl)?.constructor.name).toBe("ZhipuQuotaAdapter");
  });

  it("sends Accept-Encoding: identity and a raw key, and parses the percentage-only 5h quota", async () => {
    let capturedInit: (RequestInit & { dispatcher?: unknown }) | undefined;
    let capturedUrl = "";
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify(realPayload), { status: 200, headers: { "content-type": "application/json" } });
    }) as any;

    const adapter = getQuotaAdapter(zhipuBaseUrl);
    const result = await adapter!.queryQuota(makeZhipu(), 5000, "http://127.0.0.1:7897");

    expect(capturedUrl).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
    const headers = capturedInit!.headers as Record<string, string>;
    // The regression guard: never let undici hand a gzip body to response.json().
    expect(headers["Accept-Encoding"]).toBe("identity");
    // Zhipu authenticates with the raw key, no Bearer prefix.
    expect(headers.Authorization).toBe("zhipu-raw-key");
    expect(capturedInit!.dispatcher).toBeDefined();

    expect(result).toEqual({
      usedDailyBalance: 100,
      limitDaily: 100,
      resetTime: new Date(1794313562965).toISOString(),
    });
  });

  it("returns null when the api key is missing", async () => {
    const adapter = getQuotaAdapter(zhipuBaseUrl);
    const result = await adapter!.queryQuota({ ...makeZhipu(), apiKey: "" } as LLMProvider, 5000);
    expect(result).toBeNull();
  });

  it("the shared base fetchJson path also requests identity encoding", async () => {
    // DeepSeek uses BaseQuotaAdapter.fetchJson — the same ProxyAgent gzip hazard.
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      capturedInit = init;
      return new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: "CNY", total_balance: "10.00", granted_balance: "0", topped_up_balance: "0" }],
      }), { status: 200 });
    }) as any;
    const adapter = getQuotaAdapter("https://api.deepseek.com/chat/completions");
    await adapter!.queryQuota({ name: "ds", baseUrl: "https://api.deepseek.com/chat/completions", apiKey: "k", models: [] } as LLMProvider, 5000);
    expect((capturedInit!.headers as Record<string, string>)["Accept-Encoding"]).toBe("identity");
  });
});