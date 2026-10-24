/** Build-time-only imports: esbuild tree-shakes every unrelated UI namespace.
 * The UI retains geminiOauth copy for generic provider-management notices;
 * this bundle travels through /api/plugins and is also a card fallback. */
import { geminiOauth as en } from "../../../ui/src/locales/en.json";
import { geminiOauth as zh } from "../../../ui/src/locales/zh.json";
export const geminiOauthLocales: Record<string, Record<string, unknown>> = {
  en: { geminiOauth: en },
  zh: { geminiOauth: zh },
};
