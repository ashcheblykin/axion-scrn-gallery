import fs from 'node:fs';
import path from 'node:path';
import type { Browser } from 'playwright';
import YAML from 'yaml';
import { z } from 'zod';
import type { Workspace } from '../config/load.js';
import { FlowSchema, type Action, type Flow, type Product } from '../config/schema.js';
import { AUTO_FLOW_RE, isAutoFlow, slugify } from '../core/naming.js';
import { explorePage, type ExploreArgs, type ExploreResult } from '../inpage/explore.js';
import { Library } from '../library/store.js';
import type { Logger } from '../util/log.js';
import { errorMessage } from '../util/pool.js';
import { resolveUrl, waitForNetworkIdle } from './actions.js';
import { anonymizerInitScript, createNodePipeline, domConfig, installNetworkLayer, pipelineConfig } from './anonymize.js';
import { contextOptions, resolvePlatform } from './browser.js';
import { authProfile, loadSession, sessionStorageInitScript } from './session.js';

/**
 * "Собрать всё, что плохо лежит": walk the app like a person would and turn what it finds into Mobbin-like
 * flows, one per section of the navigation:
 *   - every nav link, including items of collapsed groups ("Planning ▸") and menu items without href;
 *   - section pages found deeper (depth 2–3): detail pages behind table links and clickable rows;
 *   - states without their own URL: every tab, filter/column panels.
 * Curated flows stay the source of truth: their routes are not repeated, but the states around them are.
 * Nothing destructive is ever clicked (see DANGER), and everything is read through the same anonymization as the
 * capture itself — names in flows and in catalog/discovered/*.yaml are already safe.
 */

/** Never clicked, whatever the element. */
export const DANGER =
  'delete|remove|archive|approve|reject|decline|submit|send|save|confirm|publish|apply|log ?out|sign ?out|export|download|print|share|invite|reset|clear|cancel|close|pay|purchase|buy|order|start|stop|run|execute|deploy|activate|deactivate|disable|enable|block|ban|escalate|assign|upload|import|sync|refresh|удал|архив|одобр|отклон|отправ|сохран|подтверд|примен|опубл|выйти|выход|экспорт|скача|печат|подели|пригла|сброс|очист|отмен|закры|оплат|купи|заказ|запуст|останов|выполн|активир|деактив|отключ|включ|блок|эскал|назнач|загруз|импорт|синхрон|обнов|حذف|إرسال|حفظ|تأكيد|رفض|موافقة|خروج|تصدير|تنزيل|إلغاء|رفع';

/** Buttons that open a panel worth a screen of its own. */
export const PANELS =
  '^(?:all |more |advanced )?(?:filters?|фильтры?|все фильтры|columns?|столбцы|колонки|view|вид|display|отображение|sort(?:ing)?|сортировка|customi[sz]e|настроить(?: вид| столбцы)?|layers|слои|legend|легенда|تصفية|فلتر|الفلاتر)$';

const EXCLUDE_HREF = /logout|signout|sign-out|log-out|delete|remove|destroy|\/export|download/i;

export type DiscoveredKind = 'page' | 'detail' | 'tab' | 'panel' | 'row';

export interface DiscoveredStep {
  /** Path + query to open. */
  route: string;
  /** Route template the step stands for (/inspectors/:id) — gives stable step ids whatever record is opened. */
  template?: string;
  name: string;
  kind: DiscoveredKind;
  /** How to reach a state from the opened route (tab click, panel button…). */
  actions: Action[];
  section: string;
  sectionName: string;
}

export interface CrawlResult {
  steps: DiscoveredStep[];
  visited: number;
  notes: string[];
}

/** /9/inspectors/38717 → /9/inspectors/:id — one representative per route shape. */
export function routeShape(pathname: string): string {
  return pathname
    .split('/')
    .map((seg, i) => {
      if (!seg) return seg;
      if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(seg) || /^[A-Za-z0-9_-]{20,}$/.test(seg)) return ':id';
      // INS-00123, ab12cd34ef — ids with digits; route names rarely carry three digits in a row
      if (/^[A-Za-z]{0,6}[-_]?\d{3,}$/.test(seg) || /^(?=.*\d)[A-Za-z0-9_-]{10,}$/.test(seg)) return ':id';
      // A leading number is usually an org/tenant id ({org}) and part of every route — keep it.
      if (/^\d+$/.test(seg) && i > 1) return ':id';
      return seg;
    })
    .join('/');
}

