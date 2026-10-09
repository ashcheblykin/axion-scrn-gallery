/**
 * File layout of the library (first layer is human-readable, as agreed with the design team):
 *
 *   library/<product>/<platform>/<flow>/<NN>-<step>[.<theme>][.<locale>].png        ← screen with background
 *   library/<product>/<platform>/<flow>/<NN>-<step>….full.png                         ← whole scrollable page
 *   library/<product>/<platform>/<flow>/<NN>-<step>….clear.png                        ← app background removed
 *   library/<product>/<platform>/<flow>/<NN>-<step>….cards.png                        ← background + chrome removed
 *   library/<product>/<platform>/<flow>/<NN>-<step>….thumb.webp                       ← preview (plain git)
 *   library/<product>/<platform>/<flow>/<NN>-<step>…--<section>.png                   ← isolated element ("плашка")
 *   library/<product>/<platform>/<flow>/<NN>-<step>….svg / .clear.svg / .cards.svg / .full.svg / --<section>.svg
 *                                                                                    ← editable vector versions
 *
 * Everything is Retina: desktop @2x, mobile @3x (see scrn.config.yaml → platforms).
 */

export const DEFAULT_THEME = 'default';
/** Flows built by `scrn discover` start with "_" (curated ids are kebab-case): `_planning`, `_inspectors`. */
export const AUTO_FLOW_RE = /^_[a-z0-9][a-z0-9-]*$/;
export const isAutoFlow = (flow: string): boolean => flow.startsWith('_');

export type Variant = 'default' | 'full' | 'clear' | 'cards' | 'thumb' | 'svg' | 'fullSvg' | 'clearSvg' | 'cardsSvg';

/** Raster variant → its vector twin in ScreenRecord.files. */
export const SVG_VARIANT = { default: 'svg', full: 'fullSvg', clear: 'clearSvg', cards: 'cardsSvg' } as const;

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

/** Position 0 (auto flows) has no number: their order changes with the navigation. */
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
    case 'svg':
      return `${base}.svg`;
    case 'fullSvg':
    case 'clearSvg':
    case 'cardsSvg':
      return `${base}.${variant.slice(0, -3)}.svg`;
    default:
      return `${base}.${variant}.png`;
  }
}

export function sectionPath(key: ScreenKey, defaultLocale: string, section: string, kind: 'png' | 'thumb' | 'svg' | boolean = 'png'): string {
  const base = `${screenDir(key)}/${screenStem(key, defaultLocale)}--${section}`;
  const k = kind === true ? 'thumb' : kind === false ? 'png' : kind;
  return k === 'thumb' ? `${base}.thumb.webp` : k === 'svg' ? `${base}.svg` : `${base}.png`;
}

/**
 * "Gen · Executive summary · 01 KPI overview (desktop, dark)@2x.png" — for exports and gallery downloads.
 * The scale suffix follows Figma: none for 1x, "@2x" for twice the CSS size.
 */
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
  scale?: number;
  qualifiers?: string[];
}): string {
  const qualifiers = [parts.platform];
  if (parts.theme !== DEFAULT_THEME) qualifiers.push(parts.theme);
  qualifiers.push(parts.locale);
  if (parts.variant && parts.variant !== 'default') qualifiers.push(parts.variant);
  qualifiers.push(...(parts.qualifiers ?? []));
  const nn = String(parts.position).padStart(2, '0');
  const at = parts.scale && Math.abs(parts.scale - 1) > 1e-6 ? `@${Math.round(parts.scale * 100) / 100}x` : '';
  const raw = `${parts.productName} · ${parts.flowName} · ${nn} ${parts.title} (${qualifiers.join(', ')})${at}.${parts.ext ?? 'png'}`;
  return raw.replace(/[/\\:*?"<>|]+/g, '-');
}
