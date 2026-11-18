// Desktop-owned processes must stay under their parent's lifecycle control.
interface ServiceResponse {
  success?: boolean;
  hasUpdate?: boolean;
  message?: string;
  code?: string;
  desktopManaged?: boolean;
  currentVersion?: string;
}
type Handler = (request: unknown, reply: { code(status: number): void }) => Promise<ServiceResponse>;
interface AdminApp {
  get(path: string, handler: Handler): void;
  post(path: string, handler: Handler): void;
}
interface ServiceActions {
  managed: boolean;
  version: string;
  checkUpdate(version: string): Promise<ServiceResponse>;
  performUpdate(): Promise<ServiceResponse>;
  restart(): void;
}

export function registerServiceRoutes(app: AdminApp, actions: ServiceActions): void {
  const rejectManaged = (reply: Parameters<Handler>[1]) => {
    reply.code(409);
    return {
      success: false,
      code: "desktop_managed_service",
      message: "This gateway is managed by CCR Desktop. Use the desktop service controls to restart; update the desktop app to upgrade.",
    };
  };
  app.get("/api/update/check", async () => actions.managed
    ? { hasUpdate: false, desktopManaged: true, currentVersion: actions.version }
    : actions.checkUpdate(actions.version));
  app.post("/api/update/perform", async (_request, reply) => actions.managed
    ? rejectManaged(reply)
    : actions.performUpdate());
  app.post("/api/restart", async (_request, reply) => {
    if (actions.managed) return rejectManaged(reply);
    actions.restart();
    return { success: true, message: "Service restart initiated" };
  });
}
