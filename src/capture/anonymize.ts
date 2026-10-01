import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page, Route } from 'playwright';
import type { Dictionary, NetworkRule, Product } from '../config/schema.js';
import { createDomAnonymizer, type DomAnonConfig } from '../inpage/dom.js';
import { collectVisibleText } from '../inpage/inspect.js';
import { createTextPipeline, type PipelineConfig, type TextPipeline } from '../inpage/pipeline.js';

/**
 * Safe-by-default screens. Three layers, in order:
 *   1. network — JSON API responses are rewritten before the app renders them (covers canvas charts and maps);
 *   2. DOM — text nodes, attributes, inputs, logos/avatars, blur/hide masks (+ MutationObserver while shooting);
 *   3. guard — everything readable on the screen is scanned for real names / client terms / raw PII.
 */

export const ANON_ATTRIBUTES = ['title', 'alt', 'aria-label', 'placeholder', 'data-tooltip', 'data-title', 'data-original-title'];

/** JSON keys whose values drive app logic and must stay untouched by default. */
const DEFAULT_KEEP_KEYS = ['id', 'uuid', 'key', 'slug', 'type', 'status', 'state', 'code', 'kind', 'role', 'icon', 'color', 'url', 'href', 'src', 'path', 'locale', 'lang', 'token', 'hash'];

export function pipelineConfig(dictionary: Dictionary, product?: Product): PipelineConfig {
  return {
    personas: dictionary.personas,
    organizations: dictionary.organizations,
    people: dictionary.people,
    terms: dictionary.terms,
    patterns: dictionary.patterns,
    blocklist: [...dictionary.blocklist, ...(product?.anonymize.blocklist ?? [])],
    emailDomain: dictionary.emailDomain,
  };
}

function fileToDataUri(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const mime =
    ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

export function domConfig(root: string, product: Product): DomAnonConfig {
  const logoFile = path.join(root, 'assets', 'anonymize', 'logo.svg');
  const logoDataUri = fs.existsSync(logoFile)
    ? fileToDataUri(logoFile)
    : 'data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#111"/><path d="M32 14 46 50h-7l-3-8H28l-3 8h-7L32 14Zm0 13-3 9h6l-3-9Z" fill="#fff"/></svg>');
  const keywords = new Set(['logo', 'avatar', 'blur', 'hide']);
  return {
    rules: product.anonymize.rules,
    images: product.anonymize.images.map((r) => {
      if (keywords.has(r.with)) return { selector: r.selector, with: r.with };
      const file = path.resolve(root, r.with);
      if (!fs.existsSync(file)) throw new Error(`${product.id}: anonymize.images → файл не найден: ${r.with}`);
      return { selector: r.selector, with: 'file', dataUri: fileToDataUri(file) };
    }),
    blur: product.anonymize.blur,
    hide: product.anonymize.hide,
    logoDataUri,
    attributes: ANON_ATTRIBUTES,
  };
}

/** Injected into every page of the context before any app script runs. */
export function anonymizerInitScript(pipe: PipelineConfig, dom: DomAnonConfig): string {
  return `(() => {
  const __name = (t) => t;
  const pipe = (${createTextPipeline.toString()})(${JSON.stringify(pipe)});
  window.__scrnPipe = pipe;
  window.__scrnAnon = (${createDomAnonymizer.toString()})(pipe, ${JSON.stringify(dom)});
})();`;
}

// ---------------------------------------------------------------------------
// Network layer
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(target: unknown, patch: Record<string, unknown>): unknown {
  if (!isPlainObject(target)) return patch;
  const out: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(patch)) out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}

export function anonymizeJson(value: unknown, pipe: TextPipeline, keepKeys: Set<string>, key = ''): { value: unknown; n: number } {
  if (typeof value === 'string') {
    const k = key.toLowerCase();
    if (keepKeys.has(k) || /(^|_)id$|Id$|uuid|url$/i.test(key)) return { value, n: 0 };
    // enum-like constants (BALADY_APPROVED, STATUS:1) and URLs/paths are logic, not content
    if (/^[A-Z0-9]+(?:[_.:-][A-Z0-9]+)+$/.test(value) || /^(https?:|\/|data:)/i.test(value)) return { value, n: 0 };
    const { out, n } = pipe.text(value);
    return { value: out, n };
  }
  if (Array.isArray(value)) {
    let n = 0;
    const arr = value.map((v) => {
      const r = anonymizeJson(v, pipe, keepKeys, key);
      n += r.n;
      return r.value;
    });
    return { value: arr, n };
  }
  if (isPlainObject(value)) {
    let n = 0;
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = anonymizeJson(v, pipe, keepKeys, k);
      n += r.n;
      obj[k] = r.value;
    }
    return { value: obj, n };
  }
  return { value, n: 0 };
}

