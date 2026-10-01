import fs from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import type { Workspace } from '../config/load.js';
import type { Action, Flow, LocaleSpec, Product, Step, Theme } from '../config/schema.js';
import { DISCOVERED_FLOW, screenId, type ScreenKey } from '../core/naming.js';
import type { CapturedScreen, Rect, RunRecord, RunStats } from '../core/types.js';
import { inspectPage, measureRects } from '../inpage/inspect.js';
import type { TextPipeline } from '../inpage/pipeline.js';
import { Library, type IngestOutcome } from '../library/store.js';
import { fitExact, roundCorners, size, trimTransparent } from '../process/images.js';
import { ELEMENT_RULES, guessPatterns } from '../tagging/heuristics.js';
import type { Logger } from '../util/log.js';
import { errorMessage, mapPool } from '../util/pool.js';
import { resolveUrl, runAction, runActions, type ActionContext } from './actions.js';
import {
  anonymizeDom,
  anonymizerInitScript,
  createNodePipeline,
  domConfig,
  installNetworkLayer,
  pipelineConfig,
  scanPage,
  stopObserving,
} from './anonymize.js';
import { contextOptions, launchBrowser, resolvePlatform, type ResolvedPlatform } from './browser.js';
import { exportFigmaFrame } from './figma.js';
import { authProfile, isLoggedIn, loadSession, sessionStorageInitScript, type SessionFile } from './session.js';
import { shootCards, shootClear, shootFull, shootSection, shootViewport } from './shoot.js';
import { settle } from './stabilize.js';

export interface Target {
  product?: string;
  flow?: string;
  step?: string;
}

/** CLI targets: `gen`, `gen/executive-summary`, `gen/executive-summary/kpi-overview`, `brief`. */
export function parseTargets(args: string[]): { targets: Target[]; briefOnly: boolean } {
  let briefOnly = false;
  const targets: Target[] = [];
  for (const a of args) {
    if (a === 'brief') {
      briefOnly = true;
      continue;
    }
    const [product, flow, step] = a.split('/').map((s) => s.trim() || undefined);
    targets.push({ product, flow, step });
  }
  return { targets, briefOnly };
}

function matches(targets: Target[], product: string, flow?: string, step?: string): boolean {
  if (!targets.length) return true;
  return targets.some(
    (t) => (!t.product || t.product === product) && (!t.flow || !flow || t.flow === flow) && (!t.step || !step || t.step === step),
  );
}

export interface CaptureOptions {
  targets?: Target[];
  briefOnly?: boolean;
  platforms?: string[];
  themes?: string[];
  locales?: string[];
  env?: string;
  headed?: boolean;
  concurrency?: number;
  force?: boolean;
  dryRun?: boolean;
  includeTodo?: boolean;
  /** Extra synthetic flows (from `scrn discover`). */
  extraFlows?: { product: string; flow: Flow }[];
  /** Skip curated flows (discover-only runs). */
  onlyExtra?: boolean;
  /** Mark screens that disappeared from the catalog as orphaned (full refresh only). */
  markOrphans?: boolean;
  browser?: Browser;
  log: Logger;
}

export type StepOutcome = IngestOutcome | 'failed' | 'unsafe' | 'auth_required' | 'skipped' | 'dry-run';

export interface StepResult {
  id: string;
  product: string;
  platform: string;
  flow: string;
  step: string;
  outcome: StepOutcome;
  ratio?: number;
  version?: number;
  message?: string;
}

export interface RunResult {
  run: RunRecord;
  results: StepResult[];
}

interface PlannedStep {
  step: Step;
  position: number;
  capture: boolean;
}

interface Job {
  product: Product;
  env: string;
  baseUrl: string;
  vars: Record<string, string | number>;
  platform: ResolvedPlatform;
  theme: Theme;
  locale: LocaleSpec;
  flow: Flow;
  steps: PlannedStep[];
  defaultLocale: string;
}

/** Platform overrides from `on: { mobile: {...} }`; null if the step does not exist on this platform. */
export function resolveStep(step: Step, platform: string): Step | null {
  if (step.platforms && !step.platforms.includes(platform)) return null;
  const o = step.on[platform];
  if (o?.enabled === false) return null;
  if (!o) return step;
  return {
    ...step,
    url: o.url ?? step.url,
    actions: o.actions ?? step.actions,
    sections: o.sections ?? step.sections,
    viewport: o.viewport ?? step.viewport,
  };
}

