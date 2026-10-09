import fs from 'node:fs';
import path from 'node:path';
import { humanFileName } from '../core/naming.js';
import type { ImageFile, LibraryIndex, ScreenRecord, SectionRecord } from '../core/types.js';
import { composeCards, composeFramed, framedSvg, insetSvg, layeredSvg, rasterSvg, resizePng } from '../process/compose.js';
import { size } from '../process/images.js';
import { isLfsPointer, type Library } from './store.js';

export const EXPORT_VARIANTS = ['default', 'full', 'clear', 'cards', 'framed', 'layers'] as const;
export type ExportVariant = (typeof EXPORT_VARIANTS)[number];
export const EXPORT_FORMATS = ['png', 'svg'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
/** vector — editable SVG (text as text); raster — the Retina PNG inside an SVG, pixel-perfect. */
export const SVG_MODES = ['vector', 'raster'] as const;
export type SvgMode = (typeof SVG_MODES)[number];

/** Margin the capture keeps around the cards variant (CSS px) — see runner.ts. */
const CARDS_MARGIN = 16;

export interface RenderOptions {
  variant: ExportVariant;
  format?: ExportFormat;
  svgMode?: SvgMode;
  /** PNG: multiple of the CSS size (1 = 1440 px wide desktop, 2 = Retina). Default — the captured scale. */
  scale?: number;
  /** framed: transparent | white | black | gradient | blur | #hex | image path */
  background?: string;
  /** CSS px */
  padding?: number;
  radius?: number;
  shadow?: boolean;
  /** Final width in px (PNG; overrides scale). */
  width?: number;
}

export interface ExportRequest extends RenderOptions {
  /** Screen ids or section ids (`<screenId>--<section>`). */
  ids: string[];
  outDir: string;
}

export interface RenderedFile {
  id: string;
  /** Human-readable file name. */
  name: string;
  mime: string;
  data: Buffer;
  variant: string;
  format: ExportFormat;
  /** PNG scale actually used. */
  scale?: number;
  width: number;
  height: number;
  /** Why the result differs from the request (no vector yet → raster SVG, scale above the capture → capped). */
  notes: string[];
}

export interface ExportedFile {
  id: string;
  file: string;
  variant: string;
  format: ExportFormat;
  scale?: number;
  notes: string[];
}

function readImage(library: Library, rel: string): Buffer {
  const file = library.abs(rel);
  if (!fs.existsSync(file)) throw new Error(`нет файла ${rel} — пересними экран (scrn capture)`);
  if (isLfsPointer(file)) throw new Error(`${rel} — это LFS-указатель, выполни: git lfs pull`);
  return fs.readFileSync(file);
}

function readSvg(library: Library, f: ImageFile | undefined): string | undefined {
  if (!f) return undefined;
  const file = library.abs(f.path);
  if (!fs.existsSync(file) || isLfsPointer(file)) return undefined;
  return fs.readFileSync(file, 'utf8');
}

export function resolveTarget(index: LibraryIndex, id: string): { screen: ScreenRecord; section?: SectionRecord } {
  const screen = index.screens.find((s) => s.id === id);
  if (screen) return { screen };
  for (const s of index.screens) {
    const section = s.sections.find((x) => x.id === id);
    if (section) return { screen: s, section };
  }
  throw new Error(`экран или секция не найдены: ${id}`);
}

/** Scales a screen can be exported at without inventing pixels: 1…captured (desktop 1–2x, mobile 1–3x). */
export function exportScales(screen: ScreenRecord): number[] {
  return Array.from({ length: Math.max(1, Math.floor(screen.viewport.scale)) }, (_, i) => i + 1);
}

/** One export in memory — shared by `scrn export`, MCP export_screen and the gallery server. */
export async function renderExport(library: Library, id: string, o: RenderOptions): Promise<RenderedFile> {
  const { screen, section } = resolveTarget(library.index, id);
  const productNames = new Map(library.index.products.map((p) => [p.id, p.name]));
  const native = screen.viewport.scale;
  const notes: string[] = [];
  const format: ExportFormat = o.variant === 'layers' ? 'svg' : (o.format ?? 'png');
  const variant = section ? (o.variant === 'framed' ? 'framed' : 'section') : o.variant;
  let scale = o.scale ?? native;
  if (scale > native) {
    notes.push(`снято в @${native}x — больше пикселей взять неоткуда, отдаю @${native}x`);
    scale = native;
  }
  scale = Math.max(0.25, scale);
  const padding = o.padding ?? (variant === 'framed' ? (section ? 48 : 64) : 0);
  const radius = section ? 0 : (o.radius ?? 20);
  const shadow = section ? false : (o.shadow ?? true);
  const background = o.background ?? 'gradient';

  const name = (ext: string, extra: { scale?: number; qualifiers?: string[] } = {}) =>
    humanFileName({
      productName: productNames.get(screen.product) ?? screen.product,
      flowName: screen.flowName,
      position: screen.position,
      title: section ? `${screen.title} — ${section.name}` : screen.title,
      platform: screen.platform,
      theme: screen.theme,
      locale: screen.locale,
      variant,
      ext,
      ...extra,
    });

  // Raster source for the request (section, variant), at the captured scale.
  const sourcePng = async (): Promise<Buffer> => {
    if (section) return readImage(library, section.file.path);
    switch (o.variant) {
      case 'full':
        return readImage(library, (screen.files.full ?? screen.files.default).path);
      case 'clear': {
        if (!screen.files.clear) throw new Error(`${id}: варианта clear нет (включи variants.clear и пересними)`);
        return readImage(library, screen.files.clear.path);
      }
      case 'cards': {
        const f = screen.files.cards ?? screen.files.clear;
        if (!f) throw new Error(`${id}: нет прозрачных вариантов — включи variants.cards в scrn.config.yaml`);
        return composeCards(readImage(library, f.path), Math.round(padding * native));
      }
      default:
        return readImage(library, screen.files.default.path);
    }
  };

  const framedPng = async (png: Buffer) =>
    composeFramed(png, {
      background,
      padding: Math.round(padding * native),
      radius: Math.round(radius * native),
      shadow,
      width: undefined,
    });

  if (format === 'png') {
    if (o.variant === 'layers') throw new Error('layers — это SVG');
    let png = await sourcePng();
    if (variant === 'framed') png = await framedPng(png);
    let used: number | undefined = scale;
    if (o.width) {
      const { width } = await size(png);
      png = await resizePng(png, o.width / width);
      used = undefined;
    } else png = await resizePng(png, scale / native);
    const dims = await size(png);
    return { id, name: name('png', { scale: used }), mime: 'image/png', data: png, variant, format, scale: used, ...dims, notes };
  }

  // SVG
  if (o.variant === 'layers' && !section) {
    const layers = [{ id: 'screen', png: readImage(library, screen.files.default.path) }];
    if (screen.files.clear) layers.push({ id: 'content-no-background', png: readImage(library, screen.files.clear.path) });
    const data = await layeredSvg(layers, native);
    const dims = await size(layers[0].png);
    return { id, name: name('svg'), mime: 'image/svg+xml', data, variant, format, width: Math.round(dims.width / native), height: Math.round(dims.height / native), notes };
  }
  const vectorFile = section
    ? section.svg
    : o.variant === 'full'
      ? (screen.files.fullSvg ?? (screen.files.full ? undefined : screen.files.svg))
      : o.variant === 'clear'
        ? screen.files.clearSvg
        : o.variant === 'cards'
          ? screen.files.cardsSvg
          : screen.files.svg;
  const vector = (o.svgMode ?? 'vector') === 'vector' ? readSvg(library, vectorFile) : undefined;
  if ((o.svgMode ?? 'vector') === 'vector' && !vector) notes.push('векторной версии нет (экран снят до SVG или вектор не удался) — отдаю растр в SVG');

  let data: Buffer;
  if (vector) {
    let svg: string | Buffer = vector;
    if (o.variant === 'cards' && !section) svg = insetSvg(vector, CARDS_MARGIN - padding);
    if (variant === 'framed') {
      svg = await framedSvg(svg.toString(), { background, padding, radius, shadow, png: background === 'blur' || !/^(gradient|white|black|transparent|#)/.test(background) ? await sourcePng() : undefined, scale: native });
    }
    data = Buffer.isBuffer(svg) ? svg : Buffer.from(svg);
  } else {
    let png = await sourcePng();
    if (variant === 'framed') png = await framedPng(png);
    data = await rasterSvg(png, native);
  }
  const head = data.subarray(0, 600).toString();
  const w = Math.round(Number(/\swidth="([\d.]+)"/.exec(head)?.[1] ?? 0));
  const h = Math.round(Number(/\sheight="([\d.]+)"/.exec(head)?.[1] ?? 0));
  return { id, name: name('svg', { qualifiers: vector ? [] : ['raster'] }), mime: 'image/svg+xml', data, variant, format, width: w, height: h, notes };
}

export async function exportScreens(library: Library, req: ExportRequest): Promise<ExportedFile[]> {
  fs.mkdirSync(req.outDir, { recursive: true });
  const out: ExportedFile[] = [];
  for (const id of req.ids) {
    const r = await renderExport(library, id, req);
    const file = path.join(req.outDir, r.name);
    fs.writeFileSync(file, r.data);
    out.push({ id, file, variant: r.variant, format: r.format, scale: r.scale, notes: r.notes });
  }
  return out;
}
