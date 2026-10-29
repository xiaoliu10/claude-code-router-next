/**
 * Tests for the loader's subscription-dispatcher closure
 * (provider-plugins/loader.ts resolveSubscriptionDispatcher): the explicit
 * SUBSCRIPTION_PROXY_URL opt-in from the live server config, the initConfig env
 * mirror fallback for host-less loaders, and the unset → direct default.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ProxyAgent } from "undici";
import { getDirectDispatcher } from "../services/proxy";
import { resolveSubscriptionDispatcher } from "../provider-plugins/loader";

afterEach(() => {
  delete process.env.SUBSCRIPTION_PROXY_URL;
});

describe("resolveSubscriptionDispatcher", () => {
  it("prefers the live server configService over the env mirror", () => {
    process.env.SUBSCRIPTION_PROXY_URL = "http://127.0.0.1:11111";
    const dispatcher = resolveSubscriptionDispatcher({
      configService: { get: (key: string) => (key === "SUBSCRIPTION_PROXY_URL" ? "http://127.0.0.1:12222" : undefined) },
    });
    expect(dispatcher).toBeInstanceOf(ProxyAgent);
    // Cache identity: same URL → same cached ProxyAgent.
    expect(resolveSubscriptionDispatcher({
      configService: { get: (key: string) => (key === "SUBSCRIPTION_PROXY_URL" ? "http://127.0.0.1:12222" : undefined) },
    })).toBe(dispatcher);
  });

  it("falls back to the initConfig env mirror when the server has no configService", () => {
    process.env.SUBSCRIPTION_PROXY_URL = "http://127.0.0.1:13333";
    expect(resolveSubscriptionDispatcher(undefined)).toBeInstanceOf(ProxyAgent);
    expect(resolveSubscriptionDispatcher({})).toBeInstanceOf(ProxyAgent);
  });

  it("stays fully direct when unset (string only; non-string config values mean unset)", () => {
    expect(resolveSubscriptionDispatcher(undefined)).toBe(getDirectDispatcher());
    expect(resolveSubscriptionDispatcher({
      configService: { get: () => true }, // the hostile-mock shape that regressed once
    })).toBe(getDirectDispatcher());
    expect(resolveSubscriptionDispatcher({
      configService: { get: (key: string) => (key === "SUBSCRIPTION_PROXY_URL" ? "" : undefined) },
    })).toBe(getDirectDispatcher());
  });
});
