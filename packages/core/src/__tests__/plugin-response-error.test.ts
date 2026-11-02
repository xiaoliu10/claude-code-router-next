import { describe, expect, it, vi } from "vitest";
import { pluginResponseError, describeTransportFailure } from "../api/plugin-response-error";
import type { ManagedRuntime } from "../provider-plugins/types";

/** Minimal runtime stub: unclassified by default (the codex status-0 shape). */
function runtime(overrides: Partial<ManagedRuntime> = {}): ManagedRuntime {
  return {
    name: "fake",
    isManaged: () => false,
    classifyError: () => null,
    noteUpstreamError: vi.fn(async () => {}),
    ...overrides,
  } as ManagedRuntime;
}

/** The real-world 11-02 incident shape: fetch to the local subscription proxy refused. */
function fetchFailedRefused(address = "127.0.0.1", port = 7897): TypeError {
  const errno = Object.assign(new Error(`connect ${address}:${port}`), {
    code: "ECONNREFUSED", errno: -61, syscall: "connect", address, port,
  });
  return Object.assign(new TypeError("fetch failed"), { cause: errno });
}

describe("describeTransportFailure", () => {
  it("extracts errno code and address:port from a refused connect", () => {
    const t = describeTransportFailure(fetchFailedRefused());
    expect(t.errorName).toBe("TypeError");
    expect(t.causeCode).toBe("ECONNREFUSED");
    expect(t.causeDetail).toBe("127.0.0.1:7897");
  });

  it("walks one nested cause level (undici ConnectError wrapping)", () => {
    const errno = Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET", address: "1.2.3.4", port: 443 });
    const inner = Object.assign(new TypeError("connect failed"), { cause: errno });
    const outer = Object.assign(new TypeError("fetch failed"), { cause: inner });
    expect(describeTransportFailure(outer).causeCode).toBe("ECONNRESET");
    expect(describeTransportFailure(outer).causeDetail).toBe("1.2.3.4:443");
  });

  it("uses hostname for DNS failures (no address/port)", () => {
    const errno = Object.assign(new Error("getaddrinfo ENOTFOUND"), {
      code: "ENOTFOUND", syscall: "getaddrinfo", hostname: "chatgpt.example",
    });
    const err = Object.assign(new TypeError("fetch failed"), { cause: errno });
    const t = describeTransportFailure(err);
    expect(t.causeCode).toBe("ENOTFOUND");
    expect(t.causeDetail).toBe("chatgpt.example");
  });

  it("drops non-enum-like codes, hostile strings and oversized junk", () => {
    const hostile = Object.assign(new Error("secret message"), {
      code: "not-a-valid-code",
      address: "evil space/slash",
      hostname: "../../etc/passwd",
    });
    const err = Object.assign(new TypeError("fetch failed"), { cause: hostile });
    const t = describeTransportFailure(err);
    expect(t.causeCode).toBeUndefined();
    expect(t.causeDetail).toBeUndefined();
  });

  it("returns empty diagnostics for non-object throws", () => {
    expect(describeTransportFailure("boom")).toEqual({});
    expect(describeTransportFailure(undefined)).toEqual({});
  });
});

describe("pluginResponseError status-0 network classification", () => {
  it("classifies a refused send as plugin_network_error with the proxy endpoint", async () => {
    const rt = runtime();
    const error = await pluginResponseError(rt, 0, undefined, "", describeTransportFailure(fetchFailedRefused()));
    expect(error.code).toBe("plugin_network_error");
    expect(error.message).toBe("Provider plugin network failure (ECONNREFUSED 127.0.0.1:7897).");
    expect(error.nonRetryable).toBe(false);
    expect(error.upstreamStatus).toBe(0);
    expect(error.upstreamErrorName).toBe("TypeError");
    expect(error.isRateLimit).toBe(false);
  });

  it("falls back to the error name when no errno fields survive", async () => {
    const error = await pluginResponseError(runtime(), 0, undefined, "", { errorName: "TimeoutError" });
    expect(error.code).toBe("plugin_network_error");
    expect(error.message).toBe("Provider plugin network failure (TimeoutError).");
  });

  it("stays safe with no transport info at all", async () => {
    const error = await pluginResponseError(runtime(), 0, undefined, "");
    expect(error.code).toBe("plugin_network_error");
    expect(error.message).toBe("Provider plugin network failure.");
  });

  it("an explicitly classified status-0 error still wins over the network branch", async () => {
    const rt = runtime({ classifyError: () => ({ code: "fake_offline", message: "x", httpStatus: 502, retryable: true }) });
    const error = await pluginResponseError(rt, 0, undefined, "");
    expect(error.code).toBe("fake_offline");
    expect(error.message).toBe("Provider plugin request failed (fake_offline).");
  });

  it("an unclassified sub-400 response keeps the invalid-response wording", async () => {
    const error = await pluginResponseError(runtime(), 200, "{}", "");
    expect(error.code).toBe("plugin_upstream_error");
    expect(error.message).toBe("Provider plugin returned an invalid upstream response.");
  });

  it("network failures still report through noteUpstreamError bookkeeping", async () => {
    const rt = runtime();
    await pluginResponseError(rt, 0, undefined, "", describeTransportFailure(fetchFailedRefused()));
    expect(rt.noteUpstreamError).toHaveBeenCalledTimes(1);
    const info = (rt.noteUpstreamError as any).mock.calls[0][0];
    expect(info.code).toBe("plugin_network_error");
    expect(info.message).not.toContain("fetch failed");
  });
});
