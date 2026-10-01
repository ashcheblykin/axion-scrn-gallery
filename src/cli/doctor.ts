import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import type { Workspace } from '../config/load.js';
import { launchBrowser } from '../capture/browser.js';
import { authProfile, loadSession, sessionAgeDays } from '../capture/session.js';
import { isLfsPointer, Library } from '../library/store.js';
import { hasClaudeCredentials } from '../tagging/claude.js';
import { isGitRepo, lfsReady } from '../util/git.js';
import { plural, type Logger } from '../util/log.js';
import { errorMessage } from '../util/pool.js';

/** CSS selectors from the catalog (Playwright-only engines like text= / role= are skipped). */
function cssSelectors(ws: Workspace): { where: string; selector: string }[] {
  const out: { where: string; selector: string }[] = [];
  const add = (where: string, list: string[]) => list.forEach((selector) => out.push({ where, selector }));
  for (const p of ws.products) {
    add(`${p.id}.capture.waitForHidden`, p.capture.waitForHidden);
    add(`${p.id}.capture.hide`, p.capture.hide);
    add(`${p.id}.capture.backdrop`, p.capture.backdrop);
    add(`${p.id}.capture.chrome`, p.capture.chrome);
    add(`${p.id}.capture.ignoreInDiff`, p.capture.ignoreInDiff);
    add(`${p.id}.anonymize.rules`, p.anonymize.rules.map((r) => r.selector));
    add(`${p.id}.anonymize.images`, p.anonymize.images.map((r) => r.selector));
    add(`${p.id}.anonymize.blur`, p.anonymize.blur);
    add(`${p.id}.anonymize.hide`, p.anonymize.hide);
    for (const f of p.flows) for (const s of f.steps) add(`${p.id}/${f.id}/${s.id}.hide`, s.hide);
  }
  return out;
}

export async function doctor(ws: Workspace, log: Logger): Promise<number> {
  let problems = 0;
  const ok = (m: string) => log.ok(m);
  const bad = (m: string) => {
    problems++;
    log.error(m);
  };

  log.info(pc.bold('Каталог'));
  ok(`${plural(ws.products.length, ['продукт', 'продукта', 'продуктов'])}: ${ws.products.map((p) => `${p.name} (${p.flows.length} флоу)`).join(', ')}`);
  for (const w of ws.warnings) log.warn(w);
  const todos = ws.products.flatMap((p) =>
    p.flows.flatMap((f) => [
      ...(f.todo ? [`${p.id}/${f.id}: ${f.todo}`] : []),
      ...f.steps.filter((s) => s.todo).map((s) => `${p.id}/${f.id}/${s.id}: ${s.todo}`),
    ]),
  );
  for (const t of todos) log.dim(`  TODO ${t}`);

  log.info(pc.bold('\nБраузер'));
  let browserOk = false;
  try {
    const browser = await launchBrowser(ws.config);
    ok(`Chromium ${browser.version()}`);
    const page = await browser.newPage();
    const invalid = await page.evaluate((list) => {
      const out: string[] = [];
      for (const { where, selector } of list) {
        try {
          document.querySelector(selector);
        } catch {
          out.push(`${where}: ${selector}`);
        }
      }
      return out;
    }, cssSelectors(ws));
    for (const i of invalid) bad(`невалидный CSS-селектор — ${i}`);
    await browser.close();
    browserOk = true;
  } catch (err) {
    bad(`Chromium не запускается: ${errorMessage(err)}\n  → npx playwright install chromium`);
  }
  void browserOk;

  log.info(pc.bold('\nСессии стендов'));
  const env = ws.config.environment;
  for (const profile of [...new Set(ws.products.map(authProfile))]) {
    const products = ws.products.filter((p) => authProfile(p) === profile);
    const needs = products.some((p) => p.auth.required);
    const s = loadSession(ws.paths.auth, profile, env);
    if (!s) {
      if (needs) bad(`${profile}-${env}: нет сессии → scrn auth ${products[0].id}`);
      continue;
    }
    const age = sessionAgeDays(s);
    const msg = `${profile}-${env}: сохранена ${age.toFixed(1)} дн. назад (${products.map((p) => p.id).join(', ')})`;
    if (age > 14) log.warn(`${msg} — возможно, истекла; проверь: scrn auth --check`);
    else ok(msg);
  }

  log.info(pc.bold('\nИнтеграции'));
  if (hasClaudeCredentials()) ok('Claude API: ключ найден (автотеги и privacy-аудит)');
  else log.warn('Claude API: нет ANTHROPIC_API_KEY — автотеги отключены');
  const figmaSteps = ws.products.some((p) => p.flows.some((f) => !f.todo && f.steps.some((s) => s.figma && !s.todo)));
  if (figmaSteps && !process.env.FIGMA_TOKEN) bad('Figma: в каталоге есть шаги из Figma, но нет FIGMA_TOKEN');
  else if (process.env.FIGMA_TOKEN) ok('Figma: токен найден');

  log.info(pc.bold('\nБиблиотека и git'));
  if (!isGitRepo(ws.root)) log.warn('не git-репозиторий — версии и публикация через git недоступны');
  if (!lfsReady(ws.root)) bad('git-lfs не установлен → brew install git-lfs && git lfs install');
  else ok('git-lfs установлен');
  if (!fs.existsSync(path.join(ws.root, '.gitattributes'))) bad('нет .gitattributes — PNG попадут в обычный git');
  const library = Library.open(ws.paths.library);
  const screens = library.index.screens;
  const pointers = screens.filter((s) => isLfsPointer(library.abs(s.files.default.path))).length;
  if (screens.length) ok(`${plural(screens.length, ['экран', 'экрана', 'экранов'])} в библиотеке, обновлено ${library.index.updatedAt.slice(0, 16).replace('T', ' ')}`);
  else log.dim('  библиотека пока пуста → scrn capture brief');
  if (pointers) log.warn(`${pointers} файлов не скачаны из LFS → git lfs pull`);
  const byStatus = screens.reduce<Record<string, number>>((acc, s) => ((acc[s.status] = (acc[s.status] ?? 0) + 1), acc), {});
  if (Object.keys(byStatus).length) log.dim(`  статусы: ${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(', ')}`);

  log.info(problems ? pc.red(`\nПроблем: ${problems}`) : pc.green('\nВсё готово к съёмке.'));
  return problems;
}
