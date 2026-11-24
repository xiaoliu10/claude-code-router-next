import { expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { tokenSpeedPlugin } from "../plugins/token-speed";

it("does not start token-speed capture for timed Chat Completions streams", async () => {
  const hooks = new Map<string, Function>();
  await tokenSpeedPlugin.register({
    addHook(name: string, hook: Function) { hooks.set(name, hook); },
  } as unknown as FastifyInstance, { reporter: [] });
  const request = { id: "timed-chat", url: "/v1/chat/completions?stream=true", requestStartTime: 1 };
  const payload = new Response("data: [DONE]\n\n").body!;
  const interval = vi.spyOn(globalThis, "setInterval");
  try {
    await hooks.get("onSend")!(request, {}, payload);
    expect(interval).not.toHaveBeenCalled();
    expect(request).not.toHaveProperty("tokenSpeedCapturePromise");
    expect(payload.locked).toBe(false);
  } finally {
    for (const result of interval.mock.results) {
      if (result.type === "return") clearInterval(result.value);
    }
    interval.mockRestore();
  }
});
