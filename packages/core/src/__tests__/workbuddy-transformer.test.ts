import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkBuddyTransformer } from "../transformer/workbuddy.transformer";
import { WorkBuddyAuthService, type WorkBuddyFetch } from "../services/workbuddy-auth";
import { WorkBuddyCredentialStore, type WorkBuddyCredential } from "../services/workbuddy";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "chat-access-token";
const CRED: WorkBuddyCredential = {
  version: 1, kind: "workbuddy", uid: "u-1", displayName: "Nick", domain: "",
  enterpriseId: "", accessToken: TOKEN, expiresAt: 0,
  importedAt: "2026-10-19T00:00:00.000Z", source: "desktop",
};

/**
 * Async harness: the credential is saved up-front because transformRequestIn
 * injects the WorkBuddy auth headers for the non-bypass pipeline path.
 */
async function harness() {
  const dir = mkdtempSync(join(tmpdir(), "wb-tr-"));
  const store = new WorkBuddyCredentialStore(join(dir, "creds.json"));
  const authService = new WorkBuddyAuthService({
    configService: { get: () => undefined, getAll: () => ({}), reload: vi.fn(), set: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    fetch: (async () => new Response("{}")) as WorkBuddyFetch,
    store,
  });
  dirs.push(dir);
  await store.save(CRED);
  return { dir, store, authService, transformer: new WorkBuddyTransformer({ authService }) };
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const baseRequest = () => ({
  model: "glm-5.3",
  messages: [{ role: "user", content: "hi" }],
  max_completion_tokens: 4096,
  tools: [
    { type: "function", function: { name: "read.file", description: "read", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "write", description: "write", parameters: { type: "object", properties: {} } } },
  ],
  tool_choice: { type: "function", function: { name: "read.file" } },
});

describe("WorkBuddy transformer request quirks", () => {
  /** transformRequestIn returns { body, config } so the pipeline can merge the
   *  WorkBuddy headers; the quirk assertions read the rewritten body. */
  const run = async (req: any, context: any = {}) => {
    const { transformer } = await harness();
    return (await transformer.transformRequestIn(req, {} as any, context)).body;
  };

  it("renames max_completion_tokens, developer→system and prepends a default system", async () => {
    const out = await run({
      model: "m",
      messages: [
        { role: "developer", content: "dev" } as any,
        { role: "user", content: "hi" } as any,
      ],
      max_completion_tokens: 100,
    });
    expect(out.max_tokens).toBe(100);
    expect(out.max_completion_tokens).toBeUndefined();
    // developer already became system, so no default system is prepended.
    expect(out.messages[0]).toEqual({ role: "system", content: "dev" });
    expect(out.messages[1]).toMatchObject({ role: "user", content: "hi" });
  });

  it("prepends a default system message when the first message is not system", async () => {
    const out = await run({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(out.messages[0]).toEqual({ role: "system", content: "You are a helpful assistant." });
    expect(out.messages[1]).toMatchObject({ role: "user", content: "hi" });
  });

  it("keeps an existing max_tokens over max_completion_tokens", async () => {
    const out = await run({
      model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 10, max_completion_tokens: 99,
    });
    expect(out.max_tokens).toBe(10);
    expect(out.max_completion_tokens).toBeUndefined();
  });

  it("normalizes tool_choice shapes and drops tools for none", async () => {
    const cases: Array<[any, any]> = [
      [{ type: "auto" }, "auto"],
      [{ type: "required" }, "required"],
      [{ type: "function", function: { name: "write" } }, "write"],
      [{ type: "function", function: { name: "read.file" } }, "read_file"],
    ];
    for (const [input, expected] of cases) {
      const out = await run({ ...baseRequest(), tool_choice: input });
      expect(out.tool_choice).toBe(expected);
      expect(out.tools).toBeDefined();
    }
    const none = await run({ ...baseRequest(), tool_choice: "none" });
    expect(none.tool_choice).toBeUndefined();
    expect(none.tools).toBeUndefined();
  });

  it("sanitizes tool names and stores a request-local reverse map", async () => {
    const { transformer } = await harness();
    const contextA: any = {};
    const contextB: any = {};
    const outA = (await transformer.transformRequestIn(baseRequest() as any, {} as any, contextA)).body;
    const outB = (await transformer.transformRequestIn(baseRequest() as any, {} as any, contextB)).body;

    expect(outA.tools.map((t: any) => t.function.name)).toEqual(["read_file", "write"]);
    expect(outA.tool_choice).toBe("read_file");
    expect(contextA.workbuddyToolNames.get("read_file")).toBe("read.file");
    // No shared module-level map: the two contexts are independent objects.
    expect(contextB.workbuddyToolNames).not.toBe(contextA.workbuddyToolNames);
  });

  it("restores original tool names in a JSON response", async () => {
    const { transformer } = await harness();
    const context: any = {};
    await transformer.transformRequestIn(baseRequest() as any, {} as any, context);
    const response = new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ id: "1", function: { name: "read_file", arguments: "{}" } }] } }],
    }), { headers: { "Content-Type": "application/json" } });
    const out = await transformer.transformResponseOut(response, context);
    const json = await out.json();
    expect(json.choices[0].message.tool_calls[0].function.name).toBe("read.file");
  });
});

