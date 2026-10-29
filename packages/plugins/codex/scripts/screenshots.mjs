/** Throwaway fixture browser evidence. Physical account UNTESTED. No external requests. */
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const packageRoot = resolve(root, 'packages/plugins/codex');
const output = process.env.CODEX_SCREENSHOT_DIR;
if (!output || !process.env.PLAYWRIGHT_MODULE) throw new Error('Set CODEX_SCREENSHOT_DIR and PLAYWRIGHT_MODULE to existing absolute paths');
console.log('Playwright realpath:', realpathSync(process.env.PLAYWRIGHT_MODULE));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const hostBuild = readFileSync(join(root, 'packages/ui/dist/index.html'), 'utf8');
const css = [...hostBuild.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
if (!css) throw new Error('Build the real UI first (dist/index.html stylesheet missing)');
let state = 'not-connected';
const status = () => ({ status: state === 'connected' || state === 'cooldown' ? 'connected' : 'not_connected',
  providerName: 'codex-subscription', models: state === 'connected' || state === 'cooldown' ? ['fixture-model'] : [],
  modelCount: state === 'connected' || state === 'cooldown' ? 1 : 0,
  ...(state === 'connected' || state === 'cooldown' ? { email: 'fixture@example.invalid', accountId: 'fixture-account', plan: 'fixture' } : {}),
  ...(state === 'cooldown' ? { coolingUntil: Date.now() + 3600000 } : {}) });
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://fixture').pathname;
  if (path === '/card.js') { res.setHeader('content-type', 'text/javascript'); return res.end(readFileSync(join(packageRoot, 'dist/card.js'))); }
  if (path === '/host.js') { res.setHeader('content-type', 'text/javascript'); return res.end(readFileSync(join(output, 'host.js'))); }
  if (path.startsWith('/api/codex/')) {
    res.setHeader('content-type', 'application/json');
    if (path.endsWith('/status')) return res.end(JSON.stringify(status()));
    if (path.endsWith('/usage')) return res.end(JSON.stringify({ plan: 'fixture', primary: { usedPercent: state === 'cooldown' ? 100 : 27, windowSeconds: 18000, resetAt: Date.now()+3600000 } }));
    if (path.endsWith('/login/start')) return res.end(JSON.stringify({ loginId: 'a'.repeat(32), url: 'https://auth.openai.com/oauth/authorize?fixture=true',
      expiresAt: Date.now()+600000, mode: 'paste', redirectUri: 'http://127.0.0.1:1455/auth/callback' }));
    return res.end(JSON.stringify({ status: 'pending' }));
  }
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><html class="dark"><head><meta charset="utf-8"><style>${css}</style></head><body class="bg-background text-foreground"><main class="mx-auto max-w-5xl p-8 space-y-6"><h1 class="text-2xl font-bold">Provider settings — Codex fixture</h1><p>Physical account UNTESTED · isolated fixture server · real built host stylesheet/controller</p><section id="cards"></section></main><script type="module">
    import { createPluginCardAreaController } from '/host.js';
    const controller = createPluginCardAreaController({origin:location.origin,getDisabled:()=>false,
      callPluginApi:async(name,path,init)=>{const r=await fetch('/api/'+name+path,init);return r.json()},
      fetchCardSource:async()=>fetch('/card.js').then(r=>r.text()),importModule:u=>import(u),
      makeBlobUrl:s=>URL.createObjectURL(new Blob([s],{type:'text/javascript'})),revokeBlobUrl:u=>URL.revokeObjectURL(u),
      acquireManagement:()=>()=>{},refreshConfig:async()=>{},log:console});
    await controller.sync([{name:'codex',version:'1.0.0',enabled:true,cardUrl:'/card.js'}],'en',document.querySelector('#cards'));
  </script></body></html>`);
});
mkdirSync(output, { recursive: true });
const esbuildPath = process.env.ESBUILD_MODULE;
if (!esbuildPath) throw new Error('Set ESBUILD_MODULE to the existing absolute esbuild module');
console.log('esbuild realpath:', realpathSync(esbuildPath));
const { build } = await import(pathToFileURL(esbuildPath).href);
await build({ entryPoints: [join(root,'packages/ui/src/utils/plugin-card.ts')], bundle:true,platform:'browser',format:'esm',outfile:join(output,'host.js') });
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless:true, ...(process.env.CHROME_EXECUTABLE ? {executablePath:process.env.CHROME_EXECUTABLE} : {}) });
const errors = [];
try {
  for (state of ['not-connected','connected','cooldown','paste']) {
    const page = await browser.newPage({viewport:{width:1280,height:1000},deviceScaleFactor:1});
    page.on('pageerror', e=>errors.push(String(e)));
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.goto(base);
    await page.getByText('Codex Subscription', {exact:true}).waitFor();
    await page.waitForTimeout(250);
    if (state === 'paste') { await page.getByRole('button',{name:'Browser login',exact:true}).click(); await page.getByText('Paste callback URL',{exact:true}).waitFor(); }
    await page.screenshot({path:join(output,`${state}.png`),fullPage:true});
    console.log(state, join(output,`${state}.png`));
    await page.close();
  }
  writeFileSync(join(output,'evidence.json'),JSON.stringify({physicalAccount:'UNTESTED',errors,source:'real built UI stylesheet + real host card controller + built plugin card, isolated fixture API'},null,2));
  if(errors.length) throw new Error(errors.join('\n'));
} finally { await browser.close(); await new Promise(r=>server.close(r)); }
