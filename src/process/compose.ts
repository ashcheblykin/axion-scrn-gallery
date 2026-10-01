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
