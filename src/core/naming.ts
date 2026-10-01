/**
 * File layout of the library (first layer is human-readable, as agreed with the design team):
 *
 *   library/<product>/<platform>/<flow>/<NN>-<step>[.<theme>][.<locale>].png        ← screen with background
 *   library/<product>/<platform>/<flow>/<NN>-<step>….full.png                         ← whole scrollable page
 *   library/<product>/<platform>/<flow>/<NN>-<step>….clear.png                        ← app background removed
 *   library/<product>/<platform>/<flow>/<NN>-<step>….cards.png                        ← background + chrome removed
 *   library/<product>/<platform>/<flow>/<NN>-<step>….thumb.webp                       ← preview (plain git)
 *   library/<product>/<platform>/<flow>/<NN>-<step>…--<section>.png                   ← isolated element ("плашка")
 *
 * Everything is Retina: desktop @2x, mobile @3x (see scrn.config.yaml → platforms).
 */

export const DEFAULT_THEME = 'default';
export const DISCOVERED_FLOW = '_discovered';

export type Variant = 'default' | 'full' | 'clear' | 'cards' | 'thumb';

export interface ScreenKey {
  product: string;
  platform: string;
  flow: string;
  step: string;
  theme: string;
  locale: string;
  position: number;
}

export function slugify(input: string, max = 60): string {
  const s = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'screen';
}

function suffixes(key: Pick<ScreenKey, 'theme' | 'locale'>, defaultLocale: string): string[] {
  const out: string[] = [];
  if (key.theme && key.theme !== DEFAULT_THEME) out.push(key.theme);
  if (key.locale && key.locale !== defaultLocale) out.push(key.locale);
  return out;
}

export function screenId(key: ScreenKey, defaultLocale: string): string {
  return [key.product, key.platform, key.flow, key.step, ...suffixes(key, defaultLocale)].join('.');
}

export function flowId(product: string, platform: string, flow: string): string {
  return `${product}.${platform}.${flow}`;
}

export function screenDir(key: Pick<ScreenKey, 'product' | 'platform' | 'flow'>): string {
  return `${key.product}/${key.platform}/${key.flow}`;
}

/** Position 0 (discovered screens) has no number: their order changes with the navigation. */
export function screenStem(key: ScreenKey, defaultLocale: string): string {
  const base = key.position > 0 ? `${String(key.position).padStart(2, '0')}-${key.step}` : key.step;
  return [base, ...suffixes(key, defaultLocale)].join('.');
}

export function variantPath(key: ScreenKey, defaultLocale: string, variant: Variant): string {
  const base = `${screenDir(key)}/${screenStem(key, defaultLocale)}`;
  switch (variant) {
    case 'default':
      return `${base}.png`;
    case 'thumb':
      return `${base}.thumb.webp`;
    default:
      return `${base}.${variant}.png`;
  }
}

export function sectionPath(key: ScreenKey, defaultLocale: string, section: string, thumb = false): string {
  const base = `${screenDir(key)}/${screenStem(key, defaultLocale)}--${section}`;
  return thumb ? `${base}.thumb.webp` : `${base}.png`;
}

/** "Gen · Executive summary · 01 KPI overview (desktop, dark).png" — for exports and gallery downloads. */
export function humanFileName(parts: {
  productName: string;
  flowName: string;
  position: number;
  title: string;
  platform: string;
  theme: string;
  locale: string;
  variant?: string;
  ext?: string;
}): string {
  const qualifiers = [parts.platform];
  if (parts.theme !== DEFAULT_THEME) qualifiers.push(parts.theme);
  qualifiers.push(parts.locale);
  if (parts.variant && parts.variant !== 'default') qualifiers.push(parts.variant);
  const nn = String(parts.position).padStart(2, '0');
  const raw = `${parts.productName} · ${parts.flowName} · ${nn} ${parts.title} (${qualifiers.join(', ')}).${parts.ext ?? 'png'}`;
  return raw.replace(/[/\\:*?"<>|]+/g, '-');
}
