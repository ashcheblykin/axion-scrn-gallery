import fs from 'node:fs';
import sharp, { type OverlayOptions } from 'sharp';
import { roundCorners, roundedRectSvg, size, trimTransparent } from './images.js';

/**
 * Presentation-ready composites built from library files on demand (`scrn export`, MCP export_screen).
 * Nothing here is stored in the library: it is cheap to regenerate and would only bloat LFS.
 */

export type ExportVariant = 'default' | 'clear' | 'cards' | 'framed' | 'layers';

export interface ComposeOptions {
  /** transparent | white | black | gradient | blur | #rrggbb | path to an image */
  background: string;
  /** Space around the screen, device px. */
  padding: number;
  /** Corner radius of the screen, device px. */
  radius: number;
  shadow: boolean;
  /** Final width in px (keeps aspect ratio). */
  width?: number;
}

export const DEFAULT_GRADIENT = ['#0B1020', '#1B2A55', '#3B2B6E'];

function gradientSvg(width: number, height: number, stops = DEFAULT_GRADIENT): Buffer {
  const s = stops.map((c, i) => `<stop offset="${(i / Math.max(1, stops.length - 1)) * 100}%" stop-color="${c}"/>`).join('');
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">${s}</linearGradient>` +
      `<radialGradient id="r" cx="0.8" cy="0.15" r="0.7"><stop offset="0%" stop-color="#6E8BFF" stop-opacity="0.35"/><stop offset="100%" stop-color="#6E8BFF" stop-opacity="0"/></radialGradient></defs>` +
      `<rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#r)"/></svg>`,
  );
}