export function planJobs(ws: Workspace, opts: Omit<CaptureOptions, 'log'>): { jobs: Job[]; notes: string[] } {
  const jobs: Job[] = [];
  const notes: string[] = [];
  const targets = opts.targets ?? [];
  const envName = opts.env ?? ws.config.environment;

  for (const product of ws.products) {
    if (!matches(targets, product.id)) continue;
    const env = product.environments[envName];
    if (!env) {
      notes.push(`${product.id}: нет окружения "${envName}" — пропущен`);
      continue;
    }
    const vars = { ...product.vars, ...env.vars };
    const flows: Flow[] = [
      ...(opts.onlyExtra ? [] : product.flows),
      ...(opts.extraFlows ?? []).filter((x) => x.product === product.id).map((x) => x.flow),
    ];
    for (const platformName of product.platforms) {
      if (opts.platforms?.length && !opts.platforms.includes(platformName)) continue;
      const platform = resolvePlatform(ws.config, platformName);
      for (const theme of product.themes) {
        if (opts.themes?.length && !opts.themes.includes(theme.id)) continue;
        for (const locale of product.locales) {
          if (opts.locales?.length && !opts.locales.includes(locale.id)) continue;
          for (const flow of flows) {
            if (!flow.enabled) continue;
            if (flow.todo && !opts.includeTodo) {
              if (theme === product.themes[0] && locale === product.locales[0] && platformName === product.platforms[0]) {
                notes.push(`${product.id}/${flow.id}: TODO — ${flow.todo}`);
              }
              continue;
            }
            if (flow.platforms && !flow.platforms.includes(platformName)) continue;
            if (opts.briefOnly && !flow.brief) continue;
            if (!matches(targets, product.id, flow.id)) continue;

            const resolved = flow.steps
              .map((s) => resolveStep(s, platformName))
              .filter((s): s is Step => !!s && s.enabled && (!s.todo || !!opts.includeTodo));
            const planned = resolved.map((step, i) => ({
              step,
              position: i + 1,
              capture: matches(targets, product.id, flow.id, step.id),
            }));
            const last = planned.map((p) => p.capture).lastIndexOf(true);
            if (last < 0) continue;
            jobs.push({
              product,
              env: envName,
              baseUrl: env.baseUrl,
              vars,
              platform,
              theme,
              locale,
              flow,
              steps: planned.slice(0, last + 1),
              defaultLocale: product.locales[0]?.id ?? 'en',
            });
          }
        }
      }
    }
  }
  return { jobs, notes };
}

export function keyFor(job: Job, ps: PlannedStep): ScreenKey {
  return {
    product: job.product.id,
    platform: job.platform.name,
    flow: job.flow.id,
    step: ps.step.id,
    theme: job.theme.id,
    locale: job.locale.id,
    position: job.flow.id === DISCOVERED_FLOW ? 0 : ps.position,
  };
}

/** All screen ids the catalog currently describes (for orphan detection). */
export function expectedIds(ws: Workspace, env?: string): Set<string> {
  const { jobs } = planJobs(ws, { env });
  const ids = new Set<string>();
  for (const job of jobs) for (const ps of job.steps) ids.add(screenId(keyFor(job, ps), job.defaultLocale));
  return ids;
}

export interface SessionCheck {
  ok: boolean;
  session?: SessionFile;
  reason?: string;
}

function checkSession(ws: Workspace, browser: Browser, job: Job): Promise<SessionCheck> {
  return verifySession(ws, browser, job.product, job.env);
}

