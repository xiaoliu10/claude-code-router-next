import { describe, it, expect } from "vitest";
import { maskHeaders } from "../utils/debug-log";
describe("debug header redaction", () => {
  it("masks credential-bearing headers without losing token quota diagnostics", () => {
    const result = maskHeaders({ Authorization: "secret", "X-Refresh-Token": "refresh", "X-Access-Token": "access",
      "x-ratelimit-remaining-tokens": "42", "anthropic-ratelimit-input-tokens-limit": "1000", "x-conversation-request-id": "turn" });
    expect(result.Authorization).toBe("***MASKED***");
    expect(result["X-Refresh-Token"]).toBe("***MASKED***");
    expect(result["X-Access-Token"]).toBe("***MASKED***");
    expect(result["x-ratelimit-remaining-tokens"]).toBe("42");
    expect(result["anthropic-ratelimit-input-tokens-limit"]).toBe("1000");
    expect(result["x-conversation-request-id"]).toBe("turn");
  });
});
