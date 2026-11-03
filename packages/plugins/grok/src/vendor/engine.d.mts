export interface Credential { key: string; email: string; user: string; who: string; expires: number; issuer: string }
export interface GrokModel { id: string; apiId: string; name: string; context: number; window: number; efforts: string[] }
export interface GrokEngine {
  cancelPending(): void;
  setProxyUrl(value: string): void;
  cliHome(): string;
  executable(): string;
  envFor(home: string): NodeJS.ProcessEnv;
  credential(home: string): Promise<Credential | null>;
  token(home: string, rejected?: boolean | string): Promise<Credential>;
  sign(headers: Headers, key: string): Promise<void>;
  rewrite(body: string, xSearch?: boolean): string;
  objectRoot(schema: any): any;
  windowsOf(model: any, efforts: string[]): GrokModel[];
  modelOf(id: string): { model: string; window: number };
}
export function createGrokEngine(options?: { env?: NodeJS.ProcessEnv; userHome?: string; proxyUrl?: string }): GrokEngine;