/** Open the start page with the saved session and make sure the app does not bounce to a login form. */
export async function verifySession(ws: Workspace, browser: Browser, product: Product, envName: string): Promise<SessionCheck> {
  const env = product.environments[envName];
  if (!env) return { ok: false, reason: `нет окружения ${envName}` };
  const job = { env: envName, baseUrl: env.baseUrl, vars: { ...product.vars, ...env.vars } };
  const profile = authProfile(product);
  const session = loadSession(ws.paths.auth, profile, job.env);
  if (!product.auth.required) return { ok: true, session };
  if (!session) return { ok: false, reason: `нет сессии ${profile}-${job.env} → выполни: scrn auth ${product.id}` };
  const context = await browser.newContext({
    ...contextOptions({
      config: ws.config,
      product,
      platform: resolvePlatform(ws.config, Object.keys(ws.config.platforms)[0]),
      theme: product.themes[0],
      locale: product.locales[0],
      storageState: session.storageState,
    }),
  });
  try {
    const init = sessionStorageInitScript(session);
    if (init) await context.addInitScript(init);
    const page = await context.newPage();
    await page.goto(resolveUrl(job.baseUrl, product.auth.startUrl, job.vars), {
      waitUntil: 'domcontentloaded',
      timeout: ws.config.capture.navigationTimeoutMs,
    });
    await page.waitForLoadState('networkidle', { timeout: ws.config.capture.networkIdleTimeoutMs }).catch(() => undefined);
    const ok = await isLoggedIn(page, product);
    return ok ? { ok, session } : { ok, reason: `сессия ${profile}-${job.env} истекла → выполни: scrn auth ${product.id}` };
  } catch (err) {
    return { ok: false, reason: `стенд недоступен (${job.baseUrl}): ${errorMessage(err)}` };
  } finally {
    await context.close();
  }
}

function emptyStats(): RunStats {
  return { captured: 0, added: 0, changed: 0, unchanged: 0, failed: 0, unsafe: 0, skipped: 0 };
}

function redact(text: string, violations: string[]): string {
  let out = text;
  for (const v of violations) {
    const term = v.includes(': ') ? v.split(': ').slice(1).join(': ') : v;
    if (term.length < 2) continue;
    out = out.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'), '█'.repeat(Math.min(term.length, 8)));
  }
  return out;
}

