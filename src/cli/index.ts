#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';
import { Cron } from 'croner';
import pc from 'picocolors';
import { ConfigError, loadWorkspace, type Workspace } from '../config/load.js';
import { interactiveLogin } from '../capture/auth.js';
import { launchBrowser } from '../capture/browser.js';
import { crawl, discoveredFlow, writeSuggestions } from '../capture/discover.js';
import { parseTargets, runCapture, verifySession } from '../capture/runner.js';
import { authProfile } from '../capture/session.js';
import { buildGallery } from '../gallery/build.js';
import { EXPORT_VARIANTS, exportScreens, type ExportVariant } from '../library/export.js';
import { LibrarySearch } from '../library/search.js';
import { Library } from '../library/store.js';
import { runTagging } from '../tagging/run.js';
import { taggingQueue } from '../tagging/tags.js';
import { fileHistory, summary } from '../util/git.js';
import { createLogger, plural, type Logger } from '../util/log.js';
import { errorMessage } from '../util/pool.js';
import { doctor } from './doctor.js';
import { runRefresh } from './refresh.js';
import { installSchedule, refreshCommand, uninstallSchedule } from './schedule.js';
import { writeJsonSchemas } from './schemas.js';
import { serveLibrary } from './serve.js';

const program = new Command();
program
  .name('scrn')
  .description('Движок библиотеки экранов Axion (Gen, Command & Control, Sense): флоу как в Mobbin, Retina, обезличивание, версии, MCP.')
  .version('0.1.0')
  .option('--root <dir>', 'корень репозитория (по умолчанию ищется scrn.config.yaml вверх от текущей папки)')
  .option('-v, --verbose', 'подробный лог');

const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);

function ctx(): { ws: Workspace; log: Logger } {
  const g = program.opts<{ root?: string; verbose?: boolean }>();
  const log = createLogger({ verbose: g.verbose });
  return { ws: loadWorkspace({ root: g.root }), log };
}

function openInBrowser(target: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  execFile(cmd, [target], () => undefined);
}

function printStats(log: Logger, stats: { captured: number; added: number; changed: number; unchanged: number; failed: number; unsafe: number; skipped: number }) {
  log.info(
    `\n${pc.bold('Итог:')} снято ${stats.captured} · новых ${pc.green(String(stats.added))} · изменилось ${pc.green(String(stats.changed))} · ` +
      `без изменений ${stats.unchanged} · ошибок ${stats.failed ? pc.red(String(stats.failed)) : 0} · карантин ${stats.unsafe ? pc.yellow(String(stats.unsafe)) : 0} · пропущено ${stats.skipped}`,
  );
}

program
  .command('init')
  .description('Первичная настройка: .env, git lfs, браузер, папка для сессий')
  .action(async () => {
    const { ws, log } = ctx();
    const env = path.join(ws.root, '.env');
    if (!fs.existsSync(env) && fs.existsSync(path.join(ws.root, '.env.example'))) {
      fs.copyFileSync(path.join(ws.root, '.env.example'), env);
      log.ok('создан .env из .env.example — впиши FIGMA_TOKEN, если нужны мобильные макеты из Figma');
    }
    fs.mkdirSync(ws.paths.auth, { recursive: true, mode: 0o700 });
    await new Promise<void>((resolve) => execFile('git', ['lfs', 'install', '--local'], { cwd: ws.root }, () => resolve()));
    log.info('Дальше:\n  1) npx playwright install chromium\n  2) scrn auth gen && scrn auth cnc\n  3) scrn doctor\n  4) scrn capture brief --tag');
  });

program
  .command('doctor')
  .description('Проверить каталог, браузер, сессии, ключи и библиотеку')
  .action(async () => {
    const { ws, log } = ctx();
    process.exitCode = (await doctor(ws, log)) ? 1 : 0;
  });

