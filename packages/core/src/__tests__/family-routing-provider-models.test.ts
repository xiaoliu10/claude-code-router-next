import { describe, expect, it, vi, beforeEach } from "vitest";
import { ConfigService } from "../services/config";
import { router } from "../utils/router";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function routeConfig(overrides: Record<string, any> = {}): ConfigService {
  return new ConfigService({
    useJsonFile: false,
    initialConfig: {
      providers: [
        {
          name: "gemini-oauth",
          enabled: true,
          models: ["claude-opus-5-5", "claude-sonnet-5-5", "gemini-3.8-flash"],
        },
        {
          name: "glm",
          enabled: true,
          models: ["glm-5.3-flash"],
        },
      ],
      Router: {
        enableFamilyRouting: true,
        enableFallback: false,
        families: {
          opus: { default: "glm,glm-5.3-flash" },
          sonnet: { default: "glm,glm-5.3-flash" },
        },
        ...overrides,
      },
    },
  });
}

function routeRequest(model: string): any {
  return {
    id: "route-request",
    url: "/v1/messages",
    headers: {},
    log,
    body: {
      model,
      messages: [{ role: "user", content: "hello" }],
      system: [],
      tools: [],
    },
  };
}

async function routeModel(model: string, routerOverrides: Record<string, any> = {}): Promise<string | undefined> {
  const config = routeConfig(routerOverrides);
  const req = routeRequest(model);
  await router(req as any, undefined, { configService: config });
  return (req.body as any).model;
}

beforeEach(() => {
  vi.clearAllMocks();
});

const FAMILY_MODEL = "glm,glm-5.3-flash";

describe("family routing does not hijack exact provider models", () => {
  it("dispatches a bare provider-exposed claude model to its provider", async () => {
    expect(await routeModel("claude-opus-5-5")).toBe("gemini-oauth,claude-opus-5-5");
  });

  it("keeps name fidelity when Router.default would otherwise rewrite it", async () => {
    // The stock-config hazard from review: a bare exact model must survive
    // scenario/default routing too, not just an empty Router.default fixture.
    expect(await routeModel("claude-opus-5-5", { default: FAMILY_MODEL })).toBe("gemini-oauth,claude-opus-5-5");
  });

  it("keeps a bare haiku-style exact model out of the background branch", async () => {
    // background scenario matching would otherwise claim claude+haiku names.
    expect(await routeModel("claude-sonnet-5-5", { background: FAMILY_MODEL })).toBe("gemini-oauth,claude-sonnet-5-5");
  });

  it("dispatches a provider-qualified claude model instead of the opus family", async () => {
    expect(await routeModel("gemini-oauth,claude-opus-5-5")).toBe("gemini-oauth,claude-opus-5-5");
  });

  it("matches provider models case-insensitively like dispatch does", async () => {
    // findProviderModel lowercases both sides; the family gate must agree or a
    // case variant gets hijacked by the family mapping (review probe P3).
    expect(await routeModel("Claude-Opus-5-5")).toBe("gemini-oauth,Claude-Opus-5-5");
  });

  it("ignores the [1m] extended-context suffix when matching provider models", async () => {
    expect(await routeModel("claude-opus-5-5[1m]")).toBe("gemini-oauth,claude-opus-5-5[1m]");
  });

  it("still routes unknown claude-family names through the family mapping", async () => {
    expect(await routeModel("claude-opus-4-20250514")).toBe(FAMILY_MODEL);
  });

  it("still routes the ccr-opus alias through the family mapping", async () => {
    expect(await routeModel("ccr-opus")).toBe(FAMILY_MODEL);
  });

  it("still routes non-exact sonnet names through the family mapping", async () => {
    expect(await routeModel("claude-sonnet-4-6")).toBe(FAMILY_MODEL);
  });

  it("lets a disabled provider's models fall through to the family mapping", async () => {
    // A disabled provider does not own the name (review probe P2): family
    // routing stays in charge instead of parking the request on default routing.
    const config = new ConfigService({
      useJsonFile: false,
      initialConfig: {
        providers: [
          { name: "gemini-oauth", enabled: false, models: ["claude-opus-5-5"] },
          { name: "glm", enabled: true, models: ["glm-5.3-flash"] },
        ],
        Router: {
          enableFamilyRouting: true,
          enableFallback: false,
          families: { opus: { default: FAMILY_MODEL } },
        },
      },
    });
    const req = routeRequest("claude-opus-5-5");
    await router(req as any, undefined, { configService: config });
    expect((req.body as any).model).toBe(FAMILY_MODEL);
  });

  it("keeps an explicit Router.models mapping above exact-model name fidelity", async () => {
    // Review probe P7: a deliberate mapping must still win over the exemption.
    expect(await routeModel("claude-opus-5-5", { models: { "claude-opus-5-5": FAMILY_MODEL } })).toBe(FAMILY_MODEL);
  });
});
