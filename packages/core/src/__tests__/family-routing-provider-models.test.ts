import { describe, expect, it, vi, beforeEach } from "vitest";
import { ConfigService } from "../services/config";
import { findProviderModel, router } from "../utils/router";

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

async function route(model: string, routerOverrides: Record<string, any> = {}): Promise<{ model: string | undefined; originalModel: string | undefined }> {
  const config = routeConfig(routerOverrides);
  const req = routeRequest(model);
  await router(req as any, undefined, { configService: config });
  return { model: (req.body as any).model, originalModel: (req as any).originalModel };
}

async function routeModel(model: string, routerOverrides: Record<string, any> = {}): Promise<string | undefined> {
  return (await route(model, routerOverrides)).model;
}

/** The routed model must resolve through the same catalog lookup dispatch uses. */
function resolvesInCatalog(routed: string | undefined): boolean {
  if (!routed) return false;
  const [providerName, ...rest] = routed.split(",");
  const modelPart = rest.join(",");
  const config = routeConfig();
  const providers = (config as any).getAll().providers;
  return findProviderModel(providers, providerName, modelPart) !== null;
}

beforeEach(() => {
  vi.clearAllMocks();
});

const FAMILY_MODEL = "glm,glm-5.3-flash";

describe("family routing does not hijack exact provider models", () => {
  it("dispatches a bare provider-exposed claude model to its provider", async () => {
    const routed = await route("claude-opus-5-5");
    expect(routed.model).toBe("gemini-oauth,claude-opus-5-5");
    // originalModel keeps the client spelling even for catalog-cased input.
    expect(routed.originalModel).toBe("claude-opus-5-5");
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

  it("matches provider models case-insensitively and dispatches the canonical id", async () => {
    // findProviderModel lowercases both sides; the family gate must agree, and
    // dispatch must receive the CANONICAL catalog spelling (review probe P3).
    expect(await routeModel("Claude-Opus-5-5")).toBe("gemini-oauth,claude-opus-5-5");
  });

  it("normalizes the [1m] suffix away and dispatches the canonical id", async () => {
    // The suffix is a family-routing marker; wire ids must stay canonical or
    // downstream findProviderModel/transformer resolution fails (review M1).
    const routed = await route("claude-opus-5-5[1m]");
    expect(routed.model).toBe("gemini-oauth,claude-opus-5-5");
    // The client spelling survives for usage records.
    expect(routed.originalModel).toBe("claude-opus-5-5[1m]");
  });

  it("canonicalizes qualified names with [1m] or case variants through the explicit block", async () => {
    // The explicit comma block resolves the canonical id with its normal
    // fail-pool + fallback semantics; the client spelling stays in originalModel.
    expect(await routeModel("gemini-oauth,claude-opus-5-5[1m]")).toBe("gemini-oauth,claude-opus-5-5");
    expect(await routeModel("gemini-oauth,Claude-Opus-5-5")).toBe("gemini-oauth,claude-opus-5-5");
  });

  it("routes every exempted name to an id the dispatch catalog can resolve", async () => {
    for (const input of ["claude-opus-5-5", "Claude-Opus-5-5", "claude-opus-5-5[1m]", "gemini-oauth,claude-opus-5-5", "gemini-oauth, claude-opus-5-5", "gemini-oauth,claude-opus-5-5[1m]", "gemini-oauth,Claude-Opus-5-5"]) {
      expect(resolvesInCatalog(await routeModel(input)), `routed id for ${input} must resolve`).toBe(true);
    }
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

  it("keeps an explicit Router.models mapping above bare exact-model name fidelity", async () => {
    // Review probe P7: a deliberate mapping must still win over the exemption
    // for bare names.
    expect(await routeModel("claude-opus-5-5", { models: { "claude-opus-5-5": FAMILY_MODEL } })).toBe(FAMILY_MODEL);
  });

  it("documents the qualified-name exception: explicit comma block precedes Router.models", async () => {
    // Pre-existing precedence (locked down per review Minor): a qualified
    // "provider,model" request is resolved by the explicit block BEFORE
    // Router.models mapping is consulted.
    expect(await routeModel("gemini-oauth,claude-opus-5-5", { models: { "gemini-oauth,claude-opus-5-5": FAMILY_MODEL } })).toBe("gemini-oauth,claude-opus-5-5");
  });
});
