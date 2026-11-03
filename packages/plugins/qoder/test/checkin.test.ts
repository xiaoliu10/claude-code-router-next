import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { checkinQoder, type CheckinOptions } from "../src/checkin";
import { registerQoderAdminRoutes } from "../src/admin-routes";
import { QoderAuthService } from "../src/auth-service";

const campaign = { actionType: "CLAIM_BENEFIT", campaignId: "day/1", claimStatus: "CLAIMABLE", benefit: { amount: 20 } };
const credential = { access: "job-secret" };
const setup = (replies: unknown[], extra: Partial<CheckinOptions> = {}) => {
  const network = vi.fn(async () => {
    const value = replies.shift();
    if (value instanceof Error) throw value;
    return value instanceof Response ? value : Response.json(value);
  });
  const direct = vi.fn(() => ({ name: "direct" }));
  const subscription = vi.fn(() => ({ name: "subscription" }));
  const options = { site: "qoder-cn", fetch: network, host: { getDirectDispatcher: direct, getSubscriptionDispatcher: subscription }, ...extra } as CheckinOptions;
  return { options, network, direct, subscription };
};

describe("manual Qoder check-in", () => {
  it("claims CN PAT credits with job token, fixed origin and subscription transport independent of ports", async () => {
    const { options, network, direct } = setup([{ campaigns: [campaign] }, { data: { status: "CLAIMED", benefit: { amount: 35 } } }]);
    expect(await checkinQoder(credential, options)).toEqual({ outcome: "claimed", credit: 35 });
    expect(network).toHaveBeenCalledTimes(2);
    expect(network.mock.calls[0][0]).toBe("https://openapi.qoder.com.cn/sash/api/v1/me/campaigns");
    expect(network.mock.calls[1][0]).toBe("https://openapi.qoder.com.cn/sash/api/v1/me/campaigns/day%2F1/claim");
    const init = network.mock.calls[1][1] as RequestInit & { dispatcher: unknown };
    expect(init).toMatchObject({ method: "POST", body: "{}", redirect: "error", dispatcher: { name: "subscription" } });
    expect(init.headers).toMatchObject({ Authorization: "Bearer job-secret", "Accept-Encoding": "identity", "Cosy-ClientType": "10", "User-Agent": "Qoder" });
    expect(init.headers).not.toHaveProperty("Cosy-MachineToken");
    expect(direct).not.toHaveBeenCalled();
  });
  it("falls back to direct dispatcher and carries genuine international identity", async () => {
    const machine = { "Cosy-MachineToken": "native", "Cosy-MachineType": "native-type" };
    const { options, network, direct } = setup([{ campaigns: [] }], { site: "qoder", machine, host: { getDirectDispatcher: vi.fn(() => "direct") } as unknown as CheckinOptions["host"] });
    expect(await checkinQoder(credential, options)).toEqual({ outcome: "inactive" });
    expect(network.mock.calls[0][0]).toContain("https://openapi.qoder.sh/");
    expect(network.mock.calls[0][1]).toMatchObject({ headers: machine, dispatcher: "direct" });
  });
  it("returns done only for an active claimed campaign, without claiming again", async () => {
    const { options, network } = setup([{ campaigns: [{ ...campaign, claimStatus: "CLAIMED" }] }]);
    expect(await checkinQoder(credential, options)).toEqual({ outcome: "done", credit: 20 });
    expect(network).toHaveBeenCalledTimes(1);
  });
  it.each([[], [{ ...campaign, claimStatus: "LOCKED", startAt: "2099-01-01" }], [{ ...campaign, claimStatus: "CLAIMED", endAt: "2000-01-01T00:00:00Z" }], [{ ...campaign, actionType: "OTHER" }]])("returns inactive for unavailable campaigns without retry", async (...entries) => {
    const { options, network } = setup([{ campaigns: entries }]);
    expect(await checkinQoder(credential, options)).toEqual({ outcome: "inactive" });
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("returns ineligible for international accounts without desktop identity without network", async () => {
    const { options, network } = setup([], { site: "qoder" });
    expect(await checkinQoder(credential, options)).toMatchObject({ outcome: "ineligible" });
    expect(network).not.toHaveBeenCalled();
  });
  it.each([401, 403])("rotates a device token on %s once and sends it on the retry and claim", async status => {
    const refresh = vi.fn(async () => "rotated-secret");
    const { options, network } = setup([new Response(null, { status }), { campaigns: [campaign] }, { status: "CLAIMED" }], { refreshDeviceToken: refresh });
    expect(await checkinQoder({ ...credential, deviceToken: "device-secret" }, options)).toEqual({ outcome: "claimed", credit: 20 });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(network.mock.calls.map(c => (c[1] as RequestInit).headers)).toEqual([
      expect.objectContaining({ Authorization: "Bearer device-secret" }),
      expect.objectContaining({ Authorization: "Bearer rotated-secret" }),
      expect.objectContaining({ Authorization: "Bearer rotated-secret" }),
    ]);
  });
  it("refreshes once when the claim itself is unauthorized", async () => {
    const refresh = vi.fn(async () => "rotated");
    const { options, network } = setup([{ campaigns: [campaign] }, new Response(null, { status: 401 }), { status: "CLAIMED" }], { refreshDeviceToken: refresh });
    expect(await checkinQoder({ ...credential, deviceToken: "device" }, options)).toEqual({ outcome: "claimed", credit: 20 });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[2][1]).toMatchObject({ headers: { Authorization: "Bearer rotated" } });
  });
  it("stops after one device refresh even if claim is refused", async () => {
    const refresh = vi.fn(async () => "rotated");
    const { options, network } = setup([new Response(null, { status: 401 }), { campaigns: [campaign] }, new Response(null, { status: 403 })], { refreshDeviceToken: refresh });
    expect(await checkinQoder({ ...credential, deviceToken: "device" }, options)).toEqual({ outcome: "failed", message: "Claim: HTTP 403" });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(network).toHaveBeenCalledTimes(3);
  });
  it("does not refresh a PAT when the campaigns page refuses it", async () => {
    const refresh = vi.fn();
    const { options, network } = setup([new Response(null, { status: 401 })], { refreshDeviceToken: refresh });
    expect(await checkinQoder(credential, options)).toMatchObject({ outcome: "failed" });
    expect(refresh).not.toHaveBeenCalled(); expect(network).toHaveBeenCalledTimes(1);
  });
  it.each([
    [new Error("job-secret")],
    [new Response("job-secret", { status: 502 })],
    [new Response("job-secret")],
    [{}],
    [{ campaigns: [campaign] }, { status: "job-secret" }],
    [{ campaigns: [campaign] }, new Response("job-secret")],
  ])("sanitizes all upstream failures", async (...replies) => {
    const { options } = setup(replies);
    const result = await checkinQoder(credential, options);
    expect(result.outcome).toBe("failed"); expect(JSON.stringify(result)).not.toContain("job-secret");
  });
  it("service obtains credential using its existing freshness path and calls CN check-in", async () => {
    const { options, network } = setup([{ campaigns: [campaign] }, { status: "CLAIMED" }]);
    const service = new QoderAuthService({ site: "qoder-cn", host: { ...options.host, configDir: "/unused" } as never, fetch: network });
    const fresh = vi.spyOn(service as unknown as { freshCredential: () => Promise<typeof credential> }, "freshCredential").mockResolvedValue(credential);
    expect(await service.checkin()).toEqual({ outcome: "claimed", credit: 20 });
    expect(fresh).toHaveBeenCalledTimes(1);
    fresh.mockRejectedValue(new Error("job-secret"));
    expect(JSON.stringify(await service.checkin())).not.toContain("job-secret");
  });
  it("serializes concurrent CN check-ins through the exclusive lane so only one claim POST is sent", async () => {
    // Upstream state advances when the claim POST lands: the second request
    // must observe CLAIMED (done) instead of racing into a second claim.
    let claimed = false;
    const network = vi.fn(async (_url: string, init?: RequestInit) => {
      if ((init as RequestInit | undefined)?.method === "POST") {
        claimed = true;
        return Response.json({ status: "CLAIMED", benefit: { amount: 20 } });
      }
      return Response.json({ campaigns: claimed ? [{ ...campaign, claimStatus: "CLAIMED" }] : [campaign] });
    });
    const service = new QoderAuthService({ site: "qoder-cn", host: { getSubscriptionDispatcher: () => ({ name: "subscription" }), getDirectDispatcher: () => ({ name: "direct" }), configDir: "/unused" } as never, fetch: network });
    vi.spyOn(service as unknown as { freshCredential: () => Promise<typeof credential> }, "freshCredential").mockResolvedValue(credential);
    // Both concurrent calls settle normally; the loser reports the post-claim state.
    expect(await Promise.all([service.checkin(), service.checkin()])).toEqual([
      { outcome: "claimed", credit: 20 }, { outcome: "done", credit: 20 }]);
    expect(network).toHaveBeenCalledTimes(3);
    expect(network.mock.calls.filter(c => (c[1] as RequestInit).method === "POST")).toHaveLength(1);
  });
  it("answers international ineligible immediately even while the exclusive lane is busy", async () => {
    const service = new QoderAuthService({ site: "qoder", host: { getSubscriptionDispatcher: () => ({ name: "subscription" }), getDirectDispatcher: () => ({ name: "direct" }), configDir: "/unused" } as never, fetch: vi.fn() });
    // Occupy the lane forever; the intl gate must not queue behind it.
    (service as unknown as { exclusive: (fn: () => Promise<never>) => Promise<never> }).exclusive(() => new Promise<never>(() => {}));
    const outcome = await Promise.race([service.checkin(), new Promise(resolve => setTimeout(() => resolve("timed-out"), 200))]);
    expect(outcome).toEqual({ outcome: "ineligible", message: "International check-in requires Qoder desktop device identity" });
  });
  it("sources site origins from protocol.ts instead of re-declaring literals", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/checkin.ts", import.meta.url), "utf8");
    expect(source).not.toContain("https://openapi.qoder.com.cn");
    expect(source).not.toContain("https://openapi.qoder.sh");
    expect(source).toContain("qoderSite(options.site).openapi");
  });
  describe("window fields accept only epochs and RFC3339 strings", () => {
    const claimedWith = async (endAt: unknown) => {
      const { options, network } = setup([{ campaigns: [{ ...campaign, claimStatus: "CLAIMED", endAt }] }]);
      return { result: await checkinQoder(credential, options), network };
    };
    it.each([
      ["epoch seconds expired", 1000, "inactive"],
      ["epoch seconds active", 4102444800, "done"],
      ["epoch milliseconds expired", 1_000_000, "inactive"],
      ["epoch milliseconds active", 4102444800000, "done"],
      ["RFC3339 string expired", "2000-01-01T00:00:00Z", "inactive"],
      ["RFC3339 string active", "2099-01-01T00:00:00Z", "done"],
      ["date-only string is open-ended", "2000-01-01", "done"],
      ["numeric string zero is open-ended", "0", "done"],
      ["numeric string is epoch seconds (123s expired)", "123", "inactive"],
      ["garbage string is open-ended", "not-a-date", "done"],
      ["null is open-ended", null, "done"],
    ])("%s → %s", async (_label, endAt, expected) => {
      const { result, network } = await claimedWith(endAt);
      expect(result).toEqual(expected === "done" ? { outcome: "done", credit: 20 } : { outcome: "inactive" });
      expect(network).toHaveBeenCalledTimes(1);
    });
  });
  it("registers both site prefixes under the loopback guard at any listening port", async () => {
    const app = Fastify();
    const intl = { checkin: vi.fn(async () => ({ outcome: "ineligible" })) };
    const cn = { checkin: vi.fn(async () => ({ outcome: "claimed", credit: 10 })) };
    registerQoderAdminRoutes(app, intl as never);
    registerQoderAdminRoutes(app, cn as never, "qoder-cn");
    try {
      await app.listen({ port: 0, host: "127.0.0.1" });
      const port = (app.server.address() as { port: number }).port;
      for (const [path, outcome] of [["/api/qoder/checkin", "ineligible"], ["/api/qoder/cn/checkin", "claimed"]]) {
        const res = await app.inject({ method: "POST", url: path, headers: { host: `localhost:${port}` } });
        expect(res.statusCode).toBe(200); expect(res.json().outcome).toBe(outcome);
      }
      const denied = await app.inject({ method: "POST", url: "/api/qoder/cn/checkin", remoteAddress: "203.0.113.1", headers: { host: `localhost:${port}` } });
      expect(denied.statusCode).toBe(403); expect(cn.checkin).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
});