program
  .command('auth')
  .description('Войти в стенд через браузер (SSO/2FA) и сохранить сессию для автоматической съёмки')
  .argument('[products...]', 'gen | cnc | sense (C&C и Sense делят одну сессию)')
  .option('-e, --env <env>', 'окружение')
  .option('--check', 'только проверить сохранённые сессии (без браузерного окна)')
  .action(async (products: string[], o: { env?: string; check?: boolean }) => {
    const { ws, log } = ctx();
    const env = o.env ?? ws.config.environment;
    const selected = products.length ? ws.products.filter((p) => products.includes(p.id)) : ws.products;
    if (products.length && selected.length !== products.length) throw new ConfigError(`неизвестный продукт: ${products.join(', ')}`);
    const byProfile = new Map(selected.map((p) => [authProfile(p), p]));
    if (o.check) {
      const browser = await launchBrowser(ws.config);
      try {
        for (const [profile, product] of byProfile) {
          const r = await verifySession(ws, browser, product, env);
          if (r.ok) log.ok(`${profile}-${env}: сессия активна`);
          else {
            log.error(`${profile}-${env}: ${r.reason}`);
            process.exitCode = 1;
          }
        }
      } finally {
        await browser.close();
      }
      return;
    }
    for (const [profile, product] of byProfile) {
      log.info(pc.bold(`\n${product.name} (${profile}-${env})`));
      const file = await interactiveLogin(ws, product, { env, log });
      log.ok(`сессия сохранена: ${path.relative(ws.root, file)}`);
    }
  });

program
  .command('capture')
  .description('Снять экраны: всё, продукт, флоу или шаг. Примеры: scrn capture brief · scrn capture gen/executive-summary')
  .argument('[targets...]', '<product>[/<flow>[/<step>]] | brief')
  .option('-p, --platform <list>', 'desktop,mobile', list)
  .option('--theme <list>', 'темы из каталога', list)
  .option('--locale <list>', 'локали из каталога', list)
  .option('-e, --env <env>', 'окружение (stage, prod…)')
  .option('-c, --concurrency <n>', 'параллельных флоу', (v) => Number(v))
  .option('--headed', 'показать окно браузера')
  .option('--force', 'записать новую версию, даже если экран не изменился')
  .option('--dry-run', 'снять в .scrn/dry-run, не трогая библиотеку')
  .option('--include-todo', 'снимать и шаги с todo')
  .option('--tag', 'сразу разметить новые и изменившиеся экраны (Claude Code)')
  .option('--no-gallery', 'не пересобирать library/index.html')
  .action(async (targetArgs: string[], o) => {
    const { ws, log } = ctx();
    const { targets, briefOnly } = parseTargets(targetArgs);
    const result = await runCapture(ws, {
      targets,
      briefOnly,
      platforms: o.platform,
      themes: o.theme,
      locales: o.locale,
      env: o.env,
      headed: o.headed,
      concurrency: o.concurrency,
      force: o.force,
      dryRun: o.dryRun,
      includeTodo: o.includeTodo,
      log,
    });
    for (const n of result.run.notes) log.warn(n);
    if (!o.dryRun) {
      const fresh = result.results.filter((r) => r.outcome === 'added' || r.outcome === 'changed').map((r) => r.id);
      if (o.tag && fresh.length) {
        const t = await runTagging(ws, { ids: fresh, log });
        for (const e of t.errors) log.warn(e);
        if (t.hint) log.dim(`Автотеги пропущены: ${t.hint}.`);
      }
      const library = Library.open(ws.paths.library);
      if (o.gallery !== false) log.dim(`галерея: ${path.relative(ws.root, buildGallery(ws, library.index))}`);
    }
    printStats(log, result.run.stats);
    if (result.run.stats.failed) process.exitCode = 2;
  });

