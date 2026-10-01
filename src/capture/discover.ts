import fs from 'node:fs';
import path from 'node:path';
import type { Browser } from 'playwright';
import YAML from 'yaml';
import { z } from 'zod';
import type { Workspace } from '../config/load.js';
import { FlowSchema, type Flow, type Product } from '../config/schema.js';
import { DISCOVERED_FLOW, slugify } from '../core/naming.js';
import { collectLinks } from '../inpage/inspect.js';
import type { Logger } from '../util/log.js';
import { errorMessage } from '../util/pool.js';
import { resolveUrl, waitForNetworkIdle } from './actions.js';
import { contextOptions, resolvePlatform } from './browser.js';
import { authProfile, loadSession, sessionStorageInitScript } from './session.js';

/**
 * "Собрать всё, что плохо лежит": crawl the app navigation and turn every reachable section into a
 * surface screen of a synthetic `_discovered` flow. Curated flows stay the source of truth; this layer
 * makes sure hidden products and new sections still land in the library (and get auto-tagged).
 */

export interface DiscoveredPage {
  url: string;
  route: string;
  text: string;
  depth: number;
}

/** /9/inspectors/38717 → /9/inspectors/:id — one representative per route shape. */
export function routeShape(pathname: string): string {
  return pathname
    .split('/')
    .map((seg, i) => {
      if (!seg) return seg;
      if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(seg) || /^[A-Za-z0-9_-]{20,}$/.test(seg)) return ':id';
      // A leading number is usually an org/tenant id ({org}) and part of every route — keep it.
      if (/^\d+$/.test(seg) && i > 1) return ':id';
      return seg;
    })
    .join('/');
}

function curatedRoutes(product: Product, vars: Record<string, string | number>, baseUrl: string): Set<string> {
  const out = new Set<string>();
  for (const flow of product.flows) {
    for (const step of flow.steps) {
      if (!step.url) continue;
      try {
        const u = new URL(resolveUrl(baseUrl, step.url, vars));
        out.add(routeShape(u.pathname));
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

export async function crawl(
  ws: Workspace,
  browser: Browser,
  product: Product,
  opts: { env: string; log: Logger; maxPages?: number; depth?: number },
): Promise<DiscoveredPage[]> {
  const env = product.environments[opts.env];
  if (!env) return [];
  const vars = { ...product.vars, ...env.vars };
  const session = loadSession(ws.paths.auth, authProfile(product), opts.env);
  if (product.auth.required && !session) {
    opts.log.warn(`${product.id}: нет сессии — scrn auth ${product.id}`);
    return [];
  }
  const maxPages = opts.maxPages ?? product.discover.maxPages;
  const maxDepth = opts.depth ?? product.discover.depth;
  const exclude = product.discover.exclude.map((e) => e.toLowerCase());
  const curated = curatedRoutes(product, vars, env.baseUrl);
  const origin = new URL(env.baseUrl).origin;

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
  const init = sessionStorageInitScript(session);
  if (init) await context.addInitScript(init);
  const page = await context.newPage();

  const seenShapes = new Set<string>();
  const found: DiscoveredPage[] = [];
  const queue: { url: string; depth: number; text: string }[] = [
    { url: resolveUrl(env.baseUrl, product.auth.startUrl, vars), depth: 0, text: '' },
  ];
  try {
    while (queue.length && found.length < maxPages) {
      const item = queue.shift()!;
      try {
        await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: ws.config.capture.navigationTimeoutMs });
        await waitForNetworkIdle(page, ws.config.capture.networkIdleTimeoutMs);
      } catch (err) {
        opts.log.debug(`${product.id}: не открылась ${item.url} — ${errorMessage(err)}`);
        continue;
      }
      const current = new URL(page.url());
      if (current.origin !== origin) continue;
      const shape = routeShape(current.pathname);
      if (!seenShapes.has(shape)) {
        seenShapes.add(shape);
        if (!curated.has(shape) && item.depth > 0) {
          found.push({ url: current.toString(), route: current.pathname + current.search, text: item.text, depth: item.depth });
        }
      }
      if (item.depth >= maxDepth) continue;
      const links = await page.evaluate(collectLinks, product.discover.linkSelectors).catch(() => []);
      for (const link of links) {
        const u = new URL(link.href);
        if (u.origin !== origin) continue;
        const lower = (u.pathname + u.search).toLowerCase();
        if (exclude.some((e) => lower.includes(e))) continue;
        const s = routeShape(u.pathname);
        if (seenShapes.has(s) || queue.some((q) => routeShape(new URL(q.url).pathname) === s)) continue;
        queue.push({ url: u.toString(), depth: item.depth + 1, text: link.text });
      }
    }
  } finally {
    await context.close();
  }
  return found;
}

/** Synthetic flow from crawled pages — validated through the same schema as hand-written flows. */
export function discoveredFlow(pages: DiscoveredPage[], platforms: string[]): Flow | null {
  if (!pages.length) return null;
  const used = new Set<string>();
  const steps = pages.map((p) => {
    let id = slugify(p.route.split('?')[0].replace(/^\//, '').replace(/\//g, '-') || 'home');
    for (let i = 2; used.has(id); i++) id = `${id.replace(/-\d+$/, '')}-${i}`;
    used.add(id);
    return { id, name: p.text || id, url: p.route };
  });
  return FlowSchema.extend({ id: z.literal(DISCOVERED_FLOW) }).parse({
    id: DISCOVERED_FLOW,
    name: 'Все разделы (авто)',
    description: 'Поверхностные экраны всех разделов, найденные обходом навигации.',
    actions: ['Navigating'],
    tags: ['auto'],
    platforms,
    steps,
  });
}

/** Ready-to-promote YAML: copy the interesting steps into curated flows of catalog/products/<id>.yaml. */
export function writeSuggestions(ws: Workspace, product: Product, flow: Flow): string {
  const dir = path.join(ws.paths.catalog, 'discovered');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${product.id}.yaml`);
  const doc = {
    note: `Найдено scrn discover ${new Date().toISOString().slice(0, 10)}. Это подсказка: перенеси нужные шаги в catalog/products/${product.id}.yaml.`,
    steps: flow.steps.map((s) => ({ id: s.id, name: s.name, url: s.url })),
  };
  fs.writeFileSync(file, YAML.stringify(doc));
  return file;
}