export async function runCapture(ws: Workspace, opts: CaptureOptions): Promise<RunResult> {
  const { log } = opts;
  const startedAt = new Date();
  const runId = startedAt.toISOString().replace(/[:.]/g, '-');
  const { jobs, notes } = planJobs(ws, opts);
  const stats = emptyStats();
  const results: StepResult[] = [];
  const library = Library.open(ws.paths.library);
  const cfg = ws.config;
  const guardMode = cfg.anonymize.guard;

  for (const n of notes) log.dim(n);
  if (!jobs.length) log.warn('Нечего снимать: проверь фильтры и каталог (scrn doctor).');

  const browser = opts.browser ?? (await launchBrowser(cfg, { headed: opts.headed }));
  const sessionChecks = new Map<string, Promise<SessionCheck>>();
  const failuresDir = path.join(ws.paths.state, 'failures', runId);
  const quarantineDir = path.join(ws.paths.state, 'quarantine');

  const record = (r: StepResult) => {
    results.push(r);
    const label = `${r.product}/${r.platform}/${r.flow}/${r.step}`;
    switch (r.outcome) {
      case 'added':
        stats.added++;
        stats.captured++;
        log.ok(`${label}  новый v${r.version}`);
        break;
      case 'changed':
        stats.changed++;
        stats.captured++;
        log.ok(`${label}  изменился (Δ ${((r.ratio ?? 1) * 100).toFixed(2)}%) → v${r.version}`);
        break;
      case 'unchanged':
        stats.unchanged++;
        stats.captured++;
        log.dim(`= ${label}  без изменений (v${r.version})`);
        break;
      case 'dry-run':
        stats.captured++;
        log.ok(`${label}  dry-run → ${r.message}`);
        break;
      case 'unsafe':
        stats.unsafe++;
        log.warn(`${label}  НЕ опубликован, найдены данные: ${r.message}`);
        break;
      case 'failed':
        stats.failed++;
        log.error(`${label}  ошибка: ${r.message}`);
        break;
      case 'auth_required':
      case 'skipped':
        stats.skipped++;
        break;
    }
  };

  const runJob = async (job: Job) => {
    const profileKey = `${authProfile(job.product)}-${job.env}`;
    if (!sessionChecks.has(profileKey)) sessionChecks.set(profileKey, checkSession(ws, browser, job));
    const check = await sessionChecks.get(profileKey)!;
    if (!check.ok) {
      for (const ps of job.steps.filter((s) => s.capture)) {
        record({
          id: screenId(keyFor(job, ps), job.defaultLocale),
          product: job.product.id,
          platform: job.platform.name,
          flow: job.flow.id,
          step: ps.step.id,
          outcome: 'auth_required',
          message: check.reason,
        });
      }
      return;
    }

    const nodePipe = createNodePipeline(ws.dictionary, job.product);
    const context = await browser.newContext(
      contextOptions({
        config: cfg,
        product: job.product,
        platform: job.platform,
        theme: job.theme,
        locale: job.locale,
        storageState: check.session?.storageState,
      }),
    );
    context.setDefaultTimeout(cfg.capture.actionTimeoutMs);
    context.setDefaultNavigationTimeout(cfg.capture.navigationTimeoutMs);
    await context.addInitScript('globalThis.__name = globalThis.__name || ((t) => t);');
    const ssInit = sessionStorageInitScript(check.session);
    if (ssInit) await context.addInitScript(ssInit);
    const storage = { ...job.theme.localStorage, ...job.locale.localStorage };
    if (Object.keys(storage).length) {
      await context.addInitScript(
        `(() => { try { const s = ${JSON.stringify(storage)}; for (const k in s) localStorage.setItem(k, s[k]); } catch (e) {} })();`,
      );
    }
    if (cfg.capture.freezeTime) await context.clock.setFixedTime(new Date(cfg.capture.freezeTime));
    await context.addInitScript(anonymizerInitScript(pipelineConfig(ws.dictionary, job.product), domConfig(ws.root, job.product)));
    await installNetworkLayer(context, job.product, nodePipe);

    const actx: ActionContext = {
      baseUrl: job.baseUrl,
      vars: job.vars,
      timeoutMs: cfg.capture.actionTimeoutMs,
      navigationTimeoutMs: cfg.capture.navigationTimeoutMs,
      networkIdleTimeoutMs: cfg.capture.networkIdleTimeoutMs,
    };

    let page = await context.newPage();
    try {
      for (const ps of job.steps) {
        const key = keyFor(job, ps);
        const id = screenId(key, job.defaultLocale);
        const base = { id, product: job.product.id, platform: job.platform.name, flow: job.flow.id, step: ps.step.id };
        let attempt = 0;
        for (;;) {
          try {
            const captured = await runStep(page, job, ps, key, id, nodePipe, actx);
            if (!captured) break;
            if (captured.anonymization.violations.length && guardMode === 'strict') {
              quarantine(quarantineDir, captured);
              record({ ...base, outcome: 'unsafe', message: captured.anonymization.violations.slice(0, 5).join(', ') });
            } else if (opts.dryRun) {
              const out = path.join(ws.paths.state, 'dry-run', `${id}.png`);
              fs.mkdirSync(path.dirname(out), { recursive: true });
              fs.writeFileSync(out, captured.images.default);
              record({ ...base, outcome: 'dry-run', message: path.relative(ws.root, out) });
            } else {
              if (captured.anonymization.violations.length) captured.text = redact(captured.text ?? '', captured.anonymization.violations);
              const res = await library.ingest(captured, {
                force: opts.force,
                threshold: cfg.diff.threshold,
                pixelThreshold: cfg.diff.pixelThreshold,
                thumbWidth: cfg.variants.thumbWidth,
                thumbQuality: cfg.variants.thumbQuality,
                defaultLocale: job.defaultLocale,
              });
              clearQuarantine(quarantineDir, id);
              record({ ...base, outcome: res.outcome, ratio: res.ratio, version: res.record.version });
            }
            break;
          } catch (err) {
            const message = errorMessage(err);
            const reproducible = !!ps.step.url || !!ps.step.figma;
            if (attempt < cfg.capture.retries && reproducible && ps.capture) {
              attempt++;
              log.debug(`${id}: повтор ${attempt} (${message})`);
              await page.close().catch(() => undefined);
              page = await context.newPage();
              continue;
            }
            if (ps.capture) {
              await dumpFailure(page, failuresDir, id, message);
              if (!opts.dryRun) library.markFailed(id, message);
              record({ ...base, outcome: 'failed', message });
            } else {
              log.warn(`${id}: подготовительный шаг упал — ${message}`);
            }
            break;
          }
        }
      }
    } finally {
      await context.close().catch(() => undefined);
    }
  };

  /** Navigate/act for one step and, if it is selected, produce the captured screen. */
  const runStep = async (
    page: Page,
    job: Job,
    ps: PlannedStep,
    key: ScreenKey,
    id: string,
    nodePipe: TextPipeline,
    actx: ActionContext,
  ): Promise<CapturedScreen | null> => {
    const { step } = ps;
    const product = job.product;

    if (step.figma) {
      if (!ps.capture) return null;
      const frame = await exportFigmaFrame(step.figma, job.platform.scale);
      const dims = await size(frame.buffer);
      const scale = step.figma.scale ?? job.platform.scale;
      const violations = guardMode === 'off' ? [] : nodePipe.scan(frame.text);
      return {
        ...screenBase(job, ps, key, id),
        source: 'figma',
        route: `figma:${step.figma.file}/${step.figma.node}`,
        patterns: step.patterns,
        elements: step.elements,
        text: frame.text.slice(0, 2000),
        viewport: { width: Math.round(dims.width / scale), height: Math.round(dims.height / scale), scale },
        overflow: false,
        images: { default: frame.buffer, sections: [] },
        ignoreRects: [],
        anonymization: { replacements: 0, images: 0, violations },
      };
    }

    if (step.url) await runAction(page, { kind: 'goto', arg: step.url } as Action, actx);
    await runActions(page, step.actions, actx);
    const viewportBefore = page.viewportSize();
    if (step.viewport && viewportBefore) {
      await page.setViewportSize({ width: step.viewport.width ?? viewportBefore.width, height: step.viewport.height ?? viewportBefore.height });
    }
    try {
      if (!ps.capture) {
        await runActions(page, step.after, actx);
        return null;
      }
      const warnings = await settle(page, {
        networkIdleTimeoutMs: cfg.capture.networkIdleTimeoutMs,
        timeoutMs: cfg.capture.actionTimeoutMs,
        settleMs: step.delay ?? product.capture.settleMs ?? cfg.capture.settleMs,
        waitFor: [...product.capture.waitFor, ...step.waitFor],
        waitForHidden: product.capture.waitForHidden,
        hide: [...product.capture.hide, ...step.hide],
        css: product.capture.css,
        hideScrollbars: cfg.capture.hideScrollbars,
      });
      for (const w of warnings) opts.log.debug(`${id}: ${w}`);
      for (const ev of [job.theme.evaluate, job.locale.evaluate]) if (ev) await page.evaluate(ev);

      const captured = await captureScreen(page, job, ps, key, id, nodePipe);
      await runActions(page, step.after, actx);
      return captured;
    } finally {
      if (step.viewport && viewportBefore) await page.setViewportSize(viewportBefore);
    }
  };

  const screenBase = (job: Job, ps: PlannedStep, key: ScreenKey, id: string) => ({
    id,
    product: key.product,
    platform: key.platform,
    theme: key.theme,
    locale: key.locale,
    flow: key.flow,
    flowName: job.flow.name,
    step: key.step,
    position: ps.position,
    title: ps.step.name,
    description: ps.step.description,
    brief: job.flow.brief,
    tags: [...job.flow.tags, ...ps.step.tags],
  });

  const captureScreen = async (page: Page, job: Job, ps: PlannedStep, key: ScreenKey, id: string, nodePipe: TextPipeline): Promise<CapturedScreen> => {
    const { step } = ps;
    const product = job.product;
    const anon = await anonymizeDom(page, nodePipe, cfg.anonymize.observeMutations);
    try {
      // Replacements may change text widths — let layout settle.
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
      const { violations, substitutes } = await scanPage(page, nodePipe, guardMode !== 'off');
      const info = await page.evaluate(inspectPage, {
        scrollContainer: product.capture.scrollContainer,
        elementRules: ELEMENT_RULES,
        textLimit: 2000,
      });
      const scale = job.platform.scale;
      const ignore = await page.evaluate(measureRects, [...product.capture.ignoreInDiff, ...step.ignoreInDiff]);
      const ignoreRects: Rect[] = ignore.map((r) => ({ x: r.x * scale, y: r.y * scale, width: r.width * scale, height: r.height * scale }));

      const vpNow = page.viewportSize() ?? { width: job.platform.width, height: job.platform.height };
      const exact = (buf: Buffer) => fitExact(buf, Math.round(vpNow.width * scale), Math.round(vpNow.height * scale));
      const def = await exact(await shootViewport(page));
      const wantFull = step.full ?? info.overflow;
      let full: Buffer | undefined;
      let fullHeight: number | undefined;
      if (cfg.variants.full && wantFull) {
        const shot = await shootFull(page, cfg.capture.maxFullHeight);
        full = shot.buffer;
        fullHeight = shot.height;
      }
      const clear = cfg.variants.clear ? await exact(await shootClear(page, product.capture.backdrop)) : undefined;
      const cards =
        cfg.variants.cards && product.capture.chrome.length
          ? await trimTransparent(await shootCards(page, product.capture.backdrop, product.capture.chrome), Math.round(16 * scale))
          : undefined;

      const sections: CapturedScreen['images']['sections'] = [];
      for (const s of step.sections) {
        try {
          const shot = await shootSection(page, s, { maxHeight: cfg.capture.maxFullHeight, timeoutMs: cfg.capture.actionTimeoutMs, scale });
          const buffer = s.radius !== undefined ? await roundCorners(shot.buffer, shot.radius, shot.padding) : shot.buffer;
          sections.push({ id: s.id, name: s.name, description: s.description, patterns: s.patterns, elements: s.elements, tags: s.tags, buffer });
        } catch (err) {
          opts.log.warn(`${id}: секция "${s.id}" не снята — ${errorMessage(err)}`);
        }
      }

      const vp = page.viewportSize() ?? { width: job.platform.width, height: job.platform.height };
      const url = new URL(page.url());
      const elements = [...new Set([...step.elements, ...info.elements])];
      return {
        ...screenBase(job, ps, key, id),
        source: job.flow.id === DISCOVERED_FLOW ? 'discover' : 'web',
        route: url.pathname + url.search,
        title: job.flow.id === DISCOVERED_FLOW ? discoveredTitle(info.heading, info.title, ps.step.name) : ps.step.name,
        patterns: [...new Set([...step.patterns, ...guessPatterns(info.elements, info.text)])],
        elements,
        text: info.text,
        viewport: { width: vp.width, height: vp.height, scale },
        overflow: info.overflow,
        fullHeight: full ? fullHeight : undefined,
        images: { default: def, full, clear, cards, sections },
        ignoreRects,
        anonymization: { replacements: anon.replacements, images: anon.images, violations, substitutes },
      };
    } finally {
      await stopObserving(page);
    }
  };

  try {
    await mapPool(jobs, opts.concurrency ?? cfg.concurrency, runJob);
  } finally {
    if (!opts.browser) await browser.close().catch(() => undefined);
  }

  const runNotes = [...notes];
  for (const [profile, check] of sessionChecks) {
    const c = await check;
    if (!c.ok && c.reason) runNotes.push(`${profile}: ${c.reason}`);
  }

  if (!opts.dryRun) {
    if (opts.markOrphans) {
      const alive = expectedIds(ws, opts.env);
      for (const r of results) alive.add(r.id);
      const covered = new Set(jobs.map((j) => j.product.id));
      const discovered = new Set((opts.extraFlows ?? []).map((x) => x.product));
      const orphaned = library.markOrphans(alive, covered, discovered);
      if (orphaned.length) runNotes.push(`orphaned (шаг удалён из каталога): ${orphaned.join(', ')}`);
    }
    library.rebuildFlows(ws.products);
  }

  const run: RunRecord = {
    id: runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    environment: opts.env ?? cfg.environment,
    targets: (opts.targets ?? []).map((t) => [t.product, t.flow, t.step].filter(Boolean).join('/')).concat(opts.briefOnly ? ['brief'] : []),
    stats,
    notes: runNotes,
  };
  if (!opts.dryRun) {
    library.addRun(run);
    library.save();
  }
  const reportDir = path.join(ws.paths.state, 'runs');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, `${runId}.json`), JSON.stringify({ run, results }, null, 2));
  return { run, results };
}

function discoveredTitle(heading: string, title: string, fallback: string): string {
  const h = heading.trim();
  if (h && h.length <= 80) return h;
  const t = title.split(/[|·—–-]/)[0]?.trim();
  return t || fallback;
}

function quarantine(dir: string, c: CapturedScreen) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${c.id}.png`), c.images.default);
  fs.writeFileSync(
    path.join(dir, `${c.id}.json`),
    JSON.stringify({ id: c.id, route: c.route, at: new Date().toISOString(), violations: c.anonymization.violations }, null, 2),
  );
}

function clearQuarantine(dir: string, id: string) {
  for (const ext of ['.png', '.json']) {
    const f = path.join(dir, `${id}${ext}`);
    if (fs.existsSync(f)) fs.rmSync(f);
  }
}

async function dumpFailure(page: Page, dir: string, id: string, message: string) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${id}.png`), timeout: 5000 });
    fs.writeFileSync(path.join(dir, `${id}.txt`), `${page.url()}\n${message}\n`);
  } catch {
    // page is gone — nothing to dump
  }
}