program
  .command('discover')
  .description('Обойти навигацию и снять поверхностные экраны всех разделов (в т.ч. не описанных в каталоге)')
  .argument('[products...]')
  .option('-e, --env <env>')
  .option('--depth <n>', 'глубина обхода', (v) => Number(v))
  .option('--max <n>', 'максимум страниц на продукт', (v) => Number(v))
  .option('-p, --platform <list>', 'платформы для съёмки', list, ['desktop'])
  .option('--no-capture', 'только найти разделы и записать catalog/discovered/<product>.yaml')
  .option('--headed')
  .action(async (products: string[], o) => {
    const { ws, log } = ctx();
    const env = o.env ?? ws.config.environment;
    const browser = await launchBrowser(ws.config, { headed: o.headed });
    try {
      const extraFlows = [];
      for (const product of ws.products) {
        if (products.length && !products.includes(product.id)) continue;
        const pages = await crawl(ws, browser, product, { env, log, depth: o.depth, maxPages: o.max });
        const flow = discoveredFlow(pages, o.platform);
        if (!flow) {
          log.dim(`${product.id}: новых разделов не найдено`);
          continue;
        }
        log.ok(`${product.id}: ${plural(pages.length, ['раздел', 'раздела', 'разделов'])} → ${path.relative(ws.root, writeSuggestions(ws, product, flow))}`);
        for (const p of pages) log.dim(`  ${p.route}${p.text ? `  «${p.text}»` : ''}`);
        extraFlows.push({ product: product.id, flow });
      }
      if (o.capture && extraFlows.length) {
        const result = await runCapture(ws, {
          env,
          targets: extraFlows.map((x) => ({ product: x.product })),
          extraFlows,
          onlyExtra: true,
          platforms: o.platform,
          browser,
          log,
        });
        buildGallery(ws, Library.open(ws.paths.library).index);
        printStats(log, result.run.stats);
      }
    } finally {
      await browser.close();
    }
  });

program
  .command('refresh')
  .description('Полное обновление базы: обход разделов + все флоу → диф версий → автотеги → галерея → git')
  .argument('[products...]', 'ограничить продуктами')
  .option('-e, --env <env>')
  .option('--commit', 'закоммитить изменения библиотеки')
  .option('--push', 'запушить коммит')
  .option('--no-tag', 'без автотегов')
  .option('--no-discover', 'без обхода навигации')
  .option('--prune', 'удалить экраны, которых больше нет в каталоге')
  .option('--force', 'записать новые версии всех экранов')
  .option('-c, --concurrency <n>', '', (v) => Number(v))
  .option('--headed')
  .action(async (products: string[], o) => {
    const { ws, log } = ctx();
    const r = await runRefresh(ws, {
      env: o.env,
      products: products.length ? products : undefined,
      discover: o.discover,
      tag: o.tag === false ? false : undefined,
      prune: o.prune,
      commit: o.commit ? true : undefined,
      push: o.push ? true : undefined,
      force: o.force,
      concurrency: o.concurrency,
      headed: o.headed,
      log,
    });
    for (const n of r.capture.run.notes) log.warn(n);
    printStats(log, r.capture.run.stats);
    log.info(`разделов из обхода: ${r.discovered} · автотегов: ${r.tagged} · на проверку: ${r.flagged.length}${r.commit ? ` · коммит ${r.commit}` : ''}`);
    log.dim(`галерея: ${path.relative(ws.root, r.gallery)}`);
    if (r.capture.run.stats.failed) process.exitCode = 2;
  });

program
  .command('tag')
  .description('Автотеги и privacy-аудит: Claude Code по подписке (headless claude -p) или Claude API')
  .argument('[ids...]', 'id экранов; по умолчанию — все без актуальных тегов')
  .addOption(new Option('--provider <provider>', 'кто размечает').choices(['claude-code', 'api']))
  .option('--all', 'перетегировать всё')
  .option('--limit <n>', '', (v) => Number(v))
  .option('--dry-run', 'показать, что будет размечено')
  .action(async (ids: string[], o) => {
    const { ws, log } = ctx();
    if (o.dryRun) {
      const queue = taggingQueue(Library.open(ws.paths.library), { ids, all: o.all });
      for (const s of queue.slice(0, o.limit ?? queue.length)) log.info(`  ${s.id}`);
      log.dim(`к разметке: ${plural(Math.min(o.limit ?? queue.length, queue.length), ['экран', 'экрана', 'экранов'])}`);
      return;
    }
    const r = await runTagging(ws, { provider: o.provider, ids, all: o.all, limit: o.limit, log });
    if (r.hint) throw new ConfigError(`Разметка не запущена: ${r.hint}`);
    for (const e of r.errors) log.error(e);
    buildGallery(ws, Library.open(ws.paths.library).index);
    log.info(`размечено: ${r.tagged} · на проверку: ${r.flagged.length} · ошибок: ${r.errors.length}`);
    if (r.errors.length) process.exitCode = 1;
  });