export interface NetworkStats {
  responses: number;
  replacements: number;
}

/** Playwright-style URL glob → RegExp: `**` any chars, `*` any chars except "/", `{a,b}` alternatives. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else if (c === '{') re += '(';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += c.replace(/[.+?^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Every rule whose glob matches the URL is applied, in YAML order: block → canned JSON → merge/anonymize.
 * (Playwright alone would run only one handler per request, so overlapping rules would silently shadow each other.)
 */
async function handleRoute(route: Route, rules: NetworkRule[], pipe: TextPipeline, stats: NetworkStats): Promise<void> {
  const url = route.request().url();
  const matching = rules.filter((r) => globToRegExp(r.url).test(url));
  if (!matching.length) return route.fallback();
  if (matching.some((r) => r.block)) return route.abort();
  const canned = matching.find((r) => r.json !== undefined);
  if (canned) {
    stats.responses++;
    return route.fulfill({ json: canned.json });
  }
  let response;
  try {
    response = await route.fetch();
  } catch {
    return route.continue().catch(() => undefined);
  }
  const type = response.headers()['content-type'] ?? '';
  if (!/json/i.test(type)) return route.fulfill({ response });
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return route.fulfill({ response });
  }
  for (const rule of matching) {
    if (rule.merge) data = deepMerge(data, rule.merge);
    if (rule.anonymize) {
      const keep = new Set([...DEFAULT_KEEP_KEYS, ...(rule.keepKeys ?? [])].map((k) => k.toLowerCase()));
      const r = anonymizeJson(data, pipe, keep);
      data = r.value;
      stats.replacements += r.n;
    }
  }
  stats.responses++;
  return route.fulfill({ response, json: data });
}

export async function installNetworkLayer(
  context: BrowserContext,
  product: Product,
  pipe: TextPipeline,
): Promise<NetworkStats> {
  const stats: NetworkStats = { responses: 0, replacements: 0 };
  for (const pattern of product.capture.blockRequests) await context.route(pattern, (r) => r.abort());
  const rules = product.anonymize.network;
  for (const pattern of new Set(rules.map((r) => r.url))) {
    await context.route(pattern, (route) => handleRoute(route, rules, pipe, stats));
  }
  return stats;
}

// ---------------------------------------------------------------------------
// DOM layer + guard
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __scrnPipe?: TextPipeline;
    __scrnAnon?: ReturnType<typeof createDomAnonymizer>;
  }
}

export async function anonymizeDom(
  page: Page,
  nodePipe: TextPipeline,
  observe: boolean,
): Promise<{ replacements: number; images: number }> {
  const known = [...nodePipe.generated];
  return page.evaluate(
    ({ known, observe }) => {
      const anon = window.__scrnAnon;
      const pipe = window.__scrnPipe;
      if (!anon || !pipe) throw new Error('анонимайзер не внедрён в страницу');
      for (const v of known) pipe.generated.add(v);
      const stats = anon.apply();
      if (observe) anon.observe();
      return stats;
    },
    { known, observe },
  );
}

export async function stopObserving(page: Page): Promise<void> {
  await page.evaluate(() => window.__scrnAnon?.disconnect()).catch(() => undefined);
}

export async function guardPage(page: Page, nodePipe: TextPipeline): Promise<string[]> {
  const [text, pageGenerated] = await Promise.all([
    page.evaluate(collectVisibleText),
    page.evaluate(() => [...(window.__scrnPipe?.generated ?? [])]),
  ]);
  return nodePipe.scan(text, pageGenerated);
}

export function createNodePipeline(dictionary: Dictionary, product?: Product): TextPipeline {
  return createTextPipeline(pipelineConfig(dictionary, product));
}
