import path from 'node:path';
import type { Workspace } from '../config/load.js';
import type { Flow } from '../config/schema.js';
import { launchBrowser } from '../capture/browser.js';
import { crawl, discoveredFlow, writeSuggestions } from '../capture/discover.js';
import { runCapture, type RunResult } from '../capture/runner.js';
import { buildGallery } from '../gallery/build.js';
import { Library } from '../library/store.js';
import { runTagging } from '../tagging/run.js';
import { commitLibrary, isGitRepo, push, summary } from '../util/git.js';
import { plural, type Logger } from '../util/log.js';
import { errorMessage } from '../util/pool.js';
import { notify } from './schedule.js';

export interface RefreshOptions {
  env?: string;
  products?: string[];
  discover?: boolean;
  tag?: boolean;
  prune?: boolean;
  commit?: boolean;
  push?: boolean;
  force?: boolean;
  headed?: boolean;
  concurrency?: number;
  log: Logger;
}

export interface RefreshResult {
  capture: RunResult;
  discovered: number;
  tagged: number;
  flagged: string[];
  pruned: string[];
  commit?: string;
  gallery: string;
}

/** The periodic job: every curated flow + discovered surface screens → diff → tags → gallery → git. */
export async function runRefresh(ws: Workspace, o: RefreshOptions): Promise<RefreshResult> {
  const env = o.env ?? ws.config.environment;
  const log = o.log;
  const browser = await launchBrowser(ws.config, { headed: o.headed });
  const extraFlows: { product: string; flow: Flow }[] = [];
  let capture: RunResult;
  try {
    if (o.discover !== false) {
      for (const product of ws.products) {
        if (o.products?.length && !o.products.includes(product.id)) continue;
        if (product.discover.maxPages <= 0) continue;
        try {
          const pages = await crawl(ws, browser, product, { env, log });
          const flow = discoveredFlow(pages, ['desktop']);
          if (flow) {
            extraFlows.push({ product: product.id, flow });
            writeSuggestions(ws, product, flow);
            log.dim(`${product.id}: вне каталога — ${plural(pages.length, ['раздел', 'раздела', 'разделов'])}`);
          }
        } catch (err) {
          log.warn(`${product.id}: обход навигации не удался — ${errorMessage(err)}`);
        }
      }
    }
    capture = await runCapture(ws, {
      env,
      targets: o.products?.map((p) => ({ product: p })),
      extraFlows,
      markOrphans: !o.products?.length,
      force: o.force,
      concurrency: o.concurrency,
      browser,
      log,
    });
  } finally {
    await browser.close().catch(() => undefined);
  }

  let library = Library.open(ws.paths.library);
  const pruned = o.prune ? library.prune() : [];
  if (pruned.length) log.info(`Удалено устаревших экранов: ${pruned.length}`);
  library.save();

  let tagged = 0;
  let flagged: string[] = [];
  if (o.tag !== false) {
    // Tagging writes index.json itself (Claude Code works through the MCP server in a separate process).
    const t = await runTagging(ws, { log });
    tagged = t.tagged;
    flagged = t.flagged;
    for (const e of t.errors) log.warn(e);
    if (t.hint) log.dim(`Автотеги пропущены: ${t.hint}.`);
    library = Library.open(ws.paths.library);
  }
  library.rebuildFlows(ws.products);
  library.save();
  const gallery = buildGallery(ws, library.index);

  let commit: string | undefined;
  const doCommit = o.commit ?? ws.config.git.commit;
  if (doCommit && isGitRepo(ws.root)) {
    const message = ws.config.git.message
      .replace('{date}', new Date().toISOString().slice(0, 10))
      .replace('{summary}', summary(capture.run.stats));
    commit = commitLibrary(ws.root, [path.relative(ws.root, ws.paths.library), path.relative(ws.root, path.join(ws.paths.catalog, 'discovered'))], message);
    if (commit) {
      log.ok(`Коммит ${commit}: ${message}`);
      if (o.push ?? ws.config.git.push) push(ws.root);
    } else {
      log.dim('Изменений для коммита нет.');
    }
  }

  const problems = [
    ...capture.run.notes.filter((n) => /сесси|стенд недоступен/.test(n)),
    capture.run.stats.unsafe ? `${capture.run.stats.unsafe} экранов в карантине (.scrn/quarantine)` : '',
    flagged.length ? `${flagged.length} экранов на проверку после privacy-аудита` : '',
  ].filter(Boolean);
  if (problems.length) notify('Axion screens', problems.join('\n'));

  return { capture, discovered: extraFlows.reduce((n, x) => n + x.flow.steps.length, 0), tagged, flagged, pruned, commit, gallery };
}