program
  .command('list')
  .description('Список экранов библиотеки')
  .argument('[targets...]', '<product>[/<flow>]')
  .option('-p, --platform <platform>')
  .option('--status <status>', 'ok | review | failed | unsafe | orphaned')
  .option('--json')
  .action((targets: string[], o) => {
    const { ws, log } = ctx();
    const library = Library.open(ws.paths.library);
    const { targets: t } = parseTargets(targets);
    const rows = library.index.screens.filter(
      (s) =>
        (!t.length || t.some((x) => (!x.product || x.product === s.product) && (!x.flow || x.flow === s.flow))) &&
        (!o.platform || s.platform === o.platform) &&
        (!o.status || s.status === o.status),
    );
    if (o.json) {
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      return;
    }
    for (const s of rows) {
      const status = s.status === 'ok' ? pc.green(s.status) : pc.yellow(s.status);
      log.info(`${status.padEnd(18)} v${String(s.version).padEnd(3)} ${s.changedAt.slice(0, 10)}  ${s.id}  ${pc.dim(s.files.default.path)}`);
    }
    log.dim(plural(rows.length, ['экран', 'экрана', 'экранов']));
  });

program
  .command('export')
  .description('Файлы для слайдов/Figma: scrn export "сводка KPI" --variant framed --bg blur')
  .argument('<query...>', 'id экранов/секций или поисковый запрос')
  .addOption(new Option('--variant <variant>', 'вариант').choices([...EXPORT_VARIANTS]).default('framed'))
  .option('--bg <background>', 'framed: transparent | white | black | gradient | blur | #hex | путь к картинке', 'gradient')
  .option('--padding <px>', 'отступ, CSS px', (v) => Number(v))
  .option('--radius <px>', 'скругление, CSS px', (v) => Number(v))
  .option('--width <px>', 'итоговая ширина', (v) => Number(v))
  .option('--no-shadow')
  .option('--product <id>')
  .option('-p, --platform <platform>')
  .option('--brief <id>')
  .option('--limit <n>', 'сколько экранов взять по запросу', (v) => Number(v), 3)
  .option('-o, --out <dir>', 'папка (по умолчанию exports/<дата>)')
  .action(async (query: string[], o) => {
    const { ws, log } = ctx();
    const library = Library.open(ws.paths.library);
    const known = new Set([...library.index.screens.map((s) => s.id), ...library.index.screens.flatMap((s) => s.sections.map((x) => x.id))]);
    let ids = query.filter((q) => known.has(q));
    if (!ids.length) {
      const search = new LibrarySearch(library.index, ws.taxonomy);
      ids = search
        .searchScreens(query.join(' '), { product: o.product, platform: o.platform, brief: o.brief }, o.limit)
        .map((h) => h.screen.id);
    }
    if (!ids.length) throw new ConfigError('ничего не найдено — уточни запрос или передай id (scrn list)');
    const outDir = path.resolve(ws.root, o.out ?? path.join('exports', new Date().toISOString().slice(0, 10)));
    const files = await exportScreens(library, {
      ids,
      variant: o.variant as ExportVariant,
      background: o.bg,
      padding: o.padding,
      radius: o.radius,
      width: o.width,
      shadow: o.shadow,
      outDir,
    });
    for (const f of files) log.ok(path.relative(ws.root, f.file));
  });

program
  .command('gallery')
  .description('Собрать library/index.html — галерею в духе Mobbin')
  .option('--open', 'открыть в браузере')
  .action((o) => {
    const { ws, log } = ctx();
    const file = buildGallery(ws, Library.open(ws.paths.library).index);
    log.ok(path.relative(ws.root, file));
    if (o.open) openInBrowser(file);
  });

