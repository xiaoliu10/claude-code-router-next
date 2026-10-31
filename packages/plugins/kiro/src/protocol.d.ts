import type { PluginClassifiedError } from "./core-types";
export declare const KIRO_PROVIDER = "kiro-subscription";
export declare const KIRO_MARKER = "ccr-managed-kiro";
export declare const DEFAULT_REGION = "us-east-1";
export declare const CALLBACK_PORTS: readonly [3128, 4649, 6588, 8008, 9091, 49153, 50153, 51153, 52153, 53153];
export declare const BUILDER_ID_START = "https://view.awsapps.com/start";
export declare const BUILDER_ID_PROFILE = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
/** Kiro's service regions, nearest first, for profile discovery in profile order. */
export declare const KIRO_REGIONS: readonly ["us-east-1", "eu-central-1"];
export declare const KIRO_SCOPES: string[];
export declare const KIRO_SITE: Readonly<{
    id: "kiro";
    label: "Kiro";
    provider: "kiro-subscription";
    marker: "ccr-managed-kiro";
    credentialFile: "kiro-credentials.json";
    routeBase: "/api/kiro";
    web: "https://app.kiro.dev";
    chatUrl: "https://runtime.us-east-1.kiro.dev/generateAssistantResponse";
}>;
export declare const KIRO_CHAT: "https://runtime.us-east-1.kiro.dev/generateAssistantResponse";
export declare const kiroSite: () => Readonly<{
    id: "kiro";
    label: "Kiro";
    provider: "kiro-subscription";
    marker: "ccr-managed-kiro";
    credentialFile: "kiro-credentials.json";
    routeBase: "/api/kiro";
    web: "https://app.kiro.dev";
    chatUrl: "https://runtime.us-east-1.kiro.dev/generateAssistantResponse";
}>;
export declare const runtimeURL: (region: string) => string;
export declare const managementURL: (region: string) => string;
export declare const oidcURL: (region: string) => string;
export declare const authURL: (region: string) => string;
export declare const refreshURL: (region: string) => string;
export declare const validRegion: (v: unknown) => v is string;
/**
 * Kiro serves an account in the region its profile ARN names
 * (`arn:aws:codewhisperer:<region>:<account>:profile/<name>`), never in the
 * region that happened to route the sign-in. Falls back to Kiro's nearest
 * region only when no usable ARN region is present.
 */
export declare function regionOf(profile: unknown, signedIn?: unknown): string;
/**
 * Decides whether a non-2xx token/refresh answer ends the sign-in. Bounded and
 * code-only: the vendor's `error_description` never leaves this function.
 */
export declare function isPermanentOAuthFailure(status: number, body?: unknown): boolean;
export declare function validStartUrl(value: unknown): value is string;
export declare function kiroError(code: string, statusCode?: number): Error & {
    code: string;
    statusCode: number;
};
export declare const KIRO_ERROR_CODES: readonly ["kiro_unauthorized", "kiro_login_invalid", "kiro_login_unknown", "kiro_login_expired", "kiro_login_busy", "kiro_callback_invalid", "kiro_callback_ports_busy", "kiro_login_cancelled", "kiro_login_failed", "kiro_not_connected", "kiro_reauth_required", "kiro_account_cooling", "kiro_persist_failed", "kiro_config_write_failed", "kiro_provider_name_conflict", "kiro_credential_invalid", "kiro_credential_unreadable", "kiro_raw_config_required", "kiro_upstream_error", "kiro_rate_limited", "kiro_request_failed", "kiro_model_unknown"];
type Config = Record<string, any>;
export declare function isKiroManaged(p: Config | undefined): boolean;
export declare function lockKiroProvider(p: Config): Config;
export declare function protectKiroConfig(next: Config, previous: Config): void;
export declare function mergeKiroProvider(current: Config, server: Config): Config;
export declare function classifyKiroError(status: number, _body?: unknown): PluginClassifiedError;
export declare function isKiroErrorEnvelope(body: unknown): boolean;
export {};
