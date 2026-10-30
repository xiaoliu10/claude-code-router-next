import { beforeEach, describe, expect, it } from "vitest";
import { getHealthStore } from "../services/provider-health";
import { listAnthropicCompatibleModels } from "../ccr/models";

/**
 * Degradation is provider-agnostic: whatever a provider's kind (plain API key,
 * OAuth subscription, plugin), an exhausted/blocked model must stop being
 * offered to clients while its circuit is open, and come back once it recovers.
 */
const config = {
  Providers: [
    { name: "plain", api_base_url: "https://plain.example/v1/messages", api_key: "k", models: ["m1", "m2"] },
    { name: "sub", api_base_url: "https://sub.example/v1/messages", api_key: "ccr-managed-sub", models: ["s1"] },
  ],
};

const ids = (filter?: (provider: string, model: string) => boolean) =>
  listAnthropicCompatibleModels(config, filter).map((m) => m.id);

describe("model list degradation", () => {
  beforeEach(() => getHealthStore().clear());

  it("lists every model when nothing is unhealthy", () => {
    const all = ids();
    expect(all).toContain("m1");
    expect(all).toContain("plain,m1");
    expect(all).toContain("s1");
    expect(all).toContain("sub,s1");
  });

  it("hides a circuit-open model and its provider-qualified alias", () => {
    const health = getHealthStore();
    // Any provider kind follows the same rule.
    for (const p of ["plain", "sub"]) {
      const model = p === "plain" ? "m1" : "s1";
      health.forceOpen(p, model, "quota exhausted");
      const all = ids((provider, m) => health.isAvailable(provider, m));
      expect(all).not.toContain(model);
      expect(all).not.toContain(`${p},${model}`);
      // Sibling models of the same provider stay available.
      if (p === "plain") expect(all).toContain("m2");
      health.clear();
    }
  });

  it("restores the model once the circuit closes again", () => {
    const health = getHealthStore();
    health.forceOpen("sub", "s1", "upstream 503");
    expect(ids((p, m) => health.isAvailable(p, m))).not.toContain("s1");

    health.recover("sub", "s1");
    expect(ids((p, m) => health.isAvailable(p, m))).toContain("s1");
  });

  it("keeps the bare alias while another provider still serves the same name", () => {
    const shared = {
      Providers: [
        { name: "a", api_base_url: "https://a.example/v1", api_key: "k", models: ["shared"] },
        { name: "b", api_base_url: "https://b.example/v1", api_key: "k", models: ["shared"] },
      ],
    };
    const health = getHealthStore();
    health.forceOpen("a", "shared", "dead");
    const all = listAnthropicCompatibleModels(shared, (p, m) => health.isAvailable(p, m)).map((m) => m.id);
    // b is healthy, so the bare id must remain offered; only a's alias is gone.
    expect(all).toContain("shared");
    expect(all).toContain("b,shared");
    expect(all).not.toContain("a,shared");
  });

  it("never breaks discovery when the filter throws", () => {
    const all = ids(() => {
      throw new Error("boom");
    });
    expect(all).toContain("m1");
  });
});
