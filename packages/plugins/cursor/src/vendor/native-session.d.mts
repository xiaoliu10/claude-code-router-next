/**
 * Type declarations for the vendored native-session state machine
 * (src/vendor/native-session.mjs — verbatim upstream, see ./PATCHES.md).
 */
export declare const NATIVE_LIMITS: Record<string, number>;
export declare class NativeSessionError extends Error {
  status: number;
  constructor(status: number, message: string);
}
export declare class Quiet {
  constructor(limits: Record<string, number>, stop: (e: { status: number; message: string }) => void);
  frames(stream: AsyncIterable<any> | Iterable<any>): AsyncGenerator<any, void, unknown>;
  pause(): void;
  resume(): void;
}
export declare function nativeFields(input: Uint8Array | ArrayBuffer, maxFields?: number): Array<{ num: number; wire: number; n: number; data: Uint8Array }>;
export declare function nativeMcpArgs(input: Uint8Array, limits?: Record<string, number>): { fields: Array<{ num: number; wire: number; n: number; data: Uint8Array }>; args: Record<string, unknown> };
export declare class NativeSessionPool {
  limits: Record<string, number>;
  entries: Set<any>;
  handles: Map<string, any>;
  selectors: Map<string, any>;
  prepare(tok: string, chat: any, selector: string, tools: any[]): any;
  create(prepared: any, resolution: any, wire: any): any | null;
  release(owner: any): void;
  forget(owner: any): void;
  clear(): Promise<void>;
}
export declare const nativeSessions: NativeSessionPool;
