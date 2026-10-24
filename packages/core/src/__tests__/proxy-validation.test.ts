import { describe, expect, it } from "vitest";
import { ProxyAgent } from "undici";
import {
  validateProxyUrl,
  findInvalidProxyUrls,
  PROXY_URL_KEYS,
  SUBSCRIPTION_PROXY_URL_KEY,
  getSubscriptionProxyUrl,
  getSubscriptionDispatcher,
  getDirectDispatcher,
} from "../services/proxy";

describe("validateProxyUrl", () => {
  it("accepts empty / nullish values as 'no proxy'", () => {
    expect(validateProxyUrl("")).toEqual({ ok: true });
    expect(validateProxyUrl("   ")).toEqual({ ok: true });
    expect(validateProxyUrl(undefined)).toEqual({ ok: true });
    expect(validateProxyUrl(null)).toEqual({ ok: true });
  });

  it("accepts http:// and https:// URLs", () => {
    expect(validateProxyUrl("http://127.0.0.1:7890")).toEqual({ ok: true });
    expect(validateProxyUrl("https://proxy.example:8443")).toEqual({ ok: true });
    expect(validateProxyUrl("  http://localhost:18080  ")).toEqual({ ok: true });
  });

  it("accepts values containing $VAR / ${VAR} placeholders (raw config)", () => {
    expect(validateProxyUrl("$PROXY_URL")).toEqual({ ok: true });
    expect(validateProxyUrl("${PROXY_URL}")).toEqual({ ok: true });
    expect(validateProxyUrl("http://${PROXY_HOST}:8080")).toEqual({ ok: true });
    expect(validateProxyUrl("$HTTPS_PROXY")).toEqual({ ok: true });
  });

  it("rejects unsupported protocols", () => {
    const result = validateProxyUrl("socks5://localhost:1080");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("socks5:");
      expect(result.error).toContain("http");
    }
  });

  it("rejects malformed URLs", () => {
    const result = validateProxyUrl("not a url");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Invalid proxy URL");
    }
  });

  it("does not accept placeholders that are not env-var shaped", () => {
    // "$$" is not a valid $VAR pattern; URL parser will reject it.
    const result = validateProxyUrl("$$://broken");
    expect(result.ok).toBe(false);
  });
});

describe("findInvalidProxyUrls", () => {
  it("returns no errors when the config has no proxy keys", () => {
    expect(findInvalidProxyUrls({ HOST: "0.0.0.0", PORT: 3456 })).toEqual([]);
  });

  it("returns no errors when every proxy URL is valid", () => {
    expect(
      findInvalidProxyUrls({
        PROXY_URL: "http://127.0.0.1:7890",
        HTTPS_PROXY: "${PROXY_URL}",
      })
    ).toEqual([]);
  });

  it("collects an error per invalid key, including compatibility aliases", () => {
    const errors = findInvalidProxyUrls({
      PROXY_URL: "socks5://localhost:1080",
      https_proxy: "ftp://example",
      httpsProxy: "not a url",
    });
    expect(errors).toHaveLength(3);
    const keys = errors.map((e) => e.key).sort();
    expect(keys).toEqual(["PROXY_URL", "https_proxy", "httpsProxy"].sort());
  });

  it("skips nullish and empty values", () => {
    expect(
      findInvalidProxyUrls({
        PROXY_URL: "",
        HTTPS_PROXY: null,
        httpsProxy: undefined,
      })
    ).toEqual([]);
  });

  it("PROXY_URL_KEYS includes the documented compatibility aliases", () => {
    expect(PROXY_URL_KEYS).toContain("PROXY_URL");
    expect(PROXY_URL_KEYS).toContain("HTTPS_PROXY");
    expect(PROXY_URL_KEYS).toContain("https_proxy");
    expect(PROXY_URL_KEYS).toContain("httpsProxy");
  });
});

describe("SUBSCRIPTION_PROXY_URL (subscription plugins' fixed origins)", () => {
  const configServiceOf = (config: Record<string, unknown>) => ({
    get: <T,>(key: string): T => config[key] as T,
  });

  it("is a separate explicit key, but its value is validated by the same save gate", () => {
    expect(PROXY_URL_KEYS).not.toContain(SUBSCRIPTION_PROXY_URL_KEY);
    expect(findInvalidProxyUrls({ [SUBSCRIPTION_PROXY_URL_KEY]: "socks5://localhost:1080" })).toEqual([
      { key: SUBSCRIPTION_PROXY_URL_KEY, error: expect.stringContaining("socks5:") },
    ]);
    expect(findInvalidProxyUrls({ [SUBSCRIPTION_PROXY_URL_KEY]: "http://127.0.0.1:7897" })).toEqual([]);
  });

  it("getSubscriptionProxyUrl resolves the trimmed value, undefined when unset/blank", () => {
    expect(getSubscriptionProxyUrl(configServiceOf({}))).toBeUndefined();
    expect(getSubscriptionProxyUrl(configServiceOf({ [SUBSCRIPTION_PROXY_URL_KEY]: "" }))).toBeUndefined();
    expect(getSubscriptionProxyUrl(configServiceOf({ [SUBSCRIPTION_PROXY_URL_KEY]: "   " }))).toBeUndefined();
    expect(getSubscriptionProxyUrl(configServiceOf({ [SUBSCRIPTION_PROXY_URL_KEY]: " http://127.0.0.1:7897 " }))).toBe("http://127.0.0.1:7897");
  });

  it("getSubscriptionProxyUrl treats non-string values as unset (never a garbage URL)", () => {
    for (const garbage of [true, false, 1, 0, {}, []]) {
      expect(getSubscriptionProxyUrl(configServiceOf({ [SUBSCRIPTION_PROXY_URL_KEY]: garbage }))).toBeUndefined();
    }
    // And the dispatcher for such a value is the direct agent, not a throw.
    expect(getSubscriptionDispatcher(getSubscriptionProxyUrl(configServiceOf({ [SUBSCRIPTION_PROXY_URL_KEY]: true })))).toBe(getDirectDispatcher());
  });

  it("getSubscriptionDispatcher falls back to the shared direct agent when unset", () => {
    expect(getSubscriptionDispatcher(undefined)).toBe(getDirectDispatcher());
    expect(getSubscriptionDispatcher("")).toBe(getDirectDispatcher());
  });

  it("returns a cached ProxyAgent for a configured http(s) URL", () => {
    const a = getSubscriptionDispatcher("http://127.0.0.1:17897");
    const b = getSubscriptionDispatcher("http://127.0.0.1:17897");
    expect(a).toBe(b);
    expect(a).toBeInstanceOf(ProxyAgent);
    // A different URL must not share the dispatcher.
    expect(getSubscriptionDispatcher("http://127.0.0.1:17898")).not.toBe(a);
  });

  it("throws on unsupported proxy protocols — fails loudly, never silently direct", () => {
    expect(() => getSubscriptionDispatcher("socks5://127.0.0.1:1080")).toThrow(TypeError);
  });
});
