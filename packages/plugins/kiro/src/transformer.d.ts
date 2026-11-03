import type { KiroAuthService } from "./auth-service";
type Json = Record<string, any>;
export declare const kiroToolName: (name: string) => string;
/** Normalize CCR unified messages without carrying reusable reasoning signatures. */
export declare function anthropicRequest(request: Json): Json;
export interface KiroRequestState {
    model: string;
    stream: boolean;
    thinking: boolean;
    names: Map<string, string>;
    aliases: Map<string, string>;
    inputEstimate: number;
    contextWindow: number;
}
export declare function requestState(request: Json): KiroRequestState;
/** Kiro has no enabled systemPrompt field; prepend instructions to the first user turn. */
export declare function buildKiro(request: Json, model: string, profile?: string): Json;
/** Lets a downstream cancel() interrupt a pending upstream read immediately. */
export interface KiroCancelBus {
    interrupt(): void;
}
/** Parse fragmented AWS EventStream frames with bounded frame sizes. */
export declare function kiroFrames(body: ReadableStream<Uint8Array>, cancelBus?: KiroCancelBus): AsyncGenerator<{
    kind: string;
    data: Json;
    exception: boolean;
}>;
export declare function kiroFailure(status: number, body?: Json): Error & {
    statusCode: number;
    code: string;
};
type Event = Json & {
    type: string;
};
/** Emit Anthropic Messages events; the provider adapter below converts these to unified Chat. */
export declare function kiroEvents(response: Response, state: KiroRequestState, cancelBus?: KiroCancelBus): AsyncGenerator<Event>;
/** Standalone Messages response and the CCR unified Chat adapter share one parser. */
export declare function kiroResponse(response: Response, state: KiroRequestState, unified?: boolean): Promise<Response>;
export declare class KiroTransformer {
    private readonly service?;
    static TransformerName: string;
    name: string;
    constructor(service?: KiroAuthService | undefined);
    transformRequestIn(request: Json, _provider?: unknown, context?: Json): Promise<{
        body: Json;
    }>;
    transformResponseOut(response: Response, context?: Json): Promise<Response>;
}
export {};
