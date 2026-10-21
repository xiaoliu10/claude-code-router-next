/**
 * The plugin's locale bundle for /api/plugins (contract §2.3): the UI hands
 * `props.locales` to the card chunk, so the card localizes itself through this
 * single source. The strings are READ FROM the UI package's locale files at
 * build time — one source of truth, no drift between card and host copy.
 */
import enJson from "../../../ui/src/locales/en.json";
import zhJson from "../../../ui/src/locales/zh.json";

type Bundle = Record<string, Record<string, unknown>>;

const en = (enJson as any).geminiOauth as Record<string, unknown>;
const zh = (zhJson as any).geminiOauth as Record<string, unknown>;
if (!en || !zh) {
  throw new Error("geminiOauth locale segment missing from ui/src/locales/{en,zh}.json");
}

export const geminiOauthLocales: Bundle = {
  en: { geminiOauth: en },
  zh: { geminiOauth: zh },
};
