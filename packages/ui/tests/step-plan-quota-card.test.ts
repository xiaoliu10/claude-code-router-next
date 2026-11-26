import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import i18next from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { runnerImport } from "vite";
import type { ProviderQuotaUsage, StepPlanQuotaSnapshot } from "../src/types.ts";

const source = fileURLToPath(new URL("../src/", import.meta.url));
const { module: { ProviderList } } = await runnerImport<typeof import("../src/components/ProviderList.tsx")>(
  `${source}components/ProviderList.tsx`,
  {
    root: fileURLToPath(new URL("../", import.meta.url)),
    esbuild: { jsx: "automatic" },
    resolve: { alias: { "@": source.replace(/\/$/, "") } },
  },
);

const resources = Object.fromEntries(["en", "zh"].map(lang => [lang, {
  translation: JSON.parse(readFileSync(new URL(`../src/locales/${lang}.json`, import.meta.url), "utf8")),
}]));

const observedAt = Date.parse("2026-11-19T10:00:00.123Z");
const subscriptionExpiry = Date.parse("2026-12-19T10:00:00.123Z");
const quotaRow: ProviderQuotaUsage = { provider: "step", used5h: 84, used7d: 0, limit5h: 100 };
const tokenPlan: StepPlanQuotaSnapshot = {
  state: "known", family: "token", name: "Plus", observedAt, allowed: true, windows: [],
  creditBuckets: [{
    type: "subscription", total: "9007199254740993.123456789", remaining: "0",
    usedPercent: 100, resetsAt: null, expiresAt: subscriptionExpiry,
  }],
};

async function renderQuota(stepPlan?: StepPlanQuotaSnapshot, lang = "en") {
  const i18n = i18next.createInstance();
  await i18n.init({ lng: lang, resources, interpolation: { escapeValue: false } });
  return renderToStaticMarkup(createElement(I18nextProvider, {
    i18n,
    children: createElement(ProviderList, {
      providers: [{ name: "step", api_base_url: "https://example.invalid", api_key: "", models: [] }],
      quotaUsages: [{ ...quotaRow, stepPlan }],
      onEdit: () => {}, onRemove: () => {}, onReorder: () => {},
    }),
  }));
}

test("ProviderList renders Step Plan Credit exactly and keeps each top-up with its own expiry", async () => {
  const firstExpiry = Date.parse("2026-12-20T10:00:00.123Z");
  const secondExpiry = Date.parse("2027-01-10T11:00:00.123Z");
  const html = await renderQuota({ ...tokenPlan, creditBuckets: [
    ...tokenPlan.creditBuckets,
    { type: "topup", total: "4.0", remaining: "3.506173", usedPercent: 12.345675, resetsAt: null, expiresAt: firstExpiry },
    { type: "topup", total: "10", remaining: "10", usedPercent: 0, resetsAt: null, expiresAt: secondExpiry },
  ] });

  assert.match(html, /aria-label="Step Plan quota".*Plus/);
  assert.match(html, /Last observed:/);
  assert.match(html, /Account usage allowed/);
  assert.match(html, /Monthly subscription Credit.*100% used.*Remaining:.*<bdi>0<\/bdi>.*Total:.*9007199254740993\.123456789/);
  const [subscription, firstTopup, secondTopup] = html.split("Top-up Credit");
  assert.ok(subscription.includes(new Date(subscriptionExpiry).toISOString()));
  assert.match(firstTopup, /12\.345675% used.*3\.506173.*4\.0/);
  assert.ok(firstTopup.includes(new Date(firstExpiry).toISOString()));
  assert.match(secondTopup, /0% used.*width:0%/);
  assert.ok(secondTopup.includes(new Date(secondExpiry).toISOString()));
  assert.equal(html.match(/Expires:/g)?.length, 3);
  assert.doesNotMatch(html, /Reset:|84\.0%|5-hour/);
});

test("Step Plan Coding quota renders unlimited and genuine zero with localized window and reset labels", async () => {
  const html = await renderQuota({ ...tokenPlan, family: "coding", allowed: false, name: null, windows: [
    { id: "five_hour", limited: false, usedPercent: 87, resetsAt: null },
    { id: "weekly", limited: true, usedPercent: 0, resetsAt: subscriptionExpiry },
  ] }, "zh");

  assert.match(html, /Step Plan 额度.*账户不允许使用.*5小时.*无限额.*7天.*已用 0%.*重置：/);
  assert.ok(html.includes(new Date(subscriptionExpiry).toISOString()));
  assert.doesNotMatch(html, /87%|月度订阅 Credit|到期：/);
});

test("Partial Step Plan snapshots show missing values without inventing usage or resetting expiry-only buckets", async () => {
  const html = await renderQuota({ ...tokenPlan, state: "partial", observedAt: null, allowed: null, creditBuckets: [
    { ...tokenPlan.creditBuckets[0], usedPercent: null, remaining: "", resetsAt: null },
  ] });

  assert.match(html, /Some quota data is missing.*Monthly subscription Credit.*—.*Remaining: —.*9007199254740993\.123456789.*Expires:/);
  assert.doesNotMatch(html, /Last observed:|Account usage|Reset:|% used|width:0%/);
});

test("Stale Step Plan snapshots retain observed usage and unavailable rows hide residual quota", async () => {
  const stale = await renderQuota({ ...tokenPlan, state: "stale" });
  assert.match(stale, /Outdated quota snapshot.*Last observed:.*100% used/);
  assert.ok(stale.includes(new Date(observedAt).toISOString()));

  const unavailable = await renderQuota({ ...tokenPlan, state: "unavailable", family: "none", observedAt: null, allowed: null });
  assert.match(unavailable, /Quota data unavailable/);
  assert.doesNotMatch(unavailable, /Monthly subscription Credit|Last observed:|100% used|84\.0%/);
});

test("Step Plan renders upstream names as text and bounds progress geometry", async () => {
  const html = await renderQuota({ ...tokenPlan, name: '<script>alert("plan")</script>', creditBuckets: [
    { ...tokenPlan.creditBuckets[0], usedPercent: 123.4567, resetsAt: Number.MAX_VALUE, expiresAt: null },
    { ...tokenPlan.creditBuckets[0], usedPercent: Number.NaN, remaining: "<svg onload=alert(1)>", expiresAt: null },
  ] });

  assert.match(html, /&lt;script&gt;alert\(&quot;plan&quot;\)&lt;\/script&gt;/);
  assert.match(html, /123\.4567% used.*width:100%/);
  assert.match(html, /Remaining: —/);
  assert.doesNotMatch(html, /<script>|onload=|NaN|Invalid Date|Reset:/);
});

test("ProviderList keeps the legacy quota card when Step Plan is absent", async () => {
  const html = await renderQuota();
  assert.match(html, /5-hour.*84\.0%.*7-day/);
  assert.doesNotMatch(html, /Step Plan quota/);
});