/** Shape + meaningful query: ?tab=map stays (a different screen), ?id=38717 / ?page=2 collapse. */
export function routeKey(url: URL): string {
  const params = [...url.searchParams.entries()]
    .filter(([k]) => !/^(utm_|_|ts$|t$|cache)/i.test(k))
    .map(([k, v]) => `${k}=${/^\d+$/.test(v) || v.length > 24 || /^[0-9a-f-]{16,}$/i.test(v) ? ':v' : v.toLowerCase()}`)
    .sort();
  return routeShape(url.pathname) + (params.length ? `?${params.join('&')}` : '');
}

function curatedKeys(ws: Workspace, products: Product[], vars: Record<string, string | number>, baseUrl: string): Set<string> {
  const out = new Set<string>();
  for (const flow of products.flatMap((p) => p.flows)) {
    for (const step of flow.steps) {
      if (!step.url) continue;
      try {
        out.add(routeKey(new URL(resolveUrl(baseUrl, step.url, vars))));
      } catch {
        /* ignore */
      }
    }
  }
  // Screens curated flows reach by clicks (dashboard → first dashboard) are known from the library.
  try {
    const ids = new Set(products.map((p) => p.id));
    for (const s of Library.open(ws.paths.library).index.screens) {
      if (ids.has(s.product) && !isAutoFlow(s.flow) && s.route && s.source === 'web') out.add(routeKey(new URL(s.route, baseUrl)));
    }
  } catch {
    /* no library yet */
  }
  return out;
}

/** Playwright role selector for a tab/button by its visible name; counters ("Violations 12") become a prefix match. */
export function roleSelector(role: string, name: string): string {
  const n = name.replace(/\s+/g, ' ').trim();
  const stable = n.replace(/\s*[\d٠-٩][\d٠-٩.,\s]*$/, '').trim();
  if (stable && stable !== n) {
    const re = stable.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    return `role=${role}[name=/^${re}/]`;
  }
  return `role=${role}[name=${JSON.stringify(n)}s]`;
}

const firstSegment = (pathname: string) => pathname.split('/').filter((s) => s && !/^\d+$/.test(s))[0] ?? '';

