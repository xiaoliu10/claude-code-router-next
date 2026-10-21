import type { ChatCompletionMessageParam as OpenAIMessage } from "openai/resources/chat/completions";
import type { MessageParam as AnthropicMessage } from "@anthropic-ai/sdk/resources/messages";
import type {
  ChatCompletion,
  ChatCompletionChunk,
} from "openai/resources/chat/completions";
import type {
  Message,
  MessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages";
import { Transformer } from "./transformer";
import type { ProviderTokenizerConfig } from "./tokenizer";

export interface UrlCitation {
  url: string;
  title: string;
  content: string;
  start_index: number;
  end_index: number;
}
export interface Annotation {
  type: "url_citation";
  url_citation?: UrlCitation;
}

// 内容类型定义
export interface TextContent {
  type: "text";
  text: string;
  cache_control?: {
    type?: string;
  };
}

export interface ImageContent {
  type: "image_url";
  image_url: {
    url: string;
  };
  media_type: string;
}

export type MessageContent = TextContent | ImageContent;

// 统一的消息接口
export interface UnifiedMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | null | MessageContent[];
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
  cache_control?: {
    type?: string;
  };
  thinking?: {
    content: string;
    signature?: string;
  };
}

// 统一的工具定义接口
export interface UnifiedTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, any>;
      required?: string[];
      additionalProperties?: boolean;
      $schema?: string;
    };
  };
}

// Mirrors the upstream effort vocabulary shared by the Anthropic Messages API
// (`output_config.effort`), the OpenAI Responses API and most Anthropic-
// compatible providers (e.g. GLM): low | medium | high | max.
export type ThinkLevel = "none" | "low" | "medium" | "high" | "max";

// 统一的请求接口
export interface UnifiedChatRequest {
  messages: UnifiedMessage[];
  model: string;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: UnifiedTool[];
  tool_choice?:
    | "auto"
    | "none"
    | "required"
    | string
    | { type: "function"; function: { name: string } };
  reasoning?: {
    // OpenAI-style
    effort?: ThinkLevel;

    // Anthropic-style
    max_tokens?: number;

    enabled?: boolean;
  };
}

// 统一的响应接口
export interface UnifiedChatResponse {
  id: string;
  model: string;
  content: string | null;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  annotations?: Annotation[];
}

// 流式响应相关类型
export interface StreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices?: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      thinking?: {
        content?: string;
        signature?: string;
      };
      tool_calls?: Array<{
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
      annotations?: Annotation[];
    };
    finish_reason?: string | null;
  }>;
}

// Anthropic 流式事件类型
export type AnthropicStreamEvent = MessageStreamEvent;

// OpenAI 流式块类型
export type OpenAIStreamChunk = ChatCompletionChunk;

// OpenAI 特定类型
export interface OpenAIChatRequest {
  messages: OpenAIMessage[];
  model: string;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: ChatCompletionTool[];
  tool_choice?:
    | "auto"
    | "none"
    | { type: "function"; function: { name: string } };
}

// Anthropic 特定类型
export interface AnthropicChatRequest {
  messages: AnthropicMessage[];
  model: string;
  max_tokens: number;
  temperature?: number;
  stream?: boolean;
  system?: string | Array<Record<string, any>>;
  tools?: AnthropicTool[];
  tool_choice?: { type: "auto" } | { type: "tool"; name: string };
}

// 转换选项
export interface ConversionOptions {
  targetProvider: "openai" | "anthropic";
  sourceProvider: "openai" | "anthropic";
}

export interface LLMProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  /** Optional token for quota/billing APIs that require separate authentication (e.g. Zhipu web console JWT) */
  quotaToken?: string;
  /**
   * Optional sec_token for the Aliyun Bailian console official quota API
   * (efm-fe 3.5.613 format). When present, the AliyunTokenPlanQuotaAdapter
   * prefers the official bailian-cs.console.aliyun.com gateway and falls
   * back to the legacy cs-data.qianwenai.com endpoint on failure.
   */
  quotaSecToken?: string;
  transformer?: {
    [key: string]: {
      use?: Transformer[];
    };
  } & {
    use?: Transformer[];
  };
  /**
   * How the provider reports input_tokens in usage responses.
   * - 'exclusive' (default): input_tokens is net of cache, total = input + cache_read + cache_creation + output
   * - 'inclusive': input_tokens already includes cache tokens, total = input + output
   */
  cacheMode?: 'exclusive' | 'inclusive';
  enabled?: boolean;
  proxyEnabled?: boolean;
  wakeupEnabled?: boolean;
  wakeupTime?: string;
  wakeupModel?: string;
  /** Set for CCR-managed built-in providers (e.g. WorkBuddy) so the data plane
   *  can lock their fixed upstream URL and inject their own auth headers. */
  workbuddyManaged?: boolean;
  /** Set for the CCR-managed Gemini OAuth (Antigravity) provider so the data
   *  plane can lock its fixed upstream URL and inject OAuth-derived headers. */
  geminiOauthManaged?: boolean;
  /** Managed Gemini OAuth account kind. v1: antigravity only. */
  geminiOauthKind?: "antigravity";
}

export type RegisterProviderRequest = LLMProvider;

export interface ModelRoute {
  provider: string;
  model: string;
  fullModel: string;
}

export interface RequestRouteInfo {
  provider: LLMProvider;
  originalModel: string;
  targetModel: string;
}

export interface ConfigProvider {
  name: string;
  api_base_url: string;
  api_key: string;
  models: string[];
  /** Optional token for quota/billing APIs that require separate authentication */
  quota_token?: string;
  /** Optional sec_token for the Aliyun Bailian console official quota API (efm-fe 3.5.613 format) */
  quota_sec_token?: string;
  transformer: {
    use?: string[] | Array<any>[];
  } & {
    [key: string]: {
      use?: string[] | Array<any>[];
    };
  };
  tokenizer?: ProviderTokenizerConfig;
  /**
   * How the provider reports input_tokens in usage responses.
   * - 'exclusive' (default): input_tokens is net of cache, total = input + cache_read + cache_creation + output
   * - 'inclusive': input_tokens already includes cache tokens, total = input + output
   */
  cache_mode?: 'exclusive' | 'inclusive';
  enabled?: boolean;
  proxy_enabled?: boolean;
  wakeup_enabled?: boolean;
  wakeup_time?: string;
  wakeup_model?: string;
  /** CCR-managed Gemini OAuth (Antigravity) provider flags (snake_case on disk). */
  gemini_oauth_managed?: boolean;
  gemini_oauth_kind?: "antigravity";
}
