/**
 * codexFinalizeBody — the outbound quirk layer (docs/design/provider-plugins.md
 * §5.2; research codex-dataplane.md §2). Every assertion pins a field the
 * ChatGPT Codex backend REQUIRES or REJECTS, so a silent regression here is a
 * 400 in production, not a cosmetic difference.
 *
 * Pure function only: no network, no service, no host.
 */
import { describe, expect, it } from "vitest";
import {
  CODEX_ENCRYPTED_REASONING_INCLUDE,
  CODEX_MAX_CALL_ID,
  CODEX_MAX_ORPHAN_OUTPUT,
  codexFinalizeBody,
  codexSessionKey,
} from "../src/finalize-body";

const base = (over: Record<string, any> = {}) => ({
  model: "gpt-5.1-codex",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  ...over,
});

describe("codexFinalizeBody — stateless streaming shape", () => {
  it("forces store:false and stream:true", () => {
    const out = codexFinalizeBody(base({ store: true, stream: false }));
    expect(out.store).toBe(false);
    expect(out.stream).toBe(true);
  });

  it("drops every sampling/storage field the backend rejects", () => {
    const out = codexFinalizeBody(base({
      max_output_tokens: 100, max_completion_tokens: 100, temperature: 0.3, top_p: 0.9,
      previous_response_id: "resp_1", user: "u", safety_identifier: "s",
      prompt_cache_options: { mode: "explicit" },
    }));
    for (const key of ["max_output_tokens", "max_completion_tokens", "temperature", "top_p",
      "previous_response_id", "user", "safety_identifier", "prompt_cache_options"]) {
      expect(out).not.toHaveProperty(key);
    }
  });

  it("keeps only Codex's own service tiers", () => {
    expect(codexFinalizeBody(base({ service_tier: "priority" })).service_tier).toBe("priority");
    expect(codexFinalizeBody(base({ service_tier: "ultrafast" })).service_tier).toBe("ultrafast");
    expect(codexFinalizeBody(base({ service_tier: "flex" }))).not.toHaveProperty("service_tier");
  });

  it("sets tool_choice auto and defaults parallel_tool_calls to true without overriding an explicit value", () => {
    expect(codexFinalizeBody(base({ tool_choice: "required" })).tool_choice).toBe("auto");
    expect(codexFinalizeBody(base()).parallel_tool_calls).toBe(true);
    expect(codexFinalizeBody(base({ parallel_tool_calls: false })).parallel_tool_calls).toBe(false);
  });

  it("defaults text.verbosity but preserves an explicit text block", () => {
    expect(codexFinalizeBody(base()).text).toEqual({ verbosity: "medium" });
    expect(codexFinalizeBody(base({ text: { verbosity: "low" } })).text).toEqual({ verbosity: "low" });
  });
});

describe("codexFinalizeBody — reasoning", () => {
  it("adds the encrypted-content include and the summary default", () => {
    const out = codexFinalizeBody(base({ reasoning: { effort: "high" } }));
    expect(out.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(out.include).toEqual([CODEX_ENCRYPTED_REASONING_INCLUDE]);
  });

  it("does not duplicate an existing include entry", () => {
    const out = codexFinalizeBody(base({ reasoning: { effort: "high" }, include: [CODEX_ENCRYPTED_REASONING_INCLUDE] }));
    expect(out.include).toEqual([CODEX_ENCRYPTED_REASONING_INCLUDE]);
  });

  it("maps the Codex 'ultra' alias to max", () => {
    expect(codexFinalizeBody(base({ reasoning: { effort: "ultra" } })).reasoning.effort).toBe("max");
  });

  it("drops only the encrypted-content include when effort is none, keeping client includes", () => {
    const out = codexFinalizeBody(base({
      reasoning: { effort: "none" },
      include: [CODEX_ENCRYPTED_REASONING_INCLUDE, "file_search_call.results"],
    }));
    expect(out.include).toEqual(["file_search_call.results"]);
  });
});

describe("codexFinalizeBody — input items", () => {
  it("wraps a bare string input as a user message", () => {
    const out = codexFinalizeBody({ model: "m", input: "hello" });
    expect(out.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }]);
  });

  it("rewrites system role to developer (backend rejects system)", () => {
    const out = codexFinalizeBody(base({
      input: [{ type: "message", role: "system", content: [{ type: "input_text", text: "rules" }] }],
    }));
    expect(out.input[0].role).toBe("developer");
  });

  it("strips every item id and drops item_reference", () => {
    const out = codexFinalizeBody(base({
      input: [
        { type: "message", role: "user", id: "msg_1", content: [{ type: "input_text", text: "a" }] },
        { type: "item_reference", id: "ref_1" },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "t", arguments: "{}" },
      ],
    }));
    expect(out.input).toHaveLength(2);
    expect(out.input.some((i: any) => i.type === "item_reference")).toBe(false);
    for (const item of out.input) expect(item).not.toHaveProperty("id");
  });

  it("bounds call_ids longer than 64 characters with a stable sha256", () => {
    const long = "x".repeat(80);
    const a = codexFinalizeBody(base({
      input: [{ type: "function_call", call_id: long, name: "t", arguments: "{}" },
        { type: "function_call_output", call_id: long, output: "ok" }],
    }));
    const b = codexFinalizeBody(base({
      input: [{ type: "function_call", call_id: long, name: "t", arguments: "{}" },
        { type: "function_call_output", call_id: long, output: "ok" }],
    }));
    expect(a.input[0].call_id).toHaveLength(CODEX_MAX_CALL_ID);
    expect(a.input[0].call_id).toBe(b.input[0].call_id); // deterministic
    // The output keeps the SAME bounded id, so the pair stays matched.
    expect(a.input[1].type).toBe("function_call_output");
    expect(a.input[1].call_id).toBe(a.input[0].call_id);
  });

  it("rewrites an orphan function_call_output as an assistant message, truncated", () => {
    const out = codexFinalizeBody(base({
      input: [{ type: "function_call_output", call_id: "missing", output: "y".repeat(20000) }],
    }));
    expect(out.input).toHaveLength(1);
    expect(out.input[0].role).toBe("assistant");
    expect(out.input[0].type).toBe("message");
    const text = out.input[0].content[0].text as string;
    expect(text.length).toBeLessThanOrEqual(CODEX_MAX_ORPHAN_OUTPUT + 64);
  });

  it("keeps a matched function_call_output intact", () => {
    const out = codexFinalizeBody(base({
      input: [
        { type: "function_call", call_id: "c1", name: "t", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "result" },
      ],
    }));
    expect(out.input[1]).toMatchObject({ type: "function_call_output", call_id: "c1", output: "result" });
  });
});