export async function crawl(
  ws: Workspace,
  browser: Browser,
  product: Product,
  /** siblings — other products served by the same app (C&C and Sense): their curated routes are not repeated either. */
  opts: { env: string; log: Logger; maxPages?: number; depth?: number; siblings?: Product[] },
): Promise<CrawlResult> {
  const env = product.environments[opts.env];
  const notes: string[] = [];
  if (!env) return { steps: [], visited: 0, notes };
  const vars = { ...product.vars, ...env.vars };
  const session = loadSession(ws.paths.auth, authProfile(product), opts.env);
  if (product.auth.required && !session) {
    opts.log.warn(`${product.id}: нет сессии — scrn auth ${product.id}`);
    return { steps: [], visited: 0, notes };
  }
  const d = product.discover;
  const maxPages = opts.maxPages ?? d.maxPages;
  const maxDepth = opts.depth ?? d.depth;
  const exclude = d.exclude.map((e) => e.toLowerCase());
  const curated = curatedKeys(ws, [product, ...(opts.siblings ?? [])], vars, env.baseUrl);
  const origin = new URL(env.baseUrl).origin;
  const idle = Math.min(ws.config.capture.networkIdleTimeoutMs, 5000);

  const context = await browser.newContext(
    contextOptions({
      config: ws.config,
      product,
      platform: resolvePlatform(ws.config, 'desktop' in ws.config.platforms ? 'desktop' : Object.keys(ws.config.platforms)[0]),
      theme: product.themes[0],
      locale: product.locales[0],
      storageState: session?.storageState,
    }),
  );
  context.setDefaultTimeout(ws.config.capture.actionTimeoutMs);
  await context.addInitScript('globalThis.__name = globalThis.__name || ((t) => t);');
  const init = sessionStorageInitScript(session);
  if (init) await context.addInitScript(init);
  // The crawl sees what the capture sees: names it stores (flows, suggestions YAML) are already anonymized.
  await context.addInitScript(anonymizerInitScript(pipelineConfig(ws.dictionary, product), await domConfig(ws.root, product)));
  await installNetworkLayer(context, product, createNodePipeline(ws.dictionary, product));
  const page = await context.newPage();

  const args = (mode: ExploreArgs['mode']): ExploreArgs => ({
    mode,
    nav: d.navSelectors,
    danger: DANGER,
    panels: PANELS,
    limits: { tabs: d.maxTabs, panels: 2, links: 300 },
  });
  const explore = async (mode: ExploreArgs['mode']): Promise<ExploreResult> => {
    // Anonymize first: every name the crawler keeps is read from an already safe DOM.
    await page.evaluate(() => (window as unknown as { __scrnAnon?: { apply(): void } }).__scrnAnon?.apply()).catch(() => undefined);
    return page.evaluate(explorePage, args(mode));
  };

  const loaders = product.capture.waitForHidden;
  const settle = async () => {
    await waitForNetworkIdle(page, idle);
    if (loaders.length) {
      // One bounded wait for all loaders together — a spinner that never stops must not cost seconds per selector.
      await page
        .waitForFunction(
          (sels) =>
            !sels.some((sel) => {
              try {
                return Array.from(document.querySelectorAll(sel)).some((e) => (e as HTMLElement).offsetParent !== null || e.getClientRects().length > 0);
              } catch {
                return false;
              }
            }),
          loaders,
          { timeout: 2500, polling: 100 },
        )
        .catch(() => undefined);
    }
    await page.waitForTimeout(250);
  };
  const open = async (url: string): Promise<boolean> => {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: ws.config.capture.navigationTimeoutMs });
      await settle();
      return new URL(page.url()).origin === origin;
    } catch (err) {
      opts.log.debug(`${product.id}: не открылась ${url} — ${errorMessage(err)}`);
      return false;
    }
  };
  const allowed = (u: URL) => {
    const lower = (u.pathname + u.search).toLowerCase();
    return u.origin === origin && !EXCLUDE_HREF.test(lower) && !exclude.some((e) => lower.includes(e));
  };

  interface Item {
    url: string;
    key: string;
    depth: number;
    name: string;
    section: string;
    sectionName: string;
    kind: DiscoveredKind;
  }
  const steps: DiscoveredStep[] = [];
  const queued = new Set<string>();
  const queue: Item[] = [];
  const sectionsBySegment = new Map<string, { section: string; sectionName: string }>();
  let visited = 0;
  let states = 0;

  const enqueue = (href: string, item: Omit<Item, 'url' | 'key'>, key?: string) => {
    let u: URL;
    try {
      u = new URL(href);
    } catch {
      return;
    }
    if (!allowed(u)) return;
    key ??= routeKey(u);
    if (queued.has(key)) return;
    queued.add(key);
    queue.push({ ...item, url: u.toString(), key });
  };
  const route = (u: string) => {
    const x = new URL(u);
    return x.pathname + x.search;
  };
  const sectionFor = (text: string, group: string | undefined, href: string) => {
    const name = (group || text || firstSegment(new URL(href).pathname) || 'Раздел').trim();
    return { section: slugify(name, 40), sectionName: name };
  };
  /** Nav links are sections: always depth 1, wherever the crawler found them. */
  const addNavLinks = (links: { href: string; text: string; group?: string }[]) => {
    for (const l of links) {
      const s = sectionFor(l.text, l.group, l.href);
      const seg = firstSegment(new URL(l.href).pathname);
      if (seg && !sectionsBySegment.has(seg)) sectionsBySegment.set(seg, s);
      enqueue(l.href, { depth: 1, name: l.text || s.sectionName, kind: 'page', ...s });
    }
  };
  const back = async (url: string) => {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => undefined);
    if (page.url() !== url) await open(url);
    else await settle();
  };

  /**
   * Collapsed groups first — their items may not exist in the DOM until opened. A group opened once is not
   * clicked again on later pages (the nav is the same; links of hidden groups are read without opening).
   */
  const opened = new Set<string>();
  const expandNav = async (force = false) => {
    const now = new Set<string>();
    for (let round = 0; round < 4; round++) {
      const r = await explore('expanders');
      const todo = r.expanders.filter((x) => !now.has(x.text) && (force || !opened.has(x.text)));
      if (!todo.length) break;
      for (const x of todo) {
        opened.add(x.text);
        now.add(x.text);
        const before = page.url();
        await page
          .locator(`[data-scrn-x="${x.mark}"]`)
          .click({ timeout: 3000 })
          .catch(() => undefined);
        await page.waitForTimeout(250);
        if (page.url() !== before) {
          // The group header itself navigates: that page is a section too.
          addNavLinks([{ href: page.url(), text: x.text, group: x.text }]);
          await back(before);
        }
      }
    }
  };

  /** Menu items with a click handler instead of href: click, note where they lead, come back. */
  const clickThroughNav = async (here: string, known: Set<string>) => {
    const first = await explore('nav');
    for (const c of first.clickables.slice(0, 30)) {
      if (known.has(c.text)) continue;
      known.add(c.text);
      let r = await explore('nav');
      if (!r.clickables.some((x) => x.text === c.text)) {
        await expandNav(true); // after coming back the group it sits in may be collapsed again
        r = await explore('nav');
      }
      const el = r.clickables.find((x) => x.text === c.text);
      if (!el) continue;
      await page
        .locator(`[data-scrn-c="${el.mark}"]`)
        .click({ timeout: 3000 })
        .catch(() => undefined);
      await settle();
      if (page.url() !== here && new URL(page.url()).origin === origin) {
        addNavLinks([{ href: page.url(), text: c.text, group: c.group }]);
        await back(here);
      }
    }
  };

  const addState = (item: Item, kind: DiscoveredKind, name: string, actions: Action[]) => {
    if (states >= d.maxStates) return;
    states++;
    steps.push({ route: route(item.url), template: item.key, name: `${item.name} · ${name}`, kind, actions, section: item.section, sectionName: item.sectionName });
  };

  /** Tabs, panels and clickable rows of the page the crawler is on. */
  const exploreStates = async (item: Item) => {
    const here = page.url();
    const c = await explore('content');
    for (const t of c.tabs.filter((x) => !x.selected)) addState(item, 'tab', t.name, [{ kind: 'click', arg: roleSelector('tab', t.name) }]);
    for (const p of c.panels) {
      await page
        .locator(`[data-scrn-p="${p.mark}"]`)
        .click({ timeout: 3000 })
        .catch(() => undefined);
      await page.waitForTimeout(400);
      const after = await explore('content');
      if (page.url() !== here) {
        enqueue(page.url(), { depth: item.depth + 1, name: p.text, kind: 'page', section: item.section, sectionName: item.sectionName });
        await back(here);
      } else if (after.overlays > c.overlays) {
        addState(item, 'panel', p.text, [{ kind: 'click', arg: roleSelector('button', p.text) }, { kind: 'wait', arg: 400 }]);
        await page.keyboard.press('Escape').catch(() => undefined);
        await page.waitForTimeout(200);
        if ((await explore('content')).overlays > c.overlays) await open(here);
      }
    }
    for (const r of c.rows) {
      const index = await rowIndex();
      await page
        .locator('[data-scrn-r="1"]')
        .click({ timeout: 3000 })
        .catch(() => undefined);
      await settle();
      const after = await explore('content');
      if (page.url() !== here && new URL(page.url()).origin === origin) {
        enqueue(page.url(), { depth: item.depth + 1, name: r.text || 'Карточка', kind: 'detail', section: item.section, sectionName: item.sectionName });
        await back(here);
      } else if (after.overlays > c.overlays) {
        // Index among all rows: stable enough for a list that keeps its order.
        addState(item, 'row', 'карточка', [{ kind: 'click', arg: { selector: 'tbody tr, [role=row]', nth: index } }, { kind: 'wait', arg: 400 }]);
        await open(here);
      }
    }
    // Deeper pages: one representative per route shape (detail pages, sub-sections). Links of one list that
    // differ only in the last segment (/inspectors/i1, /i2, /i3) are one template, whatever the ids look like.
    const parsed = c.links.flatMap((l) => {
      try {
        return [{ ...l, u: new URL(l.href) }];
      } catch {
        return [];
      }
    });
    const siblings = new Map<string, Set<string>>();
    for (const l of parsed) {
      const parts = l.u.pathname.replace(/\/$/, '').split('/');
      const parent = parts.slice(0, -1).join('/');
      siblings.set(parent, (siblings.get(parent) ?? new Set()).add(parts.at(-1) ?? ''));
    }
    let fresh = 0;
    for (const l of parsed) {
      if (item.depth >= maxDepth || fresh >= 4) break;
      const u = l.u;
      const parts = u.pathname.replace(/\/$/, '').split('/');
      const parent = parts.slice(0, -1).join('/');
      const collection = (siblings.get(parent)?.size ?? 0) >= 2 && parts.length > 2;
      const key = collection ? `${routeShape(parent)}/:id` : routeKey(u);
      if (!allowed(u) || queued.has(key)) continue;
      const known = sectionsBySegment.get(firstSegment(u.pathname));
      const sameSection = !known || known.section === item.section;
      enqueue(
        l.href,
        {
          depth: item.depth + 1,
          name: l.text || 'Карточка',
          kind: collection || routeShape(u.pathname).includes(':id') ? 'detail' : 'page',
          ...(sameSection ? { section: item.section, sectionName: item.sectionName } : known!),
        },
        key,
      );
      fresh++;
    }
  };
  const rowIndex = () =>
    page.evaluate(() => Array.from(document.querySelectorAll('tbody tr, [role=row]')).findIndex((r) => r.hasAttribute('data-scrn-r')));

  try {
    const start = resolveUrl(env.baseUrl, product.auth.startUrl, vars);
    if (!(await open(start))) {
      notes.push(`${product.id}: стартовая страница не открылась`);
      return { steps, visited, notes };
    }
    const startUrl = page.url();
    await expandNav();
    addNavLinks((await explore('nav')).links);
    await clickThroughNav(startUrl, new Set<string>());
    // The start page is a section too: the nav item that points to it gives the name, else its heading.
    const startKey = routeKey(new URL(startUrl));
    const i = queue.findIndex((q) => routeKey(new URL(q.url)) === startKey);
    if (i >= 0) queue.unshift(...queue.splice(i, 1));
    else {
      const s = sectionFor((await explore('content')).heading, undefined, startUrl);
      queued.add(startKey);
      queue.unshift({ url: startUrl, key: startKey, depth: 1, name: s.sectionName, kind: 'page', ...s });
    }

    const recorded = new Set<string>();
    while (queue.length && visited < maxPages) {
      const item = queue.shift()!;
      if (item.url !== page.url() && !(await open(item.url))) continue;
      visited++;
      const key = routeKey(new URL(page.url())); // after redirects
      if (!curated.has(key) && !recorded.has(key)) {
        recorded.add(key);
        steps.push({
          route: route(page.url()),
          template: item.key,
          name: item.name,
          kind: item.kind,
          actions: [],
          section: item.section,
          sectionName: item.sectionName,
        });
      }
      // Sub-navigation that appears only inside a section (an active group opens its items).
      if (item.depth <= 1) {
        await expandNav();
        addNavLinks((await explore('nav')).links);
      }
      if (item.depth <= maxDepth) {
        try {
          await exploreStates(item);
        } catch (err) {
          opts.log.debug(`${product.id}: ${item.url} — ${errorMessage(err)}`);
        }
      }
    }
    if (queue.length) notes.push(`${product.id}: обход остановлен на ${visited} страницах (discover.maxPages), в очереди ещё ${queue.length}`);
    if (states >= d.maxStates) notes.push(`${product.id}: достигнут discover.maxStates (${d.maxStates}) — часть вкладок и панелей не снята`);
  } finally {
    await context.close();
  }
  return { steps, visited, notes };
}

