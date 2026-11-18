import { describe, expect, it, vi } from "vitest";
import { registerServiceRoutes } from "../utils/service-routes";

function fixture(managed: boolean) {
  const routes = new Map<string, Function>();
  const actions = {
    managed, version: "1.0.0",
    checkUpdate: vi.fn(async () => ({ hasUpdate: true })),
    performUpdate: vi.fn(async () => ({ success: true })),
    restart: vi.fn(),
  };
  registerServiceRoutes({
    get: (path, handler) => routes.set(path, handler),
    post: (path, handler) => routes.set(path, handler),
  }, actions);
  const code = vi.fn();
  return { actions, code, call: (path: string) => routes.get(path)!({}, { code }) };
}

describe("desktop-owned lifecycle routes", () => {
  it("blocks global update and detached restart without executing either action", async () => {
    const f = fixture(true);
    for (const path of ["/api/restart", "/api/update/perform"]) {
      expect(await f.call(path)).toMatchObject({ success: false, code: "desktop_managed_service" });
    }
    expect(f.code.mock.calls).toEqual([[409], [409]]);
    expect(f.actions.restart).not.toHaveBeenCalled();
    expect(f.actions.performUpdate).not.toHaveBeenCalled();
    expect(await f.call("/api/update/check")).toMatchObject({ hasUpdate: false, desktopManaged: true });
    expect(f.actions.checkUpdate).not.toHaveBeenCalled();
  });
  it("retains CLI-owned update and restart behavior", async () => {
    const f = fixture(false);
    expect(await f.call("/api/restart")).toMatchObject({ success: true });
    expect(await f.call("/api/update/perform")).toEqual({ success: true });
    expect(await f.call("/api/update/check")).toEqual({ hasUpdate: true });
    expect(f.actions.restart).toHaveBeenCalledOnce();
    expect(f.actions.performUpdate).toHaveBeenCalledOnce();
    expect(f.actions.checkUpdate).toHaveBeenCalledWith("1.0.0");
    expect(f.code).not.toHaveBeenCalled();
  });
});
