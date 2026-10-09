import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page, Route } from 'playwright';
import sharp from 'sharp';
import type { Dictionary, NetworkRule, Product } from '../config/schema.js';
import { AXION_MARK_PATH } from '../core/brand.js';
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

const svgDataUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

/** Used if assets/anonymize/logo.svg is missing. */
const FALLBACK_LOGO = `<svg width="140" height="140" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="${AXION_MARK_PATH}" fill="black"/></svg>`;

const BLACK = /^(?:black|#000(?:0{3})?|#000000ff|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\))$/i;

/** A black-only mark becomes white for dark backgrounds; colored logos stay as they are. */
export function logoOnDark(svg: string): string {
  const colors = [...svg.matchAll(/(?:fill|stroke)\s*[=:]\s*["']?\s*([^"';\s>]+)/gi)].map((m) => m[1]).filter((c) => !/^(?:none|transparent)$/i.test(c));
  if (!colors.length || !colors.every((c) => BLACK.test(c))) return svg;
  return svg.replace(/((?:fill|stroke)\s*[=:]\s*["']?\s*)(black|#000(?:0{3})?|#000000ff|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\))/gi, '$1#FFFFFF');
}

/**
 * The replacement logo, cropped to the mark itself: clear space baked into the file would shrink the mark
 * inside a client-logo slot (28 px in a header → a 13 px icon).
 */
export async function fitLogo(svg: string): Promise<string> {
  try {
    const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
    const vb = /viewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)/i.exec(root);
    const w = Number(/\swidth\s*=\s*["']([\d.]+)/i.exec(root)?.[1] ?? vb?.[3] ?? 0);
    if (!vb || !w) return svg;
    const [x, y, vw, vh] = vb.slice(1).map(Number);
    const target = 512;
    const { data, info } = await sharp(Buffer.from(svg), { density: (72 * target) / w }).png().toBuffer({ resolveWithObject: true });
    const t = await sharp(data).trim({ threshold: 1 }).toBuffer({ resolveWithObject: true });
    const k = vw / info.width;
    const bx = x + -(t.info.trimOffsetLeft ?? 0) * k;
    const by = y + -(t.info.trimOffsetTop ?? 0) * (vh / info.height);
    const bw = t.info.width * k;
    const bh = t.info.height * (vh / info.height);
    if (!(bw > 0 && bh > 0) || (bw >= vw * 0.98 && bh >= vh * 0.98)) return svg;
    const m = Math.max(bw, bh) * 0.06;
    const box = [bx - m, by - m, bw + 2 * m, bh + 2 * m].map((n) => Math.round(n * 100) / 100);
    const height = 24;
    const width = Math.round((height * box[2]) / box[3]);
    return svg
      .replace(/viewBox\s*=\s*["'][^"']*["']/i, `viewBox="${box.join(' ')}"`)
      .replace(/(<svg\b[^>]*?)\swidth\s*=\s*["'][^"']*["']/i, `$1 width="${width}"`)
      .replace(/(<svg\b[^>]*?)\sheight\s*=\s*["'][^"']*["']/i, `$1 height="${height}"`);
  } catch {
    return svg;
  }
}

export interface LogoAssets {
  /** For light backgrounds (as drawn in assets/anonymize/logo.svg). */
  onLight: string;
  /** For dark backgrounds: assets/anonymize/logo-on-dark.svg or the white version of a black mark. */
  onDark: string;
  /** Raw files — part of the anonymization fingerprint. */
  source: string;
}

const logoCache = new Map<string, Promise<LogoAssets>>();

export function logoAssets(root: string): Promise<LogoAssets> {
  const dir = path.join(root, 'assets', 'anonymize');
  const main = path.join(dir, 'logo.svg');
  const dark = path.join(dir, 'logo-on-dark.svg');
  const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined);
  const source = read(main) ?? FALLBACK_LOGO;
  const darkSource = read(dark);
  const key = `${source}\n${darkSource ?? ''}`;
  if (!logoCache.has(key)) {
    logoCache.set(
      key,
      (async () => {
        const light = await fitLogo(source);
        const onDark = darkSource ? await fitLogo(darkSource) : logoOnDark(light);
        return { onLight: svgDataUri(light), onDark: svgDataUri(onDark), source: key };
      })(),
    );
  }
  return logoCache.get(key)!;
}

export async function domConfig(root: string, product: Product): Promise<DomAnonConfig> {
  const logo = await logoAssets(root);
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
    logoDataUri: logo.onLight,
    logoOnDarkDataUri: logo.onDark,
    attributes: ANON_ATTRIBUTES,
  };
}

/** Bump when the engine starts drawing screens differently (anonymization, variants) — forces fresh versions. */
export const ENGINE_VERSION = 2;

/**
 * What the published pixels depend on besides the app itself. A change here must produce new versions even if
 * the pixel diff stays under the threshold (a fixed sidebar label is only a few hundred pixels).
 */
export async function captureFingerprint(root: string, dictionary: Dictionary, product: Product): Promise<string> {
  const logo = await logoAssets(root);
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ v: ENGINE_VERSION, anonymize: product.anonymize, capture: product.capture, dictionary }))
    .update(logo.source)
    .digest('hex')
    .slice(0, 16);
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

/** Fake values the page anonymizer produced — never reported by the guard. */
export async function pageSafeValues(page: Page): Promise<string[]> {
  return page.evaluate(() => [...(window.__scrnPipe?.generated ?? [])]).catch(() => []);
}

export async function stopObserving(page: Page): Promise<void> {
  await page.evaluate(() => window.__scrnAnon?.disconnect()).catch(() => undefined);
}

/**
 * Everything readable on the screen: guard violations (unless the guard is off) and the fake values the
 * anonymizer left on it — the latter go to the privacy audit, which cannot tell a format-preserving fake
 * phone from a real one by looking at pixels.
 */
export async function scanPage(page: Page, nodePipe: TextPipeline, guard: boolean): Promise<{ violations: string[]; substitutes: string[] }> {
  const [text, pageGenerated] = await Promise.all([
    page.evaluate(collectVisibleText),
    page.evaluate(() => [...(window.__scrnPipe?.generated ?? [])]),
  ]);
  const lower = text.toLowerCase();
  const substitutes = [...new Set([...pageGenerated, ...nodePipe.generated])]
    .filter((v) => v.length > 2 && lower.includes(v))
    .sort()
    .slice(0, 150);
  return { violations: guard ? nodePipe.scan(text, pageGenerated) : [], substitutes };
}

export function createNodePipeline(dictionary: Dictionary, product?: Product): TextPipeline {
  return createTextPipeline(pipelineConfig(dictionary, product));
}
