import type { ChatCompletionMessageParam as OpenAIMessage } from "openai/resources/chat/completions";
import type { MessageParam as AnthropicMessage } from "@anthropic-ai/sdk/resources/messages";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages";
import {
  UnifiedMessage,
  UnifiedChatRequest,
  UnifiedTool,
  OpenAIChatRequest,
  AnthropicChatRequest,
  ConversionOptions,
} from "../types/llm";
import { getThinkBudget } from "./thinking";

// Simple logger function
function log(...args: any[]) {
  // Can be extended to use a proper logger
  console.log(...args);
}

export function convertToolsToOpenAI(
  tools: UnifiedTool[]
): ChatCompletionTool[] {
  return tools
    .filter((tool): tool is UnifiedTool => !!tool?.function?.name)
    .map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      },
    }));
}

export function convertToolsToAnthropic(tools: UnifiedTool[]): AnthropicTool[] {
  return tools
    .filter((tool): tool is UnifiedTool => !!tool?.function?.name)
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
}

export function convertToolsFromOpenAI(
  tools: ChatCompletionTool[]
): UnifiedTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.function.name,
      description: tool.function.description || "",
      parameters: tool.function.parameters as any,
    },
  }));
}

export function convertToolsFromAnthropic(
  tools: AnthropicTool[]
): UnifiedTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema as any,
    },
  }));
}

function stripCacheControl(msg: any): any {
  if (!msg) return msg;
  const result = { ...msg };
  delete result.cache_control;
  if (Array.isArray(result.content)) {
    result.content = result.content.map((block: any) => {
      if (block && typeof block === "object") {
        const cleaned = { ...block };
        delete cleaned.cache_control;
        return cleaned;
      }
      return block;
    });
  }
  return result;
}

export function convertToOpenAI(
  request: UnifiedChatRequest
): OpenAIChatRequest {
  const messages: OpenAIMessage[] = [];
  const toolResponsesQueue: Map<string, any> = new Map(); // For storing tool responses

  request.messages.forEach((msg) => {
    if (msg.role === "tool" && msg.tool_call_id) {
      if (!toolResponsesQueue.has(msg.tool_call_id)) {
        toolResponsesQueue.set(msg.tool_call_id, []);
      }
      toolResponsesQueue.get(msg.tool_call_id).push(
        stripCacheControl({
          role: "tool",
          content: msg.content,
          tool_call_id: msg.tool_call_id,
        })
      );
    }
  });

  const otherMessages: any[] = [];
  const systemContents: string[] = [];

  request.messages.forEach((msg) => {
    if (msg.role === "system") {
      if (typeof msg.content === "string") {
        systemContents.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        msg.content.forEach((block: any) => {
          if (block && typeof block === "object" && block.type === "text" && block.text) {
            systemContents.push(block.text);
          } else if (typeof block === "string") {
            systemContents.push(block);
          }
        });
      }
    } else {
      otherMessages.push(stripCacheControl(msg));
    }
  });

  for (let i = 0; i < otherMessages.length; i++) {
    const msg = otherMessages[i];

    if (msg.role === "tool") {
      continue;
    }

    const message: any = {
      role: msg.role,
      content: msg.content,
    };

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      message.tool_calls = msg.tool_calls;
      if (message.content === null) {
        message.content = null;
      }
    }

    messages.push(message);

    if (
      msg.role === "assistant" &&
      msg.tool_calls &&
      msg.tool_calls.length > 0
    ) {
      for (const toolCall of msg.tool_calls) {
        if (toolResponsesQueue.has(toolCall.id)) {
          const responses = toolResponsesQueue.get(toolCall.id);

          responses.forEach((response) => {
            messages.push(response);
          });

          toolResponsesQueue.delete(toolCall.id);
        } else {
          messages.push({
            role: "tool",
            content: JSON.stringify({
              success: true,
              message: "Tool call executed successfully",
              tool_call_id: toolCall.id,
            }),
            tool_call_id: toolCall.id,
          } as any);
        }
      }
    }
  }

  if (toolResponsesQueue.size > 0) {
    for (const [id, responses] of toolResponsesQueue.entries()) {
      responses.forEach((response) => {
        messages.push(response);
      });
    }
  }

  // Append system as the LAST message so it does not shift the conversation prefix.
  // This prevents system-reminder changes from breaking upstream prompt caching
  // which depends on prefix stability.
  if (systemContents.length > 0) {
    const uniqueSystemContents = Array.from(new Set(systemContents));
    messages.push({
      role: "system",
      content: uniqueSystemContents.join("\n\n"),
    } as any);
  }

  const result: any = {
    messages,
    model: request.model,
    max_tokens: request.max_tokens,
    temperature: request.temperature,
    stream: request.stream,
  };

  if (request.tools && request.tools.length > 0) {
    result.tools = convertToolsToOpenAI(request.tools);
    if (request.tool_choice) {
      if (request.tool_choice === "auto" || request.tool_choice === "none") {
        result.tool_choice = request.tool_choice;
      } else {
        result.tool_choice = {
          type: "function",
          function: { name: request.tool_choice },
        };
      }
    }
  }

  return result;
}