async function backgroundLayer(bg: string, width: number, height: number, screen: Buffer): Promise<Buffer> {
  const blank = () => sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
  switch (bg) {
    case 'transparent':
      return blank().png().toBuffer();
    case 'white':
      return blank().flatten({ background: '#ffffff' }).png().toBuffer();
    case 'black':
      return blank().flatten({ background: '#000000' }).png().toBuffer();
    case 'gradient':
      return sharp(gradientSvg(width, height)).png().toBuffer();
    case 'blur':
      // The screen itself, enlarged and heavily blurred: the UI "melts" into its own colors.
      return sharp(screen)
        .resize({ width, height, fit: 'cover' })
        .blur(Math.max(30, Math.round(Math.min(width, height) / 25)))
        .modulate({ brightness: 0.9, saturation: 1.2 })
        .png()
        .toBuffer();
    default:
      if (/^#[0-9a-f]{3,8}$/i.test(bg)) return blank().flatten({ background: bg }).png().toBuffer();
      if (fs.existsSync(bg)) return sharp(bg).resize({ width, height, fit: 'cover' }).png().toBuffer();
      throw new Error(`Неизвестный фон: ${bg} (transparent | white | black | gradient | blur | #hex | путь к картинке)`);
  }
}

async function shadowLayer(width: number, height: number, radius: number, pad: number): Promise<Buffer> {
  const sigma = Math.max(8, Math.round(Math.min(width, height) / 60));
  const svg = roundedRectSvg(width + pad * 2, height + pad * 2, radius, pad, 'rgba(0,0,0,0.45)');
  return sharp(svg).blur(sigma).png().toBuffer();
}

/** Screen on a background with padding, rounded corners and a soft shadow. */
export async function composeFramed(screen: Buffer, o: ComposeOptions): Promise<Buffer> {
  const rounded = await roundCorners(screen, o.radius);
  const { width, height } = await size(rounded);
  const W = width + o.padding * 2;
  const H = height + o.padding * 2;
  const layers: OverlayOptions[] = [];
  if (o.shadow && o.padding > 0) {
    const shadow = await shadowLayer(width, height, o.radius, o.padding);
    layers.push({ input: shadow, left: 0, top: Math.round(o.padding * 0.12) });
  }
  layers.push({ input: rounded, left: o.padding, top: o.padding });
  const bg = await backgroundLayer(o.background, W, H, screen);
  let out = sharp(bg).composite(layers).png();
  if (o.width) out = sharp(await out.toBuffer()).resize({ width: o.width }).png();
  return out.toBuffer();
}

/** Transparent content layer (cards only), trimmed and padded — ready to drop on any slide background. */
export async function composeCards(cards: Buffer, padding: number): Promise<Buffer> {
  const trimmed = await trimTransparent(cards);
  if (padding <= 0) return trimmed;
  return sharp(trimmed)
    .extend({ top: padding, bottom: padding, left: padding, right: padding, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

/**
 * Figma-friendly layered SVG: each layer is a separate image, so the background can be hidden,
 * replaced or blurred in Figma while the UI stays crisp. Coordinates are CSS px, images keep Retina pixels.
 */
export async function layeredSvg(layers: { id: string; png: Buffer; hidden?: boolean }[], scale: number): Promise<Buffer> {
  if (!layers.length) throw new Error('нет слоёв');
  const first = await size(layers[0].png);
  const w = Math.round(first.width / scale);
  const h = Math.round(first.height / scale);
  const body = layers
    .map(
      (l) =>
        `<g id="${l.id}"${l.hidden ? ' visibility="hidden"' : ''}><image width="${w}" height="${h}" preserveAspectRatio="none" href="data:image/png;base64,${l.png.toString('base64')}"/></g>`,
    )
    .join('\n');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n${body}\n</svg>\n`);
}

// ---------------------------------------------------------------------------
// Scale and SVG composites
// ---------------------------------------------------------------------------

/** Downscale (or upscale) a raster by a factor — Lanczos, like Figma's export. */
export async function resizePng(png: Buffer, factor: number): Promise<Buffer> {
  if (Math.abs(factor - 1) < 1e-6) return png;
  const { width } = await size(png);
  return sharp(png)
    .resize({ width: Math.max(1, Math.round(width * factor)), kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** A raster wrapped in an SVG sized in CSS px (Retina pixels inside) — pixel-perfect, not editable. */
export async function rasterSvg(png: Buffer, scale: number): Promise<Buffer> {
  const { width, height } = await size(png);
  const w = Math.round((width / scale) * 100) / 100;
  const h = Math.round((height / scale) * 100) / 100;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<image width="${w}" height="${h}" preserveAspectRatio="none" xlink:href="data:image/png;base64,${png.toString('base64')}"/></svg>\n`,
  );
}

const r2 = (n: number) => Math.round(n * 100) / 100;

interface SvgDoc {
  /** Inner markup of the root <svg>. */
  body: string;
  width: number;
  height: number;
  viewBox: [number, number, number, number];
}

export function parseSvg(svg: string): SvgDoc {
  const open = /<svg\b[^>]*>/i.exec(svg);
  const close = svg.lastIndexOf('</svg>');
  if (!open || close < 0) throw new Error('не SVG');
  const tag = open[0];
  const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
  const width = Number(attr('width') ?? 0);
  const height = Number(attr('height') ?? 0);
  const vb = (attr('viewBox') ?? `0 0 ${width} ${height}`).split(/[\s,]+/).map(Number) as [number, number, number, number];
  return { body: svg.slice(open.index + tag.length, close), width: width || vb[2], height: height || vb[3], viewBox: vb };
}

function wrapSvg(width: number, height: number, body: string, viewBox = `0 0 ${r2(width)} ${r2(height)}`): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${r2(width)}" height="${r2(height)}" viewBox="${viewBox}">${body}</svg>\n`,
  );
}

/** Move the viewBox edges in (positive) or out (negative) — cards: stored margin → requested padding. */
export function insetSvg(svg: string, inset: number): Buffer {
  const d = parseSvg(svg);
  const [x, y, w, h] = d.viewBox;
  const zoom = w ? d.width / w : 1; // viewBox in layout px, size in device px (zoomed-out mobile pages)
  const k = Math.min(inset, w / 2 - 1, h / 2 - 1);
  const nw = w - 2 * k;
  const nh = h - 2 * k;
  return wrapSvg(nw * zoom, nh * zoom, d.body, [x + k, y + k, nw, nh].map(r2).join(' '));
}

/** Figma's own drop-shadow filter (maps back to a Drop shadow effect on import). */
function frameShadow(id: string, x: number, y: number, w: number, h: number, dy: number, blur: number, alpha: number): string {
  const pad = blur * 1.5 + Math.abs(dy) + 2;
  return (
    `<filter id="${id}" x="${r2(x - pad)}" y="${r2(y - pad)}" width="${r2(w + pad * 2)}" height="${r2(h + pad * 2)}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">` +
    `<feFlood flood-opacity="0" result="BackgroundImageFix"/>` +
    `<feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>` +
    `<feOffset dy="${r2(dy)}"/><feGaussianBlur stdDeviation="${r2(blur / 2)}"/><feComposite in2="hardAlpha" operator="out"/>` +
    `<feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${alpha} 0"/>` +
    `<feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow"/><feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow" result="shape"/></filter>`
  );
}

export interface FramedSvgOptions {
  background: string;
  /** CSS px */
  padding: number;
  radius: number;
  shadow: boolean;
  /** The raster screen — needed only for background: blur (and image backgrounds). */
  png?: Buffer;
  scale: number;
}

/**
 * The vector screen on a slide background: gradient/solid backgrounds stay vector, the screen keeps editable
 * text, the rounded corners are a mask (Figma imports masks), the shadow is a drop-shadow effect.
 */
export async function framedSvg(inner: string, o: FramedSvgOptions): Promise<Buffer> {
  const d = parseSvg(inner);
  const W = d.width + o.padding * 2;
  const H = d.height + o.padding * 2;
  const [vx, vy, vw] = d.viewBox;
  const zoom = vw ? d.width / vw : 1;
  const defs: string[] = [];
  const layers: string[] = [];
  const bg = o.background;
  if (bg === 'gradient') {
    const stops = DEFAULT_GRADIENT.map((c, i) => `<stop offset="${(i / (DEFAULT_GRADIENT.length - 1)) * 100}%" stop-color="${c}"/>`).join('');
    defs.push(
      `<linearGradient id="frame-bg" x1="0" y1="0" x2="${r2(W)}" y2="${r2(H)}" gradientUnits="userSpaceOnUse">${stops}</linearGradient>`,
      `<radialGradient id="frame-glow" cx="${r2(W * 0.8)}" cy="${r2(H * 0.15)}" r="${r2(Math.max(W, H) * 0.7)}" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#6E8BFF" stop-opacity="0.35"/><stop offset="100%" stop-color="#6E8BFF" stop-opacity="0"/></radialGradient>`,
    );
    layers.push(`<rect id="background" width="${r2(W)}" height="${r2(H)}" fill="url(#frame-bg)"/><rect width="${r2(W)}" height="${r2(H)}" fill="url(#frame-glow)"/>`);
  } else if (bg === 'white' || bg === 'black' || /^#[0-9a-f]{3,8}$/i.test(bg)) {
    layers.push(`<rect id="background" width="${r2(W)}" height="${r2(H)}" fill="${bg === 'white' ? '#FFFFFF' : bg === 'black' ? '#000000' : bg}"/>`);
  } else if (bg !== 'transparent') {
    if (!o.png) throw new Error(`фон ${bg} для SVG строится из растра экрана`);
    const raster = await backgroundLayer(bg, Math.round(W * o.scale), Math.round(H * o.scale), o.png);
    layers.push(`<image id="background" width="${r2(W)}" height="${r2(H)}" preserveAspectRatio="none" xlink:href="data:image/png;base64,${raster.toString('base64')}"/>`);
  }
  const x = o.padding;
  const y = o.padding;
  if (o.shadow && o.padding > 0) {
    const blur = Math.max(8, Math.min(d.width, d.height) / 30);
    defs.push(frameShadow('frame-shadow', x, y, d.width, d.height, o.padding * 0.12, blur, 0.45));
    layers.push(`<rect id="shadow" x="${r2(x)}" y="${r2(y)}" width="${r2(d.width)}" height="${r2(d.height)}" rx="${r2(o.radius)}" fill="#FFFFFF" filter="url(#frame-shadow)"/>`);
  }
  defs.push(`<mask id="frame-mask"><rect x="${r2(x)}" y="${r2(y)}" width="${r2(d.width)}" height="${r2(d.height)}" rx="${r2(o.radius)}" fill="#FFFFFF"/></mask>`);
  const place = Math.abs(zoom - 1) < 1e-6 ? `translate(${r2(x - vx)} ${r2(y - vy)})` : `translate(${r2(x)} ${r2(y)}) scale(${zoom}) translate(${r2(-vx)} ${r2(-vy)})`;
  layers.push(`<g id="screen" mask="url(#frame-mask)"><g transform="${place}">${d.body}</g></g>`);
  return wrapSvg(W, H, `<defs>${defs.join('')}</defs>${layers.join('')}`);
}
