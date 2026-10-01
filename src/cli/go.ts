import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pc from 'picocolors';
import type { Workspace } from '../config/load.js';
import { interactiveLogin } from '../capture/auth.js';
import { launchBrowser } from '../capture/browser.js';
import { verifySession } from '../capture/runner.js';
import { authProfile } from '../capture/session.js';
import { plural, type Logger } from '../util/log.js';
import { errorMessage } from '../util/pool.js';
import { runRefresh, type RefreshResult } from './refresh.js';

export interface GoOptions {
  env?: string;
  commit?: boolean;
  push?: boolean;
  log: Logger;
}

/**
 * Everything in one command for the first run (and any later one):
 * browser → logins only where the session is missing or expired → full refresh (discover + flows + tags) → gallery.
 * The only manual step left is passing SSO/2FA in the browser windows it opens.
 */
export async function runGo(ws: Workspace, o: GoOptions): Promise<RefreshResult> {
  const { log } = o;
  const env = o.env ?? ws.config.environment;

  log.info(pc.bold('1/3 Браузер'));
  let browser;
  try {
    browser = await launchBrowser(ws.config);
  } catch {
    log.info('Ставлю Chromium для Playwright (один раз)…');
    const r = spawnSync('npx', ['playwright', 'install', 'chromium'], { cwd: ws.root, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('не удалось установить Chromium: npx playwright install chromium');
    browser = await launchBrowser(ws.config);
  }
  log.ok(`Chromium ${browser.version()}`);

  log.info(pc.bold('\n2/3 Вход в стенды'));
  const byProfile = new Map(ws.products.filter((p) => p.auth.required && p.environments[env]).map((p) => [authProfile(p), p]));
  const needLogin = [];
  try {
    for (const [profile, product] of byProfile) {
      const check = await verifySession(ws, browser, product, env);
      if (check.ok) log.ok(`${profile}-${env}: сессия активна`);
      else needLogin.push(product);
    }
  } finally {
    await browser.close();
  }
  for (const product of needLogin) {
    log.info(`\n${pc.bold(product.name)}: откроется окно браузера — войди через SSO, дальше всё само.`);
    try {
      const file = await interactiveLogin(ws, product, { env, log });
      log.ok(`сессия сохранена: ${path.relative(ws.root, file)}`);
    } catch (err) {
      log.warn(`${product.name}: вход не выполнен (${errorMessage(err)}) — этот продукт пропущу`);
    }
  }

  log.info(pc.bold('\n3/3 Съёмка, обход разделов, автотеги'));
  const result = await runRefresh(ws, { env, commit: o.commit, push: o.push, log });

  const s = result.capture.run.stats;
  log.info(
    `\n${pc.bold('Готово:')} ${plural(s.captured, ['экран', 'экрана', 'экранов'])} (новых ${s.added}, изменилось ${s.changed}), ` +
      `из обхода разделов ${result.discovered}, автотегов ${result.tagged}` +
      (s.failed ? `, ошибок ${s.failed} (.scrn/failures)` : '') +
      (s.unsafe ? `, в карантине ${s.unsafe} (.scrn/quarantine)` : ''),
  );
  for (const n of result.capture.run.notes) log.warn(n);
  const todos = ws.products.flatMap((p) => p.flows.filter((f) => f.todo).map((f) => `${p.id}/${f.id}: ${f.todo}`));
  if (todos.length) {
    log.dim('\nЖдут уточнения в каталоге (catalog/products/*.yaml):');
    for (const t of todos) log.dim(`  • ${t}`);
  }
  return result;
}