function isToolCallContent(content: string): boolean {
  try {
    const parsed = JSON.parse(content);
    return (
      Array.isArray(parsed) &&
      parsed.some((item) => item.type === "tool_use" && item.id && item.name)
    );
  } catch {
    return false;
  }
}

export function convertFromOpenAI(
  request: OpenAIChatRequest
): UnifiedChatRequest {
  const messages: UnifiedMessage[] = request.messages.map((msg) => {
    if (
      msg.role === "assistant" &&
      typeof msg.content === "string" &&
      isToolCallContent(msg.content)
    ) {
      try {
        const toolCalls = JSON.parse(msg.content);
        const convertedToolCalls = toolCalls.map((call: any) => ({
          id: call.id,
          type: "function" as const,
          function: {
            name: call.name,
            arguments: JSON.stringify(call.input || {}),
          },
        }));

        return {
          role: msg.role as "user" | "assistant" | "system",
          content: null,
          tool_calls: convertedToolCalls,
        };
      } catch (error) {
        return {
          role: msg.role as "user" | "assistant" | "system",
          content: msg.content,
        };
      }
    }

    if (msg.role === "tool") {
      return {
        role: msg.role as "tool",
        content:
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content),
        tool_call_id: (msg as any).tool_call_id,
      };
    }

    return {
      role: msg.role as "user" | "assistant" | "system",
      content:
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content),
      ...((msg as any).tool_calls && { tool_calls: (msg as any).tool_calls }),
    };
  });

  const result: UnifiedChatRequest = {
    messages,
    model: request.model,
    max_tokens: request.max_tokens,
    temperature: request.temperature,
    stream: request.stream,
  };

  if (request.tools && request.tools.length > 0) {
    result.tools = convertToolsFromOpenAI(request.tools);

    if (request.tool_choice) {
      if (typeof request.tool_choice === "string") {
        result.tool_choice = request.tool_choice;
      } else if (request.tool_choice.type === "function") {
        result.tool_choice = request.tool_choice.function.name;
      }
    }
  }

  return result;
}

