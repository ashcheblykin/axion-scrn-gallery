import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import sharp from 'sharp';
import type { Box, VectorPrepareArgs, VectorRenderArgs, VectorResult } from '../inpage/vector.js';
import { injectStyle, removeStyle } from './stabilize.js';

/**
 * Editable SVG of a screen, its clear/cards variants or a section — see src/inpage/vector.ts for what happens in
 * the page. Here: the bundle, raster patches cut from an isolated screenshot, images the page could not fetch,
 * and the guard (an SVG carries text and attributes, not only pixels).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = path.join(ROOT, 'src', 'inpage', 'vector.ts');
export const VECTOR_BUNDLE = path.join(ROOT, 'dist', 'inpage', 'vector.iife.js');

/** dom-to-svg + the glue as one IIFE (also used by `npm run build`, which writes it to dist/). */
export async function buildVectorBundle(write = false): Promise<string> {
  const { build } = await import('esbuild');
  const r = await build({
    entryPoints: [SOURCE],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    minify: true,
    legalComments: 'none',
    write: false,
    logLevel: 'silent',
  });
  const code = r.outputFiles[0].text;
  if (write) {
    fs.mkdirSync(path.dirname(VECTOR_BUNDLE), { recursive: true });
    fs.writeFileSync(VECTOR_BUNDLE, code);
  }
  return code;
}

let bundle: Promise<string> | undefined;

function vectorBundle(): Promise<string> {
  bundle ??= (async () => {
    const built = fs.existsSync(VECTOR_BUNDLE);
    const stale = built && fs.existsSync(SOURCE) && fs.statSync(SOURCE).mtimeMs > fs.statSync(VECTOR_BUNDLE).mtimeMs;
    if (built && !stale) return fs.readFileSync(VECTOR_BUNDLE, 'utf8');
    try {
      return await buildVectorBundle(); // dev / tests / sources newer than dist
    } catch (err) {
      if (built) return fs.readFileSync(VECTOR_BUNDLE, 'utf8');
      throw new Error(`нет ${path.relative(ROOT, VECTOR_BUNDLE)} — выполни npm run build (${err instanceof Error ? err.message : String(err)})`);
    }
  })();
  return bundle;
}

async function ensureBundle(page: Page): Promise<void> {
  if (await page.evaluate(() => !!window.__scrnVector).catch(() => false)) return;
  // page.evaluate of the source text, not addScriptTag: works under a strict Content-Security-Policy.
  await page.evaluate(await vectorBundle());
}

const PATCH_CSS = `
html, body { background: transparent !important; background-image: none !important; }
body * { visibility: hidden !important; }
[data-scrn-patch], [data-scrn-patch] * { visibility: visible !important; }
`;

export type VectorVariant = 'default' | 'clear' | 'cards';

export interface VectorOptions {
  /** Device scale of the page (patch pixels). */
  scale: number;
  root?: string;
  nth?: number;
  area?: Box;
  backdrop?: string[];
  chrome?: string[];
  variants?: VectorVariant[];
  /** Region the cards PNG kept after trimming, in its own (device) pixels. */
  cardsBoxDevice?: Box;
  fill?: string;
  /** Violations in the SVG text and attributes (real names, client terms, raw PII). */
  guard?: (text: string) => string[];
  maxBytes?: number;
}

export interface VectorCapture {
  svg: Partial<Record<VectorVariant, string>>;
  width: number;
  height: number;
  warnings: string[];
  violations: string[];
}

/**
 * Everything an SVG lets a reader see or copy: text, layer names (ids) and links — not geometry (path data and
 * coordinates are long digit runs that would look like phone numbers), not embedded files.
 */
