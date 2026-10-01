import readline from 'node:readline';
import type { Workspace } from '../config/load.js';
import type { Product } from '../config/schema.js';
import type { Logger } from '../util/log.js';
import { resolveUrl } from './actions.js';
import { contextOptions, launchBrowser, resolvePlatform } from './browser.js';
import { authProfile, isLoggedIn, loadSession, saveSession, sessionStorageInitScript } from './session.js';

/**
 * `scrn auth <product>`: opens a real browser window, the human passes SSO/2FA, the session is saved
 * to .auth/<profile>-<env>.json as soon as the app looks logged in (or when Enter is pressed).
 */
export async function interactiveLogin(
  ws: Workspace,
  product: Product,
  opts: { env: string; log: Logger; timeoutMs?: number },
): Promise<string> {
  const env = product.environments[opts.env];
  if (!env) throw new Error(`${product.id}: нет окружения ${opts.env}`);
  const profile = authProfile(product);
  const vars = { ...product.vars, ...env.vars };
  const existing = loadSession(ws.paths.auth, profile, opts.env);
  const browser = await launchBrowser(ws.config, { headed: true });
  const platform = resolvePlatform(ws.config, 'desktop' in ws.config.platforms ? 'desktop' : Object.keys(ws.config.platforms)[0]);
  const context = await browser.newContext({
    ...contextOptions({ config: ws.config, product, platform, theme: product.themes[0], locale: product.locales[0], storageState: existing?.storageState }),
    deviceScaleFactor: 1,
  });
  const init = sessionStorageInitScript(existing);
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  const start = resolveUrl(env.baseUrl, product.auth.startUrl, vars);
  opts.log.info(`Открываю ${start}`);
  const reliable = !!product.auth.loggedIn.selector;
  opts.log.info('Войди в систему в окне браузера (SSO / 2FA). Сессия сохранится автоматически, когда приложение откроется.');
  opts.log.dim(
    reliable
      ? 'Если автоопределение не сработает — нажми Enter в терминале, когда будешь внутри.'
      : 'Подсказка: укажи auth.loggedIn.selector в каталоге — так вход определяется надёжнее. Можно просто нажать Enter, когда будешь внутри.',
  );
  // Without an explicit selector, auto-save only after the user actually went through a login (a navigation
  // happened) — a landing page with an SSO button must not be mistaken for the app.
  let navigations = 0;
  await page.goto(start, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) navigations++;
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  let manual = false;
  rl.once('line', () => {
    manual = true;
  });

  try {
    const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
    let streak = 0;
    while (Date.now() < deadline && !manual) {
      await page.waitForTimeout(1000);
      const active = context.pages().at(-1) ?? page;
      const ok = (reliable || navigations > 0) && (await isLoggedIn(active, product).catch(() => false));
      streak = ok ? streak + 1 : 0;
      if (streak >= (reliable ? 2 : 3)) break;
    }
    if (!manual && Date.now() >= deadline) throw new Error('не дождался входа за 10 минут');
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
    const file = await saveSession(context, page, { authDir: ws.paths.auth, profile, environment: opts.env, baseUrl: env.baseUrl });
    return file;
  } finally {
    rl.close();
    await browser.close().catch(() => undefined);
  }
}