export function convertFromAnthropic(
  request: AnthropicChatRequest
): UnifiedChatRequest {
  const messages: UnifiedMessage[] = [];

  if (request.system) {
    messages.push({
      role: "system",
      content: request.system,
    });
  }
  const pendingToolCalls: any[] = [];
  const pendingTextContent: string[] = [];
  let lastRole: string | null = null;

  for (let i = 0; i < request.messages.length; i++) {
    const msg = request.messages[i];

    if (typeof msg.content === "string") {
      if (
        lastRole === "assistant" &&
        pendingToolCalls.length > 0 &&
        msg.role !== "assistant"
      ) {
        const assistantMessage: UnifiedMessage = {
          role: "assistant",
          content: pendingTextContent.join("") || null,
          tool_calls:
            pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
        };
        if (assistantMessage.tool_calls && pendingTextContent.length === 0) {
          assistantMessage.content = null;
        }
        messages.push(assistantMessage);
        pendingToolCalls.length = 0;
        pendingTextContent.length = 0;
      }

      messages.push({
        role: msg.role,
        content: msg.content,
      });
    } else if (Array.isArray(msg.content)) {
      const textBlocks: string[] = [];
      const toolCalls: any[] = [];
      const toolResults: any[] = [];

      msg.content.forEach((block) => {
        if (block.type === "text") {
          textBlocks.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function" as const,
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            },
          });
        } else if (block.type === "tool_result") {
          toolResults.push(block);
        }
      });

      if (toolResults.length > 0) {
        if (lastRole === "assistant" && pendingToolCalls.length > 0) {
          const assistantMessage: UnifiedMessage = {
            role: "assistant",
            content: pendingTextContent.join("") || null,
            tool_calls: pendingToolCalls,
          };
          if (pendingTextContent.length === 0) {
            assistantMessage.content = null;
          }
          messages.push(assistantMessage);
          pendingToolCalls.length = 0;
          pendingTextContent.length = 0;
        }

        toolResults.forEach((toolResult) => {
          messages.push({
            role: "tool",
            content:
              typeof toolResult.content === "string"
                ? toolResult.content
                : JSON.stringify(toolResult.content),
            tool_call_id: toolResult.tool_use_id,
          });
        });
      } else if (msg.role === "assistant") {
        if (lastRole === "assistant") {
          pendingToolCalls.push(...toolCalls);
          pendingTextContent.push(...textBlocks);
        } else {
          if (pendingToolCalls.length > 0) {
            const prevAssistantMessage: UnifiedMessage = {
              role: "assistant",
              content: pendingTextContent.join("") || null,
              tool_calls: pendingToolCalls,
            };
            if (pendingTextContent.length === 0) {
              prevAssistantMessage.content = null;
            }
            messages.push(prevAssistantMessage);
          }

          pendingToolCalls.length = 0;
          pendingTextContent.length = 0;
          pendingToolCalls.push(...toolCalls);
          pendingTextContent.push(...textBlocks);
        }
      } else {
        if (lastRole === "assistant" && pendingToolCalls.length > 0) {
          const assistantMessage: UnifiedMessage = {
            role: "assistant",
            content: pendingTextContent.join("") || null,
            tool_calls: pendingToolCalls,
          };
          if (pendingTextContent.length === 0) {
            assistantMessage.content = null;
          }
          messages.push(assistantMessage);
          pendingToolCalls.length = 0;
          pendingTextContent.length = 0;
        }

        const message: UnifiedMessage = {
          role: msg.role,
          content: textBlocks.join("") || null,
        };

        if (toolCalls.length > 0) {
          message.tool_calls = toolCalls;
          if (textBlocks.length === 0) {
            message.content = null;
          }
        }

        messages.push(message);
      }
    } else {
      if (lastRole === "assistant" && pendingToolCalls.length > 0) {
        const assistantMessage: UnifiedMessage = {
          role: "assistant",
          content: pendingTextContent.join("") || null,
          tool_calls: pendingToolCalls,
        };
        if (pendingTextContent.length === 0) {
          assistantMessage.content = null;
        }
        messages.push(assistantMessage);
        pendingToolCalls.length = 0;
        pendingTextContent.length = 0;
      }

      messages.push({
        role: msg.role,
        content: JSON.stringify(msg.content),
      });
    }

    lastRole = msg.role;
  }

  if (lastRole === "assistant" && pendingToolCalls.length > 0) {
    const assistantMessage: UnifiedMessage = {
      role: "assistant",
      content: pendingTextContent.join("") || null,
      tool_calls: pendingToolCalls,
    };
    if (pendingTextContent.length === 0) {
      assistantMessage.content = null;
    }
    messages.push(assistantMessage);
  }

  const result: UnifiedChatRequest = {
    messages,
    model: request.model,
    max_tokens: request.max_tokens,
    temperature: request.temperature,
    stream: request.stream,
  };

  if (request.tools && request.tools.length > 0) {
    result.tools = convertToolsFromAnthropic(request.tools);

    if (request.tool_choice) {
      if (request.tool_choice.type === "auto") {
        result.tool_choice = "auto";
      } else if (request.tool_choice.type === "tool") {
        result.tool_choice = request.tool_choice.name;
      }
    }
  }

  return result;
}