program
  .command('serve')
  .description('Раздать галерею по http://127.0.0.1:<port>')
  .option('--port <port>', '', (v) => Number(v), 4567)
  .action(async (o) => {
    const { ws, log } = ctx();
    buildGallery(ws, Library.open(ws.paths.library).index);
    await serveLibrary(ws.paths.library, o.port);
    log.ok(`галерея: http://127.0.0.1:${o.port}`);
  });

program
  .command('mcp')
  .description('MCP-сервер (stdio) для Claude Code / Claude Desktop / Cursor')
  .action(async () => {
    const { runMcpServer } = await import('../mcp/server.js');
    const g = program.opts<{ root?: string }>();
    await runMcpServer(g.root);
  });

program
  .command('watch')
  .description('Держать процесс и обновлять базу по расписанию (cron из scrn.config.yaml)')
  .option('--cron <expr>', 'cron-выражение, например "0 7 * * 1"')
  .option('--commit')
  .option('--push')
  .option('--now', 'сразу сделать первый прогон')
  .action(async (o) => {
    const { ws, log } = ctx();
    const expr = o.cron ?? ws.config.schedule.cron;
    const run = async () => {
      try {
        const fresh = loadWorkspace({ root: ws.root });
        const r = await runRefresh(fresh, { commit: o.commit ? true : undefined, push: o.push ? true : undefined, log });
        log.ok(`${new Date().toISOString()} обновление: ${summary(r.capture.run.stats)}`);
      } catch (err) {
        log.error(`обновление упало: ${errorMessage(err)}`);
      }
    };
    const job = new Cron(expr, { protect: true }, run);
    log.info(`Расписание «${expr}», следующий запуск: ${job.nextRun()?.toLocaleString('ru-RU')}`);
    if (o.now) await run();
  });

program
  .command('schedule')
  .description('Установить периодический refresh в launchd (macOS) или crontab (Linux)')
  .argument('<action>', 'install | uninstall | show')
  .option('--cron <expr>')
  .action((action: string, o) => {
    const { ws, log } = ctx();
    if (action === 'install') {
      if (!fs.existsSync(path.join(ws.root, 'dist', 'cli', 'index.js'))) throw new ConfigError('сначала npm run build');
      log.ok(installSchedule(ws.root, o.cron ?? ws.config.schedule.cron));
      log.dim('Сессии SSO живут ограниченное время: если в логе .scrn/schedule.log «сессия истекла» — выполни scrn auth.');
    } else if (action === 'uninstall') {
      log.ok(uninstallSchedule());
    } else {
      log.info(`cron: ${o.cron ?? ws.config.schedule.cron}\nкоманда: ${refreshCommand(ws.root).join(' ')}`);
    }
  });

program
  .command('history')
  .description('Версии экрана из истории git')
  .argument('<id>')
  .action((id: string) => {
    const { ws, log } = ctx();
    const library = Library.open(ws.paths.library);
    const s = library.get(id);
    if (!s) throw new ConfigError(`нет экрана ${id}`);
    const rel = path.relative(ws.root, library.abs(s.files.default.path));
    log.info(`${s.title} — v${s.version}, изменён ${s.changedAt}`);
    for (const h of fileHistory(ws.root, rel)) log.info(`  ${h.commit}  ${h.date.slice(0, 16)}  ${h.subject}   (git show ${h.commit}:${rel} > old.png)`);
  });

program
  .command('schemas', { hidden: true })
  .description('Перегенерировать JSON Schema для автодополнения YAML')
  .action(() => {
    const { ws, log } = ctx();
    for (const f of writeJsonSchemas(ws.root)) log.ok(path.relative(ws.root, f));
  });

program.parseAsync(process.argv).catch((err) => {
  const log = createLogger();
  if (err instanceof ConfigError) log.error(err.message);
  else log.error(err instanceof Error ? (program.opts().verbose ? (err.stack ?? err.message) : err.message) : String(err));
  process.exitCode = 1;
});
