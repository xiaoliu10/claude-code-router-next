import { ThinkLevel } from "@/types/llm";

export const getThinkLevel = (thinking_budget: number): ThinkLevel => {
  if (thinking_budget <= 0) return "none";
  if (thinking_budget <= 1024) return "low";
  if (thinking_budget <= 8192) return "medium";
  return "high";
};

// Inverse of getThinkLevel for producing an Anthropic thinking budget from a
// ThinkLevel. Anthropic requires budget_tokens >= 1024, so "none" maps to 0
// and callers must not emit a thinking block for it.
export const getThinkBudget = (level: ThinkLevel): number => {
  if (level === "none") return 0;
  if (level === "low") return 1024;
  if (level === "medium") return 8192;
  return 16384;
};
