import { describe, it, expect } from "vitest";
import {
  CCR_SELF_PROVIDER_NAME,
  CCR_SELF_PROVIDER_DELETED_FLAG,
  ensureCcrSelfProvider,
  isCcrSelfProvider,
} from "../self-provider";

function baseConfig(): Record<string, any> {
  return {
    PORT: 4567,
    APIKEY: "secret-key",
    Providers: [
      { name: "kimi", api_base_url: "https://api.kimi.com", api_key: "k", models: ["k2"] },
    ],
  };
}

describe("ensureCcrSelfProvider", () => {
  it("appends the preset self provider with family aliases", () => {
    const config = baseConfig();
    const { changed } = ensureCcrSelfProvider(config);

    expect(changed).toBe(true);
    const ccr = config.Providers.find((p: any) => p.name === CCR_SELF_PROVIDER_NAME);
    expect(ccr).toMatchObject({
      api_base_url: "http://127.0.0.1:4567/v1/messages",
      api_key: "secret-key",
      ccr_managed: true,
      enabled: true,
      transformer: { use: ["Anthropic"] },
    });
    expect(ccr.models).toEqual(["ccr-opus", "ccr-sonnet", "ccr-haiku"]);
    // Existing providers keep their order.
    expect(config.Providers[0].name).toBe("kimi");
  });

  it("is idempotent and never touches an existing provider named ccr", () => {
    const config = baseConfig();
    config.Providers.push({
      name: "ccr",
      api_base_url: "http://127.0.0.1:9999/v1/messages",
      api_key: "user-key",
      models: ["custom"],
    });
    const { changed } = ensureCcrSelfProvider(config);

    expect(changed).toBe(false);
    const ccr = config.Providers.find((p: any) => p.name === "ccr");
    expect(ccr.api_key).toBe("user-key");
    expect(ccr.ccr_managed).toBeUndefined();
    expect(config.Providers).toHaveLength(2);
  });

  it("records a tombstone when a save drops the managed provider", () => {
    const oldConfig = baseConfig();
    oldConfig.Providers.push({
      name: "ccr",
      api_base_url: "http://127.0.0.1:4567/v1/messages",
      api_key: "secret-key",
      models: ["ccr-opus"],
      ccr_managed: true,
    });
    const newConfig = baseConfig(); // managed provider removed
    const { changed } = ensureCcrSelfProvider(newConfig, oldConfig);

    expect(changed).toBe(false);
    expect(newConfig[CCR_SELF_PROVIDER_DELETED_FLAG]).toBe(true);
    expect(newConfig.Providers.some((p: any) => p.name === "ccr")).toBe(false);
  });

  it("never re-adds after the tombstone is set", () => {
    const config = baseConfig();
    config[CCR_SELF_PROVIDER_DELETED_FLAG] = true;
    const { changed } = ensureCcrSelfProvider(config);

    expect(changed).toBe(false);
    expect(config.Providers).toHaveLength(1);
  });

  it("falls back to lowercase providers key and defaults port/key", () => {
    const config: Record<string, any> = { providers: [], APIKEY: "" };
    const { changed } = ensureCcrSelfProvider(config);

    expect(changed).toBe(true);
    const ccr = config.providers[0];
    expect(ccr.api_base_url).toBe("http://127.0.0.1:3456/v1/messages");
    expect(ccr.api_key).toBe("test");
  });

  it("isCcrSelfProvider requires both the name and the managed flag", () => {
    expect(isCcrSelfProvider({ name: "ccr", ccr_managed: true })).toBe(true);
    expect(isCcrSelfProvider({ name: "ccr" })).toBe(false);
    expect(isCcrSelfProvider({ name: "other", ccr_managed: true })).toBe(false);
    expect(isCcrSelfProvider(null)).toBe(false);
  });
});
