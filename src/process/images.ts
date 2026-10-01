import crypto from 'node:crypto';
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';
import type { Rect } from '../core/types.js';

export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
}

export async function raw(png: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export async function size(img: Buffer): Promise<{ width: number; height: number }> {
  const m = await sharp(img).metadata();
  return { width: m.width ?? 0, height: m.height ?? 0 };
}

/** Lossless, max-compression PNG — keeps LFS storage down. */
export async function optimizePng(png: Buffer): Promise<Buffer> {
  return sharp(png).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
}

export async function thumbnail(img: Buffer, width: number, quality: number): Promise<Buffer> {
  return sharp(img).resize({ width, withoutEnlargement: true }).webp({ quality }).toBuffer();
}

/** Bigger preview for MCP clients / Claude vision (long edge ≤ maxEdge). */
export async function preview(img: Buffer, maxEdge: number, format: 'webp' | 'jpeg' | 'png' = 'webp'): Promise<Buffer> {
  const pipeline = sharp(img).resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });
  if (format === 'jpeg') return pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 82 }).toBuffer();
  if (format === 'png') return pipeline.png().toBuffer();
  return pipeline.webp({ quality: 80 }).toBuffer();
}

export function pixelHash(rawImg: RawImage): string {
  return crypto.createHash('sha256').update(`${rawImg.width}x${rawImg.height}:`).update(rawImg.data).digest('hex');
}

/**
 * Screens must match the device frame exactly (1179×2556 for iPhone 15 Pro, 2880×1800 for desktop):
 * mobile emulation sometimes renders a pixel short. Off-by-a-few is fixed by repeating/cropping edges.
 */
export async function fitExact(png: Buffer, width: number, height: number): Promise<Buffer> {
  const s = await size(png);
  if (s.width === width && s.height === height) return png;
  if (Math.abs(s.width - width) > 3 || Math.abs(s.height - height) > 3) return png;
  let img = sharp(png);
  const right = width - s.width;
  const bottom = height - s.height;
  if (right > 0 || bottom > 0) {
    img = sharp(await img.extend({ right: Math.max(0, right), bottom: Math.max(0, bottom), extendWith: 'copy' }).png().toBuffer());
  }
  return img.extract({ left: 0, top: 0, width, height }).png().toBuffer();
}

/** Cut fully transparent borders (used for the .cards variant). */
export async function trimTransparent(png: Buffer, margin = 0): Promise<Buffer> {
  try {
    return await sharp(png).trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 1, margin }).png().toBuffer();
  } catch {
    return png; // fully transparent or nothing to trim
  }
}

export function roundedRectSvg(width: number, height: number, radius: number, inset = 0, fill = '#fff'): Buffer {
  const w = Math.max(0, width - inset * 2);
  const h = Math.max(0, height - inset * 2);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${inset}" y="${inset}" width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="${fill}"/></svg>`,
  );
}

/** Mask the image to a rounded rectangle (optionally inset, e.g. to skip a transparent padding). */
export async function roundCorners(png: Buffer, radius: number, inset = 0): Promise<Buffer> {
  if (radius <= 0) return png;
  const { width, height } = await size(png);
  return sharp(png)
    .ensureAlpha()
    .composite([{ input: roundedRectSvg(width, height, radius, inset), blend: 'dest-in' }])
    .png()
    .toBuffer();
}

export interface DiffResult {
  ratio: number;
  sameSize: boolean;
  diffPixels: number;
}

function maskRects(img: RawImage, rects: Rect[]) {
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(img.width, Math.ceil(r.x + r.width));
    const y1 = Math.min(img.height, Math.ceil(r.y + r.height));
    for (let y = y0; y < y1; y++) img.data.fill(0, (y * img.width + x0) * 4, (y * img.width + x1) * 4);
  }
}

/** Share of differing pixels between two screens; `ignore` regions (device px) are masked on both. */
export function compare(a: RawImage, b: RawImage, opts: { pixelThreshold: number; ignore?: Rect[] }): DiffResult {
  if (a.width !== b.width || a.height !== b.height) return { ratio: 1, sameSize: false, diffPixels: a.width * a.height };
  if (opts.ignore?.length) {
    a = { ...a, data: Buffer.from(a.data) };
    b = { ...b, data: Buffer.from(b.data) };
    maskRects(a, opts.ignore);
    maskRects(b, opts.ignore);
  }
  const diffPixels = pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: opts.pixelThreshold, includeAA: false });
  return { ratio: diffPixels / (a.width * a.height), sameSize: true, diffPixels };
}