describe("codexFinalizeBody — instructions", () => {
  const CODEX = "You are Codex, based on GPT-5.\nSecond line.";

  it("replaces the client's instructions with Codex's and prepends the client's as a developer message", () => {
    const out = codexFinalizeBody(base({ instructions: "client rules\nmore" }), { modelInstructions: CODEX });
    expect(out.instructions).toBe(CODEX);
    expect(out.input[0]).toMatchObject({ type: "message", role: "developer" });
    expect(out.input[0].content[0].text).toBe("client rules\nmore");
    expect(out.input[1].role).toBe("user");
  });

  it("does NOT prepend when the client instructions already ARE the Codex instructions (first line match)", () => {
    const out = codexFinalizeBody(base({ instructions: "You are Codex, based on GPT-5.\nDIFFERENT tail" }), { modelInstructions: CODEX });
    expect(out.instructions).toBe(CODEX);
    expect(out.input).toHaveLength(1);
    expect(out.input[0].role).toBe("user");
  });

  it("leaves the client's instructions alone when no Codex instructions are cached", () => {
    const out = codexFinalizeBody(base({ instructions: "client rules" }));
    expect(out.instructions).toBe("client rules");
    expect(out.input).toHaveLength(1);
  });
});

describe("codexFinalizeBody — prompt_cache_key and session key", () => {
  it("keeps a client-supplied prompt_cache_key verbatim", () => {
    const out = codexFinalizeBody(base({ prompt_cache_key: "client-key" }));
    expect(out.prompt_cache_key).toBe("client-key");
    expect(codexSessionKey(out)).toBe("client-key");
  });

  it("derives a stable 8-4-4-4-12 key for the same conversation across turns", () => {
    const turn1 = codexFinalizeBody(base({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "a" }] }] }), { sessionId: "s1" });
    const turn2 = codexFinalizeBody(base({
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "a" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "b" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "c" }] },
      ],
    }), { sessionId: "s1" });
    expect(turn1.prompt_cache_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(turn2.prompt_cache_key).toBe(turn1.prompt_cache_key);
  });

  it("derives a DIFFERENT key for a different session", () => {
    const a = codexFinalizeBody(base(), { sessionId: "s1" });
    const b = codexFinalizeBody(base(), { sessionId: "s2" });
    expect(a.prompt_cache_key).not.toBe(b.prompt_cache_key);
  });

  it("regenerates prompt_cache_key when the client value is whitespace-only", () => {
    const out = codexFinalizeBody(base({ prompt_cache_key: "   " }));
    expect(out.prompt_cache_key).not.toBe("   ");
    expect(typeof out.prompt_cache_key).toBe("string");
    expect(out.prompt_cache_key.length).toBeGreaterThan(0);
  });
});

describe("codexFinalizeBody — purity", () => {
  it("never mutates the shared input body", () => {
    const body = base({
      store: true, stream: false, temperature: 1,
      input: [{ type: "message", role: "system", id: "x", content: [{ type: "input_text", text: "a" }] }],
      reasoning: { effort: "ultra" },
    });
    const snapshot = JSON.stringify(body);
    codexFinalizeBody(body, { modelInstructions: "Codex" });
    expect(JSON.stringify(body)).toBe(snapshot);
  });

  it("returns a deep copy: mutating the output leaves the input untouched", () => {
    const body = base();
    const out = codexFinalizeBody(body);
    (out.input[0].content[0] as any).text = "changed";
    expect(body.input[0].content[0].text).toBe("hi");
  });

  it("tolerates non-object input", () => {
    expect(codexFinalizeBody(null).store).toBe(false);
    expect(codexFinalizeBody("nope").stream).toBe(true);
  });
});