export function convertToAnthropic(
  request: UnifiedChatRequest
): AnthropicChatRequest {
  const otherMessages: UnifiedMessage[] = [];
  const systemBlocks: any[] = [];

  const addSystemContent = (content: any) => {
    if (typeof content === "string") {
      systemBlocks.push({ type: "text", text: content });
      return;
    }

    if (!Array.isArray(content)) return;

    content.forEach((block: any) => {
      if (typeof block === "string") {
        systemBlocks.push({ type: "text", text: block });
        return;
      }

      if (block && typeof block === "object" && block.type === "text" && block.text) {
        systemBlocks.push({ ...block });
      }
    });
  };

  const dedupeSystemBlocks = () => {
    const seen = new Map<string, number>();
    for (let i = 0; i < systemBlocks.length; i++) {
      const block = systemBlocks[i];
      const key = block?.text ?? JSON.stringify(block);
      const existingIndex = seen.get(key);
      if (existingIndex === undefined) {
        seen.set(key, i);
        continue;
      }

      const existingBlock = systemBlocks[existingIndex];
      if (!existingBlock?.cache_control && block?.cache_control) {
        systemBlocks[existingIndex] = block;
      }
      systemBlocks.splice(i, 1);
      i--;
    }
  };

  request.messages.forEach((msg) => {
    if (msg.role === "system") {
      addSystemContent(msg.content);
    } else {
      otherMessages.push(msg);
    }
  });
  dedupeSystemBlocks();

  const messages: AnthropicMessage[] = [];

  for (let i = 0; i < otherMessages.length; i++) {
    const msg = otherMessages[i];

    if (msg.role === "tool") {
      let content: any = msg.content;
      try {
        if (typeof msg.content === "string") {
          content = JSON.parse(msg.content);
        }
      } catch {}

      // Anthropic API requires tool_result content to be a string (or array/object).
      // Coerce non-string primitives (e.g., numbers, booleans) to strings.
      if (content !== null && content !== undefined && typeof content !== "object" && typeof content !== "string") {
        content = String(content);
      }

      const toolResultBlock: any = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: content,
      };

      if (msg.cache_control) {
        toolResultBlock.cache_control = msg.cache_control;
      }

      const lastMsg = messages[messages.length - 1];
      if (
        lastMsg &&
        lastMsg.role === "user" &&
        Array.isArray(lastMsg.content)
      ) {
        lastMsg.content.push(toolResultBlock);
      } else {
        messages.push({
          role: "user",
          content: [toolResultBlock],
        });
      }
    } else if (msg.role === "user") {
      const contentBlocks: any[] = [];
      if (typeof msg.content === "string") {
        contentBlocks.push({ type: "text", text: msg.content });
      } else if (Array.isArray(msg.content)) {
        msg.content.forEach((block: any) => {
          if (block && typeof block === "object") {
            if (block.type === "image_url" && block.image_url?.url) {
              contentBlocks.push({
                type: "image",
                source: {
                  type: "base64",
                  media_type: block.media_type || "image/jpeg",
                  data: block.image_url.url.split(",")[1] || block.image_url.url,
                },
              });
            } else {
              contentBlocks.push(block);
            }
          } else {
            contentBlocks.push(block);
          }
        });
      }

      const lastMsg = messages[messages.length - 1];
      if (
        lastMsg &&
        lastMsg.role === "user" &&
        Array.isArray(lastMsg.content)
      ) {
        lastMsg.content.push(...contentBlocks);
      } else {
        messages.push({
          role: "user",
          content: contentBlocks.length > 0 ? contentBlocks : [{ type: "text", text: " " }],
        });
      }
    } else if (msg.role === "assistant") {
      const contentBlocks: any[] = [];
      if (msg.content) {
        if (typeof msg.content === "string") {
          contentBlocks.push({ type: "text", text: msg.content });
        } else if (Array.isArray(msg.content)) {
          contentBlocks.push(...msg.content);
        }
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        msg.tool_calls.forEach((call) => {
          let input = {};
          try {
            input = JSON.parse(call.function.arguments);
          } catch (e) {
            input = call.function.arguments;
          }
          contentBlocks.push({
            type: "tool_use",
            id: call.id,
            name: call.function.name,
            input: input,
          });
        });
      }

      if (msg.thinking) {
        contentBlocks.unshift({
          type: "thinking",
          thinking: msg.thinking.content,
          signature: msg.thinking.signature,
        });
      }

      const lastMsg = messages[messages.length - 1];
      if (
        lastMsg &&
        lastMsg.role === "assistant" &&
        Array.isArray(lastMsg.content)
      ) {
        lastMsg.content.push(...contentBlocks);
      } else {
        messages.push({
          role: "assistant",
          content: contentBlocks.length > 0 ? contentBlocks : [{ type: "text", text: " " }],
        });
      }
    }
  }

  const countCacheBreakpoints = () => {
    let count = systemBlocks.filter((block) => block?.cache_control).length;
    for (const message of messages as any[]) {
      if (!Array.isArray(message.content)) continue;
      count += message.content.filter((block: any) => block?.cache_control).length;
    }
    return count;
  };

  const cloneCacheControl = (cacheControl: any) =>
    cacheControl && typeof cacheControl === "object"
      ? { ...cacheControl }
      : { type: "ephemeral" };

  const findLatestCacheControl = () => {
    for (let i = (messages as any[]).length - 1; i >= 0; i--) {
      const content = (messages as any[])[i]?.content;
      if (!Array.isArray(content)) continue;
      const cachedBlock = content.find((block: any) => block?.cache_control);
      if (cachedBlock?.cache_control) return cachedBlock.cache_control;
    }
    for (let i = systemBlocks.length - 1; i >= 0; i--) {
      if (systemBlocks[i]?.cache_control) return systemBlocks[i].cache_control;
    }
    return { type: "ephemeral" };
  };

  const addCacheBreakpointToMessage = (message: any, cacheControl: any) => {
    if (!Array.isArray(message?.content)) return false;
    if (message.content.some((block: any) => block?.cache_control)) return false;

    const targetBlock = message.content.find(
      (block: any) => block && typeof block === "object" && !block.cache_control
    );
    if (!targetBlock) return false;

    targetBlock.cache_control = cloneCacheControl(cacheControl);
    return true;
  };

  const ensureMessageCacheBreakpoints = () => {
    let remaining = 4 - countCacheBreakpoints();
    if (remaining <= 0 || messages.length === 0) return;

    const anthropicMessages = messages as any[];
    const cacheControl = findLatestCacheControl();
    const candidateIndexes: number[] = [];

    for (let i = anthropicMessages.length - 1; i >= 0; i--) {
      if (anthropicMessages[i]?.role !== "user" || !Array.isArray(anthropicMessages[i].content)) {
        continue;
      }
      candidateIndexes.push(i);
    }

    for (const index of candidateIndexes) {
      if (remaining <= 0) break;
      if (addCacheBreakpointToMessage(anthropicMessages[index], cacheControl)) {
        remaining--;
      }
    }
  };

  ensureMessageCacheBreakpoints();

  const result: any = {
    messages,
    model: request.model,
    max_tokens: request.max_tokens || 4096,
    temperature: request.temperature,
    stream: request.stream,
  };

  // Restore the Anthropic thinking block from unified reasoning. Claude Code
  // and other Anthropic clients send thinking on every request; without this
  // mapping the param was silently dropped on Anthropic-endpoint providers,
  // losing both the client's explicit level and the defaultthinking
  // transformer's provider-level default. budget_tokens must stay below
  // max_tokens, so clamp; skip entirely when there is no room for the
  // 1024-token minimum.
  if (request.reasoning?.enabled) {
    const rawBudget =
      request.reasoning.max_tokens ||
      getThinkBudget(request.reasoning.effort || "medium");
    const budget = Math.min(rawBudget, (result.max_tokens as number) - 1024);
    if (budget >= 1024) {
      result.thinking = { type: "enabled", budget_tokens: budget };
    }
  }

  if (systemBlocks.length > 0) {
    const hasCacheControl = systemBlocks.some((block) => block?.cache_control);
    result.system = hasCacheControl
      ? systemBlocks
      : systemBlocks.map((block) => block.text || "").join("\n\n");
  }

  if (request.tools && request.tools.length > 0) {
    result.tools = convertToolsToAnthropic(request.tools);
    if (request.tool_choice) {
      if (request.tool_choice === "auto") {
        result.tool_choice = { type: "auto" };
      } else if (request.tool_choice === "any" || request.tool_choice === "required") {
        result.tool_choice = { type: "any" };
      } else if (typeof request.tool_choice === "string") {
        result.tool_choice = { type: "tool", name: request.tool_choice };
      } else if (
        typeof request.tool_choice === "object" &&
        request.tool_choice.type === "function"
      ) {
        result.tool_choice = {
          type: "tool",
          name: request.tool_choice.function.name,
        };
      }
    }
  }

  return result;
}

export function convertRequest(
  request: OpenAIChatRequest | AnthropicChatRequest | UnifiedChatRequest,
  options: ConversionOptions
): OpenAIChatRequest | AnthropicChatRequest {
  let unifiedRequest: UnifiedChatRequest;
  if (options.sourceProvider === "openai") {
    unifiedRequest = convertFromOpenAI(request as OpenAIChatRequest);
  } else if (options.sourceProvider === "anthropic") {
    unifiedRequest = convertFromAnthropic(request as AnthropicChatRequest);
  } else {
    unifiedRequest = request as UnifiedChatRequest;
  }

  if (options.targetProvider === "openai") {
    return convertToOpenAI(unifiedRequest);
  } else {
    return convertToAnthropic(unifiedRequest);
  }
}
