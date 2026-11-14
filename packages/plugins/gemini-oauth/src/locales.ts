/** Build-time-only imports: esbuild tree-shakes every unrelated UI namespace.
 * The UI retains geminiOauth copy for generic provider-management notices;
 * this bundle travels through /api/plugins and is also a card fallback. */
import { geminiOauth as en } from "../../../ui/src/locales/en.json";
import { geminiOauth as zh } from "../../../ui/src/locales/zh.json";

/**
 * Model-management copy the shared UI bundle does not carry: the hide /
 * hidden-restore surface ships with the plugin, not the UI. Merged over the
 * UI namespace at build time; the `errors` keys added here extend the card's
 * localizable error whitelist (a code renders only when the bundle carries
 * copy for it). EN and ZH must keep identical key trees and placeholder names
 * (asserted by test/card-model-management.test.ts), and the copy stays plain
 * text — never markup, never a raw gemini_oauth_* code.
 */
const EN_MODEL_MANAGEMENT = {
  hidden_note: "Hidden models stay hidden across syncs and re-logins until you restore them.",
  errors: {
    gemini_oauth_model_invalid:
      "That model is not exposed by the managed provider. Refresh the model list and retry.",
  },
  quota: {
    title: "Subscription quota",
    refresh: "Refresh quota",
    unavailable: "Quota unavailable. Refresh to try again.",
    model_buckets: "Model quota buckets",
    grouped_windows: "Upstream grouped windows",
    model_note: "Per-model buckets have no fixed window label; each reset applies only to that bucket.",
    pool_note: "Group totals from the upstream summary with their own 5h/weekly windows — not per-model limits.",
    reset_at: "Resets {{time}}",
    variants: "{{count}} effort variants",
    exhausted: "Exhausted",
    identity: {
      argon: "Argon",
      hydrogen: "Hydrogen",
      claude: "Claude",
      other: "Unknown",
    },
  },
};
const ZH_MODEL_MANAGEMENT = {
  hidden_note: "隐藏的模型在同步与重新登录后仍保持隐藏，直到你恢复它们。",
  errors: {
    gemini_oauth_model_invalid: "受管供应商未提供该模型，请刷新模型列表后重试。",
  },
  quota: {
    title: "订阅配额",
    refresh: "刷新配额",
    unavailable: "配额暂不可用，可刷新重试。",
    model_buckets: "模型配额桶",
    grouped_windows: "上游分组窗口",
    model_note: "模型桶没有固定窗口标签，重置时间仅适用于对应桶。",
    pool_note: "上游汇总的分组总量，各自带 5 小时/周窗口，并非单个模型的额度。",
    reset_at: "{{time}} 重置",
    variants: "{{count}} 个推理档位变体",
    exhausted: "已耗尽",
    identity: {
      argon: "Argon",
      hydrogen: "Hydrogen",
      claude: "Claude",
      other: "未知",
    },
  },
};

const mergeModelManagement = (
  ui: typeof en,
  additions: typeof EN_MODEL_MANAGEMENT
): Record<string, unknown> => ({
  ...ui,
  ...additions,
  errors: { ...ui.errors, ...additions.errors },
});

export const geminiOauthLocales: Record<string, Record<string, unknown>> = {
  en: { geminiOauth: mergeModelManagement(en, EN_MODEL_MANAGEMENT) },
  zh: { geminiOauth: mergeModelManagement(zh, ZH_MODEL_MANAGEMENT) },
};