const AutoFlowSchema = FlowSchema.extend({ id: z.string().regex(AUTO_FLOW_RE) });

/** One synthetic flow per navigation section — validated through the same schema as hand-written flows. */
export function discoveredFlows(result: CrawlResult, platforms: string[]): Flow[] {
  const bySection = new Map<string, DiscoveredStep[]>();
  for (const s of result.steps) bySection.set(s.section, [...(bySection.get(s.section) ?? []), s]);
  const flows: Flow[] = [];
  const usedFlowIds = new Set<string>();
  for (const [section, list] of bySection) {
    let id = `_${slugify(section, 40)}`;
    for (let i = 2; usedFlowIds.has(id); i++) id = `_${slugify(section, 36)}-${i}`;
    usedFlowIds.add(id);
    const used = new Set<string>();
    const steps = list.map((s) => {
      const shape = (s.template ?? routeShape(s.route.split('?')[0])).split('?')[0];
      const base = slugify(shape.replace(/:id/g, 'id').replace(/^\//, '').replace(/\//g, '-') || 'home', 50);
      const suffix = s.kind === 'tab' || s.kind === 'panel' || s.kind === 'row' ? `-${s.kind}-${slugify(s.name.split(' · ').pop() ?? s.kind, 24)}` : '';
      const query = s.kind === 'page' || s.kind === 'detail' ? slugify(s.route.split('?')[1] ?? '', 20) : '';
      let sid = slugify(`${base}${query && query !== 'screen' ? `-${query}` : ''}${suffix}`, 60);
      for (let i = 2; used.has(sid); i++) sid = `${sid.replace(/-\d+$/, '')}-${i}`;
      used.add(sid);
      return {
        id: sid,
        name: s.name,
        url: s.route,
        actions: s.actions.map((a) => ({ [a.kind]: a.arg })),
        tags: ['auto', s.kind],
      };
    });
    flows.push(
      AutoFlowSchema.parse({
        id,
        name: list[0].sectionName,
        description: `Найдено обходом навигации: страницы раздела, вкладки, панели и карточки.`,
        actions: ['Navigating'],
        tags: ['auto'],
        platforms,
        steps,
      }),
    );
  }
  return flows;
}

export interface ProductDiscovery {
  product: Product;
  flows: Flow[];
  visited: number;
  notes: string[];
}

/** First non-numeric path segments of what a product's catalog opens — its "territory" in a shared app. */
function territory(product: Product, env: string): Set<string> {
  const e = product.environments[env];
  const vars = { ...product.vars, ...(e?.vars ?? {}) };
  const out = new Set<string>();
  const urls = [product.auth.startUrl, ...product.flows.flatMap((f) => f.steps.map((s) => s.url).filter((u): u is string => !!u))];
  for (const u of urls) {
    try {
      const seg = firstSegment(new URL(resolveUrl(e?.baseUrl ?? 'https://x', u, vars)).pathname);
      if (seg) out.add(seg);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Section → product id: the most steps whose first path segment the product's catalog opens; ties — the first product. */
export function assignSections(steps: DiscoveredStep[], members: Product[], env: string): Map<string, string> {
  const territories = new Map(members.map((p) => [p.id, territory(p, env)]));
  const owner = new Map<string, string>();
  for (const section of new Set(steps.map((s) => s.section))) {
    const segs = steps.filter((s) => s.section === section).map((s) => firstSegment(s.route.split('?')[0]));
    let best = members[0].id;
    let score = 0;
    for (const p of members) {
      const n = segs.filter((g) => territories.get(p.id)!.has(g)).length;
      if (n > score) {
        best = p.id;
        score = n;
      }
    }
    owner.set(section, best);
  }
  return owner;
}

/**
 * Discovery for all products. Products served by one app (same origin and session — C&C and Sense) are crawled
 * once; each section flow goes to the product whose catalog routes it shares the most first segments with
 * (ties — the product the crawl started from). No section is captured twice.
 */
export async function discoverProducts(
  ws: Workspace,
  browser: Browser,
  products: Product[],
  /** only — crawl just the apps these products live in (sections are still split among all their products). */
  opts: { env: string; log: Logger; maxPages?: number; depth?: number; platforms?: string[]; only?: string[] },
): Promise<ProductDiscovery[]> {
  const groups = new Map<string, Product[]>();
  for (const p of products) {
    const e = p.environments[opts.env];
    if (!e || (opts.maxPages ?? p.discover.maxPages) <= 0) continue;
    const key = `${new URL(e.baseUrl).origin}|${authProfile(p)}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const out: ProductDiscovery[] = [];
  for (const members of groups.values()) {
    if (opts.only?.length && !members.some((m) => opts.only!.includes(m.id))) continue;
    const [lead, ...siblings] = members;
    const found = await crawl(ws, browser, lead, { ...opts, siblings });
    const owner = assignSections(found.steps, members, opts.env);
    for (const p of members) {
      const steps = found.steps.filter((s) => owner.get(s.section) === p.id);
      const flows = discoveredFlows({ ...found, steps }, opts.platforms ?? p.discover.platforms);
      out.push({ product: p, flows, visited: p === lead ? found.visited : 0, notes: p === lead ? found.notes : [] });
    }
  }
  return out;
}

/** Ready-to-promote YAML: copy the interesting flows or steps into catalog/products/<id>.yaml. */
export function writeSuggestions(ws: Workspace, product: Product, flows: Flow[]): string {
  const dir = path.join(ws.paths.catalog, 'discovered');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${product.id}.yaml`);
  const doc = {
    note: `Найдено scrn discover ${new Date().toISOString().slice(0, 10)}. Это подсказка: перенеси нужные флоу или шаги в catalog/products/${product.id}.yaml (id без «_»).`,
    flows: flows.map((f) => ({
      id: f.id.replace(/^_/, ''),
      name: f.name,
      steps: f.steps.map((s) => ({
        id: s.id,
        name: s.name,
        url: s.url,
        ...(s.actions.length ? { actions: s.actions.map((a) => ({ [a.kind]: a.arg })) } : {}),
      })),
    })),
  };
  fs.writeFileSync(file, YAML.stringify(doc));
  return file;
}

