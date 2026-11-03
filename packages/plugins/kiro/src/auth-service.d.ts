import type { PluginHostCapabilities, PluginClassifiedError } from "./core-types";
export type KiroLoginMethod = "portal" | "builderid" | "idc";
export interface KiroCredential {
    id: string;
    uid: string;
    email: string;
    accountId: string;
    access: string;
    refresh: string;
    expires: number;
    /** Kiro service region: where the account's API is, i.e. its profile ARN's region. */
    region: string;
    method: "social" | "idc";
    loginProvider: string;
    profile: string;
    /** Sign-in region (AWS directory or Kiro portal region); only used to reach OIDC/token endpoints. */
    signInRegion?: string;
    clientId?: string;
    clientSecret?: string;
    plan?: string;
    needReauth?: boolean;
    coolingUntil?: number;
}
export interface KiroModelRecord {
    id: string;
    key: string;
    name: string;
    context: number;
    output: number;
    images: boolean;
}
export interface KiroUsageSnapshot {
    known: boolean;
    stale: boolean;
    plan?: string;
    user?: string;
    observedAt?: number;
    windows: Array<{
        name: string;
        used: number;
        amount: number;
        limit: number;
        unit: string;
        display: string;
        resetsAt?: string;
    }>;
}
export interface KiroServiceOptions {
    host: PluginHostCapabilities;
    fetch?: typeof fetch;
    now?: () => number;
}
declare const publicAccount: (c: KiroCredential) => {
    id: string;
    uid: string;
    email: string;
    accountId: string;
    name: string;
    method: "social" | "idc";
    loginProvider: string;
    region: string;
    plan: string | undefined;
    needReauth: boolean;
    coolingUntil: number;
};
export declare class KiroAuthService {
    readonly options: KiroServiceOptions;
    readonly site: Readonly<{
        id: "kiro";
        label: "Kiro";
        provider: "kiro-subscription";
        marker: "ccr-managed-kiro";
        credentialFile: "kiro-credentials.json";
        routeBase: "/api/kiro";
        web: "https://app.kiro.dev";
        chatUrl: "https://runtime.us-east-1.kiro.dev/generateAssistantResponse";
    }>;
    readonly file: string;
    private saved;
    private loaded?;
    private queue;
    private refreshes;
    private logins;
    private usage;
    constructor(options: KiroServiceOptions);
    private now;
    /**
     * The credential-commit lane: sections run one at a time, strictly in submission order.
     * Nothing inside a section ever waits on it again — `load()` reads through its own cached
     * promise and `commit`'s host callbacks never enqueue — so a section cannot deadlock on itself.
     */
    private exclusive;
    private validate;
    private load;
    private persist;
    private config;
    private commit;
    private request;
    /** Reads at most 8 KiB of an OAuth error body, and only its code. */
    private oauthError;
    private management;
    /** A profile without a region-bearing ARN needs a Kiro region; ask Kiro's own regions in order. */
    private discoverProfile;
    private identify;
    private usageOf;
    private listen;
    private end;
    /** Token and refresh endpoints follow the sign-in region, never the profile region. */
    private signInRegion;
    private startAWS;
    startLogin(input: {
        method: KiroLoginMethod;
        startUrl?: string;
        region?: string;
    }): Promise<{
        loginId: string;
        url: string;
    }>;
    private login;
    pollLogin(id: string, callbackUrl?: string): Promise<{
        status: string;
        account?: ReturnType<typeof publicAccount>;
        url?: string;
    }>;
    cancelLogin(id: string): Promise<{
        status: "pending" | "complete" | "cancelled" | "expired" | "failed";
    }>;
    completeLogin(id: string, callbackUrl: string): Promise<{
        status: string;
        account?: ReturnType<typeof publicAccount>;
        url?: string;
    }>;
    private select;
    ensureUsable(account?: string): Promise<void>;
    getCredential(account?: string): Promise<KiroCredential>;
    forceTokenRefresh(account?: string): Promise<KiroCredential>;
    /**
     * Merges freshly rotated tokens into the account as it is stored *now*, not into the snapshot
     * the refresh started from: a concurrent cooldown/reauth update replaces the account object, and
     * discarding the rotated tokens there would spend a refresh token the server may already have
     * retired. Only a real disconnect (account gone) or a new sign-in (credentials changed) refuses.
     * Callers hold the exclusive credential-commit lane.
     */
    private upsert;
    private markError;
    noteUpstreamError(info: PluginClassifiedError, account?: string): Promise<void>;
    getStatus(): Promise<{
        connected: boolean;
        status: string;
        providerName: string;
        accounts: {
            id: string;
            uid: string;
            email: string;
            accountId: string;
            name: string;
            method: "social" | "idc";
            loginProvider: string;
            region: string;
            plan: string | undefined;
            needReauth: boolean;
            coolingUntil: number;
        }[];
        models: KiroModelRecord[];
        hiddenModels: string[];
        plan: string | null;
        usage: {
            known: boolean;
            stale: boolean;
            plan?: string;
            user?: string;
            observedAt?: number;
            windows: Array<{
                name: string;
                used: number;
                amount: number;
                limit: number;
                unit: string;
                display: string;
                resetsAt?: string;
            }>;
            account: string;
        }[];
    }>;
    getUsage(account?: string): Promise<KiroUsageSnapshot>;
    syncModels(account?: string): Promise<{
        success: boolean;
        models: KiroModelRecord[];
    }>;
    setModelHidden(model: string, hidden: boolean): Promise<{
        success: boolean;
    }>;
    disconnect(account?: string): Promise<{
        success: boolean;
    }>;
    close(): void;
}
export {};