export function svgReadableText(svg: string): string {
  const noData = svg.replace(/data:[a-z]+\/[a-z0-9.+-]+(?:;[a-z0-9=-]+)*,[^"')\s]+/gi, ' ');
  const attrs = [...noData.matchAll(/\s(?:id|href|xlink:href|title|aria-label)="([^"]*)"/g)].map((m) => m[1]);
  const text = noData.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ');
  const decode = (s: string) =>
    s
      .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;|&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  return decode(`${text}\n${attrs.join('\n')}`).replace(/[ \t]+/g, ' ');
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** `ratio` — screenshot pixels per layout px (devicePixelRatio × visual zoom). */
async function cutPatches(page: Page, patches: { id: string; x: number; y: number; width: number; height: number }[], ratio: number) {
  const out: Record<string, string> = {};
  if (!patches.length) return out;
  await injectStyle(page, 'scrn-vector-patch', PATCH_CSS);
  let shot: Buffer;
  try {
    shot = await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide', scale: 'device', omitBackground: true });
  } finally {
    await removeStyle(page, 'scrn-vector-patch');
  }
  const meta = await sharp(shot).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  for (const p of patches) {
    const left = Math.max(0, Math.round(p.x * ratio));
    const top = Math.max(0, Math.round(p.y * ratio));
    const width = Math.min(W - left, Math.round(p.width * ratio));
    const height = Math.min(H - top, Math.round(p.height * ratio));
    if (width <= 0 || height <= 0) continue; // outside the viewport — nothing to cut
    const png = await sharp(shot).extract({ left, top, width, height }).png({ compressionLevel: 9 }).toBuffer();
    out[p.id] = `data:image/png;base64,${png.toString('base64')}`;
  }
  return out;
}

/** Images the page could not fetch (no CORS) — Node has the session cookies and no CORS. */
async function inlineFromNode(page: Page, svg: Partial<Record<VectorVariant, string>>, urls: string[], warnings: string[]) {
  for (const url of urls) {
    let data: string | undefined;
    try {
      const res = await page.context().request.get(url, { timeout: 15_000 });
      if (res.ok()) {
        const body = await res.body();
        const type = (res.headers()['content-type'] ?? '').split(';')[0].trim();
        const png = type === 'image/svg+xml' || /\.svg(\?|$)/i.test(url) ? await sharp(body, { density: 144 }).png().toBuffer() : undefined;
        data = png ? `data:image/png;base64,${png.toString('base64')}` : `data:${type || 'image/png'};base64,${body.toString('base64')}`;
      }
    } catch {
      /* unreachable — dropped below */
    }
    if (!data) warnings.push(`картинка не встроена: ${new URL(url).pathname}`);
    for (const k of Object.keys(svg) as VectorVariant[]) {
      const v = svg[k];
      if (!v) continue;
      const attr = `xlink:href="${xmlEscape(url)}"`;
      svg[k] = data ? v.split(attr).join(`xlink:href="${data}"`) : v.split(attr).join('xlink:href=""');
    }
  }
}

export async function captureVector(page: Page, o: VectorOptions): Promise<VectorCapture> {
  await ensureBundle(page);
  try {
    const prepareArgs: VectorPrepareArgs = { root: o.root, nth: o.nth, area: o.area, backdrop: o.backdrop, chrome: o.chrome };
    const prep = await page.evaluate((a) => window.__scrnVector!.prepare(a), prepareArgs);
    const patches = await cutPatches(page, prep.patches, prep.ratio || o.scale);
    const renderArgs: VectorRenderArgs = { patches, variants: o.variants ?? ['default'], cardsBoxDevice: o.cardsBoxDevice, fill: o.fill };
    const r: VectorResult = await page.evaluate((a) => window.__scrnVector!.render(a), renderArgs);
    const svg: Partial<Record<VectorVariant, string>> = { default: r.default, clear: r.clear, cards: r.cards };
    for (const k of Object.keys(svg) as VectorVariant[]) if (!svg[k]) delete svg[k];
    const warnings = [...r.warnings];
    if (r.unresolved.length) await inlineFromNode(page, svg, r.unresolved, warnings);

    const max = o.maxBytes ?? 40 * 1024 * 1024;
    for (const k of Object.keys(svg) as VectorVariant[]) {
      if ((svg[k]?.length ?? 0) > max) {
        warnings.push(`svg ${k}: больше ${Math.round(max / 1048576)} МБ — пропущен`);
        delete svg[k];
      }
    }
    const violations = o.guard ? [...new Set(Object.values(svg).flatMap((v) => o.guard!(svgReadableText(v ?? ''))))] : [];
    return { svg: violations.length ? {} : svg, width: r.width, height: r.height, warnings, violations };
  } finally {
    await page.evaluate(() => window.__scrnVector?.cleanup()).catch(() => undefined);
  }
}