describe("WorkBuddy transformer auth hook", () => {
  it("returns the fixed HTTPS URL and a real Bearer token that overrides the marker", async () => {
    const { transformer, dir } = await harness();
    dirs.push(dir);
    const store = new WorkBuddyCredentialStore(join(dir, "creds.json"));
    await store.save(CRED);
    const auth = await transformer.auth({ messages: [{ role: "user", content: "hi" }], model: "glm-5.3" }, {
      name: "workbuddy", api_key: "ccr-managed-workbuddy", baseUrl: "https://evil.example.com/v1",
    } as any);

    expect(auth.config.url).toBe("https://copilot.tencent.com/v2/chat/completions");
    expect(auth.config.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    // routes.ts merges { Authorization: Bearer provider.apiKey, ...auth.config.headers }
    const merged = { Authorization: "Bearer ccr-managed-workbuddy", ...auth.config.headers };
    expect(merged.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(auth.config.headers["X-User-Id"]).toBe("u-1");
    expect(auth.config.headers["User-Agent"]).toBe("WorkBuddy/5.5.6");
    expect(auth.config.headers["X-Conversation-Message-ID"]).toMatch(/^[0-9a-f]{32}$/);
    expect(auth.config.headers["X-Request-ID"]).toBe(auth.config.headers["X-Conversation-Message-ID"]);
  });

  it("never sends the marker api_key upstream", async () => {
    const { transformer, dir } = await harness();
    dirs.push(dir);
    await new WorkBuddyCredentialStore(join(dir, "creds.json")).save(CRED);
    const auth = await transformer.auth({ messages: [], model: "m" }, { name: "workbuddy", api_key: "ccr-managed-workbuddy" } as any);
    expect(JSON.stringify(auth)).not.toContain("ccr-managed-workbuddy");
  });
});

describe("WorkBuddy SSE rewriting", () => {
  const sse = (chunks: string[]) => {
    const encoder = new TextEncoder();
    let i = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(c) { if (i === chunks.length) c.close(); else c.enqueue(encoder.encode(chunks[i++])); },
    }), { headers: { "Content-Type": "text/event-stream" } });
  };

  const collect = async (response: Response) => {
    const text = await response.text();
    return text;
  };

  it("passes comments, [DONE], usage-only and malformed lines through verbatim", async () => {
    const { transformer } = await harness();
    const context: any = {};
    await transformer.transformRequestIn(baseRequest() as any, {} as any, context);
    const body = [
      ": keep-alive ping\n",
      "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n",
      "\n",
      "data: {\"choices\":[],\"usage\":{\"total_tokens\":7}}\n",
      "\n",
      "data: not json at all\n",
      "\n",
      "data: [DONE]\n\n",
    ];
    const out = await transformer.transformResponseOut(sse(body), context);
    expect(await collect(out)).toBe(body.join(""));
  });

  it("restores tool names across argument fragments", async () => {
    const { transformer } = await harness();
    const context: any = {};
    await transformer.transformRequestIn(baseRequest() as any, {} as any, context);
    const body = [
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"read_file\"}}]}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"a\\\":\"}}]}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"1}\"}}]}}]}\n\n",
      "data: [DONE]\n\n",
    ];
    const out = await transformer.transformResponseOut(sse(body), context);
    const text = await collect(out);
    expect(text).toContain("\"name\":\"read.file\"");
    expect(text).toContain("[DONE]");
    // argument fragments untouched
    expect(text).toContain("{\\\"a\\\":");
    expect(text).toContain("1}");
  });

  it("preserves CRLF line endings and split multi-byte UTF-8", async () => {
    const { transformer } = await harness();
    const context: any = {};
    await transformer.transformRequestIn(baseRequest() as any, {} as any, context);
    const encoder = new TextEncoder();
    const chunk1 = encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"中文\"");
    const chunk2 = encoder.encode("}}]}\r\n\r\n");
    const response = new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(chunk1); c.enqueue(chunk2); c.close(); },
    }), { headers: { "Content-Type": "text/event-stream" } });
    const out = await transformer.transformResponseOut(response, context);
    expect(await collect(out)).toBe("data: {\"choices\":[{\"delta\":{\"content\":\"中文\"}}]}\r\n\r\n");
  });

  it("logs finish_reason=error without dropping the chunk", async () => {
    const { transformer, authService } = await harness();
    const logger = { warn: vi.fn() };
    (transformer as any).logger = logger;
    void authService;
    const context: any = {};
    const body = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":\"error\"}]}\n\n",
      "data: [DONE]\n\n",
    ];
    const out = await transformer.transformResponseOut(sse(body), context);
    const text = await collect(out);
    expect(text).toContain("finish_reason");
    expect(text).toContain("[DONE]");
    expect(logger.warn).toHaveBeenCalled();
  });
});
