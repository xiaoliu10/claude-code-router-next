import { describe, it, expect } from "vitest";
import { DefaultThinkingTransformer, sniffEndpointKind } from "../transformer/defaultthinking.transformer";
import { convertToAnthropic } from "../utils/converter";
import { ProviderService } from "../services/provider";
import { TransformerService } from "../services/transformer";
import { UnifiedChatRequest } from "../types/llm";

function makeRequest(overrides?: Partial<UnifiedChatRequest>): UnifiedChatRequest {
  return {
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
    model: "test-model",
    stream: true,
    ...overrides,
  };
}

describe("sniffEndpointKind", () => {
  it("detects anthropic, responses and chat endpoints", () => {
    expect(sniffEndpointKind("https://open.bigmodel.cn/api/anthropic/v1/messages")).toBe("anthropic");
    expect(sniffEndpointKind("https://api.openai.com/v1/responses")).toBe("responses");
    expect(sniffEndpointKind("https://api.deepseek.com/v1/chat/completions")).toBe("chat");
    expect(sniffEndpointKind("https://example.com")).toBe("chat");
    expect(sniffEndpointKind(undefined)).toBe("chat");
    expect(sniffEndpointKind("not-a-url")).toBe("chat");
  });
});

describe("DefaultThinkingTransformer", () => {
  it("injects reasoning_effort for OpenAI-compatible chat endpoints", async () => {
    const t = new DefaultThinkingTransformer({ level: "high" });
    const request = makeRequest();
    const result: any = await t.transformRequestIn(request, {
      baseUrl: "https://api.deepseek.com/v1/chat/completions",
    });
    expect(result.reasoning_effort).toBe("high");
    expect(result.reasoning).toBeUndefined();
  });

  it("injects unified reasoning for Anthropic and Responses endpoints", async () => {
    const t = new DefaultThinkingTransformer({ level: "medium" });
    const anthropicResult = await t.transformRequestIn(makeRequest(), {
      baseUrl: "https://open.bigmodel.cn/api/anthropic/v1/messages",
    });
    expect(anthropicResult.reasoning).toEqual({ enabled: true, effort: "medium" });

    const responsesResult = await t.transformRequestIn(makeRequest(), {
      baseUrl: "https://api.openai.com/v1/responses",
    });
    expect(responsesResult.reasoning).toEqual({ enabled: true, effort: "medium" });
  });

  it("never overrides client-set reasoning, even when disabled", async () => {
    const t = new DefaultThinkingTransformer({ level: "high" });
    const explicitOff = makeRequest({
      reasoning: { enabled: false, effort: "low" },
    });
    const result: any = await t.transformRequestIn(explicitOff, {
      baseUrl: "https://api.deepseek.com/v1/chat/completions",
    });
    expect(result.reasoning_effort).toBeUndefined();
    expect(result.reasoning).toEqual({ enabled: false, effort: "low" });
  });

  it("is a no-op for level none or missing", async () => {
    const none = new DefaultThinkingTransformer({ level: "none" });
    const request = makeRequest();
    const result: any = await none.transformRequestIn(request, {
      baseUrl: "https://api.deepseek.com/v1/chat/completions",
    });
    expect(result.reasoning_effort).toBeUndefined();

    const noOptions = new DefaultThinkingTransformer(undefined);
    const result2: any = await noOptions.transformRequestIn(makeRequest(), {
      baseUrl: "https://api.deepseek.com/v1/chat/completions",
    });
    expect(result2.reasoning_effort).toBeUndefined();
  });

  it("is registered under the defaultthinking name", async () => {
    const mockConfig = { get: () => [] } as any;
    const ts = new TransformerService(mockConfig, { info: () => {}, error: () => {} });
    await ts.initialize();
    expect(ts.getTransformer("defaultthinking")).toBeDefined();
  });
});

describe("convertToAnthropic reasoning mapping", () => {
  it("maps enabled reasoning to an Anthropic thinking block with a clamped budget", () => {
    const body: any = convertToAnthropic(
      makeRequest({
        max_tokens: 4096,
        reasoning: { enabled: true, effort: "high" },
      })
    );
    // high=16384 clamped below max_tokens 4096 -> 3072
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 3072 });

    const roomy: any = convertToAnthropic(
      makeRequest({
        max_tokens: 64000,
        reasoning: { enabled: true, effort: "medium" },
      })
    );
    expect(roomy.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
  });

  it("honors explicit reasoning.max_tokens as the budget", () => {
    const body: any = convertToAnthropic(
      makeRequest({
        max_tokens: 32000,
        reasoning: { enabled: true, max_tokens: 4096 },
      })
    );
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  it("omits thinking when reasoning is absent, disabled, or no budget fits", () => {
    const absent: any = convertToAnthropic(makeRequest({ max_tokens: 4096 }));
    expect(absent.thinking).toBeUndefined();

    const disabled: any = convertToAnthropic(
      makeRequest({ max_tokens: 4096, reasoning: { enabled: false } })
    );
    expect(disabled.thinking).toBeUndefined();

    const tooSmall: any = convertToAnthropic(
      makeRequest({ max_tokens: 1024, reasoning: { enabled: true, effort: "high" } })
    );
    expect(tooSmall.thinking).toBeUndefined();
  });
});

describe("ProviderService injects default_thinking_level", () => {
  it("prepends a defaultthinking transformer when the provider config sets it", async () => {
    const mockConfig = {
      get: (key: string) => {
        if (key === "providers") {
          return [
            {
              name: "p1",
              api_base_url: "https://api.deepseek.com/v1/chat/completions",
              api_key: "k",
              models: ["m1"],
              default_thinking_level: "high",
              transformer: { use: ["deepseek"] },
            },
          ];
        }
        return undefined;
      },
    } as any;
    const ts = new TransformerService(mockConfig, { info: () => {}, error: () => {} });
    await ts.initialize();
    const ps = new ProviderService(mockConfig, ts, { info: () => {}, warn: () => {}, error: () => {} });

    const provider = ps.getProvider("p1")!;
    expect(provider).toBeDefined();
    expect(provider.transformer?.use?.length).toBe(2);
    expect((provider.transformer?.use?.[0] as any).constructor.TransformerName).toBe("defaultthinking");

    // The injected transformer carries the configured level.
    const injected = provider.transformer!.use![0] as any;
    const result: any = await injected.transformRequestIn(makeRequest(), provider);
    expect(result.reasoning_effort).toBe("high");
  });

  it("does not inject when default_thinking_level is unset", async () => {
    const mockConfig = {
      get: (key: string) => {
        if (key === "providers") {
          return [
            {
              name: "p2",
              api_base_url: "https://api.deepseek.com/v1/chat/completions",
              api_key: "k",
              models: ["m1"],
            },
          ];
        }
        return undefined;
      },
    } as any;
    const ts = new TransformerService(mockConfig, { info: () => {}, error: () => {} });
    await ts.initialize();
    const ps = new ProviderService(mockConfig, ts, { info: () => {}, warn: () => {}, error: () => {} });

    const provider = ps.getProvider("p2")!;
    expect(provider.transformer?.use).toBeUndefined();
  });
});
