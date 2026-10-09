/**
 * In-page vectorizer: the live DOM → an editable SVG (text stays text, cards stay shapes) for Figma, Illustrator
 * and slides. Bundled together with dom-to-svg into dist/inpage/vector.iife.js (see src/capture/vector.ts) and
 * evaluated in the already anonymized page, right after the PNG shots.
 *
 * dom-to-svg draws boxes, borders, linear gradients, text lines, inline SVG and images. What it cannot draw is cut
 * from a screenshot and placed back as raster patches: canvas charts, maps, video, iframes, native widgets,
 * CSS-mask and sprite icons, filters — including the blur of anonymized photos, which must never turn back into
 * the sharp original. The rest is fixed here: box shadows (in Figma's own drop-shadow filter format), placeholders
 * and select values, hidden images, colors (oklch → hex), baselines (tools ignore dominant-baseline), images and
 * fonts inlined, no links, debug attributes or empty groups.
 */
import { elementToSVG } from 'dom-to-svg';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VectorPrepareArgs {
  /** Root element (a section); the whole document by default. */
  root?: string;
  nth?: number;
  /** Capture area, viewport CSS px. Default: the viewport (document) or the root element box. */
  area?: Box;
  /** Own backgrounds removed in the clear and cards variants. */
  backdrop?: string[];
  /** Whole subtrees removed in the cards variant (sidebar, top bar). */
  chrome?: string[];
}

export interface VectorPatch extends Box {
  id: string;
}

export interface VectorRenderArgs {
  /** Patch id → PNG data URI cut from the isolated screenshot. */
  patches: Record<string, string>;
  variants: ('default' | 'clear' | 'cards')[];
  /** Region the cards PNG kept after trimming — in screenshot (device) pixels. */
  cardsBoxDevice?: Box;
  /** Background painted under an isolated section (section.fill). */
  fill?: string;
  /** Budget for embedded @font-face files. */
  maxFontBytes?: number;
}

export interface VectorResult {
  default?: string;
  clear?: string;
  cards?: string;
  width: number;
  height: number;
  /** Image URLs the page could not fetch (CORS) — the engine inlines them from Node. */
  unresolved: string[];
  warnings: string[];
}

interface Shadow {
  dx: number;
  dy: number;
  blur: number;
  spread: number;
  rgba: [number, number, number, number];
}

interface FieldText {
  text: string;
  x: number;
  y: number;
  color: string;
  font: Record<string, string>;
}

interface Session {
  root: Element;
  area: Box;
  tempIds: Element[];
  /** Temporary id → readable layer name for Figma (class or tag of the element). */
  names: Map<string, string>;
  patches: Map<string, Box>;
  shadows: Map<string, Shadow[]>;
  fields: Map<string, FieldText>;
  images: Map<string, { src: string; fit: string; hidden: boolean }>;
  backdrop: Set<string>;
  chrome: Set<string>;
  fills: Map<string, string>;
}

let session: Session | null = null;
let seq = 0;

// ---------------------------------------------------------------------------
// Colors and fonts
// ---------------------------------------------------------------------------

let probe: CanvasRenderingContext2D | null = null;
function ctx2d(): CanvasRenderingContext2D {
  if (!probe) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    probe = c.getContext('2d', { willReadFrequently: true })!;
  }
  return probe;
}

const colorCache = new Map<string, [number, number, number, number] | null>();
/** Any CSS color (rgb, oklch, color(display-p3 …)) → sRGB 0..255 + alpha 0..1. */
function rgba(color: string): [number, number, number, number] | null {
  const c = color.trim();
  if (!c || c === 'none' || c === 'transparent' || c.startsWith('url(') || /^currentcolor$/i.test(c) || c === 'inherit') return null;
  const hit = colorCache.get(c);
  if (hit !== undefined) return hit;
  const p = ctx2d();
  p.clearRect(0, 0, 1, 1);
  p.fillStyle = '#000';
  p.fillStyle = c;
  p.fillRect(0, 0, 1, 1);
  const d = p.getImageData(0, 0, 1, 1).data;
  const out: [number, number, number, number] = [d[0], d[1], d[2], Math.round((d[3] / 255) * 1000) / 1000];
  colorCache.set(c, out);
  return out;
}

const hex = (c: [number, number, number, number]) => '#' + c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

const metricsCache = new Map<string, { ascent: number; descent: number }>();
function fontMetrics(font: string): { ascent: number; descent: number } {
  let m = metricsCache.get(font);
  if (!m) {
    const p = ctx2d();
    p.font = font;
    const t = p.measureText('Hgjy');
    m = { ascent: t.fontBoundingBoxAscent ?? t.actualBoundingBoxAscent, descent: t.fontBoundingBoxDescent ?? t.actualBoundingBoxDescent };
    metricsCache.set(font, m);
  }
  return m;
}

// ---------------------------------------------------------------------------
// prepare: mark what needs post-processing, return raster patch boxes
// ---------------------------------------------------------------------------

// Drawn by the browser itself (no DOM to vectorize) — or, for password fields, dom-to-svg would print the value.
const RASTER_TAGS = new Set(['CANVAS', 'VIDEO', 'IFRAME', 'EMBED', 'OBJECT', 'SELECT']);
const NATIVE_INPUTS = new Set(['checkbox', 'radio', 'range', 'color', 'file', 'date', 'time', 'datetime-local', 'month', 'week', 'password']);
const TEXT_INPUTS = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'number']);

function intersects(r: DOMRect | Box, a: Box): boolean {
  return r.width > 0 && r.height > 0 && r.x < a.x + a.width && r.x + r.width > a.x && r.y < a.y + a.height && r.y + r.height > a.y;
}

/** Few elements, no text: icons, badges, decorative shapes — rasterizing them costs no editable text. */
function leafish(el: Element): boolean {
  return (el.textContent ?? '').trim().length <= 24 && el.querySelectorAll('*').length <= 12;
}

function hasPseudoImage(el: Element, pseudo: '::before' | '::after'): boolean {
  const cs = getComputedStyle(el, pseudo);
  if (!cs.content || cs.content === 'none' || cs.content === 'normal') return false;
  const mask = cs.getPropertyValue('mask-image') || cs.getPropertyValue('-webkit-mask-image');
  return (mask && mask !== 'none') || (cs.backgroundImage && cs.backgroundImage !== 'none') || /url\(/.test(cs.content);
}

function needsRaster(el: Element, cs: CSSStyleDeclaration): boolean {
  if (RASTER_TAGS.has(el.tagName)) return true;
  if (el.tagName === 'INPUT' && NATIVE_INPUTS.has((el as HTMLInputElement).type)) return true;
  if (cs.filter && /blur\(/.test(cs.filter)) return true; // anonymized photos: the blur IS the privacy
  if ((el as HTMLElement).shadowRoot) return true;
  if (el.tagName.toLowerCase() === 'svg' && el.querySelector('use, foreignObject, image')) return true;
  if (!leafish(el)) return false;
  const mask = cs.getPropertyValue('mask-image') || cs.getPropertyValue('-webkit-mask-image');
  if (mask && mask !== 'none') return true;
  if (cs.filter && cs.filter !== 'none') return true;
  if (cs.clipPath && cs.clipPath !== 'none' && !/^inset\(0(px)?\)$/.test(cs.clipPath)) return true;
  if (cs.backgroundImage && /(radial|conic)-gradient|image-set|cross-fade|element\(/.test(cs.backgroundImage)) return true;
  if (cs.transform && cs.transform !== 'none') {
    const m = new DOMMatrixReadOnly(cs.transform);
    if (Math.abs(m.b) > 0.001 || Math.abs(m.c) > 0.001 || Math.abs(m.a - 1) > 0.001 || Math.abs(m.d - 1) > 0.001) return true;
  }
  if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') return true;
  return hasPseudoImage(el, '::before') || hasPseudoImage(el, '::after');
}

/** "rgba(0, 0, 0, 0.1) 0px 4px 12px 0px, …" → outer shadows (inset ones are skipped). */
function parseShadows(value: string): Shadow[] {
  if (!value || value === 'none') return [];
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  const out: Shadow[] = [];
  for (const raw of parts) {
    const p = raw.trim();
    if (!p || /\binset\b/.test(p)) continue;
    const colorMatch = /(?:rgba?|hsla?|oklch|oklab|lab|lch|color|hwb)\([^)]*\)|#[0-9a-f]{3,8}\b|\b[a-z]+\b(?![(\d])/i.exec(p);
    const color = colorMatch ? colorMatch[0] : 'rgba(0,0,0,0.5)';
    const lengths = p
      .replace(color, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((x) => parseFloat(x))
      .filter((x) => !Number.isNaN(x));
    const [dx = 0, dy = 0, blur = 0, spread = 0] = lengths;
    const c = rgba(color);
    if (!c || c[3] === 0) continue;
    out.push({ dx, dy, blur, spread, rgba: c });
  }
  return out;
}

function fontOf(cs: CSSStyleDeclaration): Record<string, string> {
  return {
    'font-family': cs.fontFamily,
    'font-size': cs.fontSize,
    'font-weight': cs.fontWeight,
    'font-style': cs.fontStyle,
    'letter-spacing': cs.letterSpacing === 'normal' ? '' : cs.letterSpacing,
  };
}

function fieldText(el: Element, cs: CSSStyleDeclaration, r: DOMRect): FieldText | null {
  let text = '';
  let color = cs.color;
  if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && TEXT_INPUTS.has((el as HTMLInputElement).type))) {
    const f = el as HTMLInputElement | HTMLTextAreaElement;
    if (el.tagName === 'TEXTAREA' && f.value) text = f.value;
    else if (!f.value && f.placeholder) {
      text = f.placeholder;
      color = getComputedStyle(el, '::placeholder').color || color;
    }
  }
  if (!text) return null;
  const left = r.x + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
  const multiline = el.tagName === 'TEXTAREA';
  const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
  const y = multiline ? r.y + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop) + lineHeight / 2 : r.y + r.height / 2;
  return { text: multiline ? text.split('\n')[0] : text, x: left, y, color, font: fontOf(cs) };
}

function markId(el: Element, s: Session): string {
  if (!el.id) {
    el.id = `scrn-v${++seq}`;
    s.tempIds.push(el);
    const cls = Array.from(el.classList).find((c) => /^[a-z][\w-]{1,40}$/i.test(c) && !/[:[\]]/.test(c));
    s.names.set(el.id, (cls ?? el.tagName.toLowerCase()).toLowerCase());
  }
  return el.id;
}

function matchesAny(el: Element, selectors: string[]): boolean {
  return selectors.some((sel) => {
    try {
      return el.matches(sel);
    } catch {
      return false;
    }
  });
}

function insideAny(el: Element, selectors: string[]): boolean {
  return selectors.some((sel) => {
    try {
      return !!el.closest(sel);
    } catch {
      return false;
    }
  });
}

/**
 * Screenshot pixels per layout px. Usually devicePixelRatio; a mobile page without <meta viewport> is laid out
 * 980 px wide and zoomed out (visualViewport.scale ≈ 0.4) — the SVG must be sized like the device, not the layout.
 */
function zoom(): { ratio: number; visual: number } {
  const visual = window.visualViewport?.scale ?? 1;
  return { ratio: (window.devicePixelRatio || 1) * visual, visual };
}

export function prepare(args: VectorPrepareArgs): { patches: VectorPatch[]; area: Box; ratio: number } {
  cleanup();
  const root = args.root ? document.querySelectorAll(args.root)[args.nth ?? 0] : document.documentElement;
  if (!root) throw new Error(`vector: не найден ${args.root}`);
  const box = root === document.documentElement ? { x: 0, y: 0, width: innerWidth, height: innerHeight } : root.getBoundingClientRect();
  const area = args.area ?? { x: box.x, y: box.y, width: box.width, height: box.height };
  const s: Session = {
    root,
    area,
    tempIds: [],
    names: new Map(),
    patches: new Map(),
    shadows: new Map(),
    fields: new Map(),
    images: new Map(),
    backdrop: new Set(),
    chrome: new Set(),
    fills: new Map(),
  };
  session = s;
  const chrome = (args.chrome ?? []).filter(Boolean);
  const backdrop = (args.backdrop ?? []).filter(Boolean);
  const duplicateIds = new Set<string>();
  const seen = new Set<string>();
  document.querySelectorAll('[id]').forEach((e) => (seen.has(e.id) ? duplicateIds.add(e.id) : seen.add(e.id)));

  const all = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const el of all) {
    if (el.id && duplicateIds.has(el.id)) continue; // cannot be found again in the SVG
    if (chrome.length && insideAny(el, chrome)) s.chrome.add(markId(el, s));
    if (backdrop.length && matchesAny(el, backdrop)) s.backdrop.add(markId(el, s));
    if (el.closest('[data-scrn-patch]')) continue;
    const cs = getComputedStyle(el);
    const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0;
    const r = el.getBoundingClientRect();
    if (el.tagName === 'IMG') {
      const img = el as HTMLImageElement;
      const src = img.getAttribute('src') ?? '';
      s.images.set(markId(el, s), { src: src.startsWith('data:') ? src : img.currentSrc || img.src, fit: cs.objectFit, hidden: !visible });
    }
    if (!visible || !intersects(r, area)) continue;
    if (el !== root && needsRaster(el, cs)) {
      const id = markId(el, s);
      el.setAttribute('data-scrn-patch', id);
      const x = Math.max(area.x, Math.floor(r.x));
      const y = Math.max(area.y, Math.floor(r.y));
      const w = Math.min(area.x + area.width, Math.ceil(r.right)) - x;
      const h = Math.min(area.y + area.height, Math.ceil(r.bottom)) - y;
      if (w > 0 && h > 0) s.patches.set(id, { x, y, width: w, height: h });
      continue;
    }
    const shadows = parseShadows(cs.boxShadow);
    if (shadows.length) s.shadows.set(markId(el, s), shadows);
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
      const f = fieldText(el, cs, r);
      if (f) s.fields.set(markId(el, s), f);
    }
  }
  return { patches: [...s.patches].map(([id, b]) => ({ id, ...b })), area, ratio: zoom().ratio };
}

export function cleanup(): void {
  document.querySelectorAll('[data-scrn-patch]').forEach((e) => e.removeAttribute('data-scrn-patch'));
  if (session) for (const el of session.tempIds) if (el.id.startsWith('scrn-v')) el.removeAttribute('id');
  session = null;
}

// ---------------------------------------------------------------------------
// render: dom-to-svg + fix-ups
// ---------------------------------------------------------------------------

function el<K extends string>(doc: XMLDocument, name: K, attrs: Record<string, string | number> = {}): SVGElement {
  const e = doc.createElementNS(SVG_NS, name) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) if (v !== '' && v !== undefined) e.setAttribute(k, String(v));
  return e;
}

function defsOf(doc: XMLDocument): Element {
  const svg = doc.documentElement;
  let defs = Array.from(svg.children).find((c) => c.localName === 'defs');
  if (!defs) {
    defs = el(doc, 'defs');
    svg.insertBefore(defs, svg.firstChild);
  }
  return defs;
}

/** Background rect dom-to-svg drew for the element (directly in its group, or in its own stacking root layer). */
function backgroundRects(group: Element): Element[] {
  const out: Element[] = [];
  for (const c of Array.from(group.children)) {
    if (c.localName === 'rect' || c.localName === 'line' || (c.localName === 'image' && /^background-image/.test(c.id))) out.push(c);
    if (c.localName === 'pattern' || c.localName === 'linearGradient') out.push(c);
    if (c.localName === 'g' && c.getAttribute('data-stacking-layer') === 'rootBackgroundAndBorders') out.push(...backgroundRects(c));
  }
  return out;
}

const num = (v: number) => String(Math.round(v * 100) / 100);

/** Figma exports drop shadows exactly like this — and maps such filters back to Drop shadow effects on import. */
function shadowFilter(doc: XMLDocument, id: string, rect: Box, shadows: Shadow[]): Element {
  const pad = Math.max(...shadows.map((s) => s.blur * 1.5 + Math.abs(s.spread) + Math.max(Math.abs(s.dx), Math.abs(s.dy)))) + 2;
  const f = el(doc, 'filter', {
    id,
    x: num(rect.x - pad),
    y: num(rect.y - pad),
    width: num(rect.width + pad * 2),
    height: num(rect.height + pad * 2),
    filterUnits: 'userSpaceOnUse',
    'color-interpolation-filters': 'sRGB',
  });
  f.append(el(doc, 'feFlood', { 'flood-opacity': 0, result: 'BackgroundImageFix' }));
  let prev = 'BackgroundImageFix';
  shadows.forEach((s, i) => {
    const name = `effect${i + 1}_dropShadow`;
    f.append(el(doc, 'feColorMatrix', { in: 'SourceAlpha', type: 'matrix', values: '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0', result: 'hardAlpha' }));
    if (s.spread) f.append(el(doc, 'feMorphology', { radius: num(Math.abs(s.spread)), operator: s.spread > 0 ? 'dilate' : 'erode', in: 'SourceAlpha', result: name }));
    f.append(el(doc, 'feOffset', { dx: s.dx ? num(s.dx) : '', dy: s.dy ? num(s.dy) : '' }));
    if (s.blur) f.append(el(doc, 'feGaussianBlur', { stdDeviation: num(s.blur / 2) }));
    f.append(el(doc, 'feComposite', { in2: 'hardAlpha', operator: 'out' }));
    const [r, g, b, a] = s.rgba;
    f.append(el(doc, 'feColorMatrix', { type: 'matrix', values: `0 0 0 0 ${num(r / 255)} 0 0 0 0 ${num(g / 255)} 0 0 0 0 ${num(b / 255)} 0 0 0 ${a} 0` }));
    f.append(el(doc, 'feBlend', { mode: 'normal', in2: prev, result: name }));
    prev = name;
  });
  f.append(el(doc, 'feBlend', { mode: 'normal', in: 'SourceGraphic', in2: prev, result: 'shape' }));
  return f;
}

function rectBox(r: Element): Box {
  return {
    x: parseFloat(r.getAttribute('x') ?? '0'),
    y: parseFloat(r.getAttribute('y') ?? '0'),
    width: parseFloat(r.getAttribute('width') ?? '0'),
    height: parseFloat(r.getAttribute('height') ?? '0'),
  };
}

/** Inline an SVG image as a plain group (Figma does not import nested <svg> or SVG data in <image>). */
function inlineSvgImage(doc: XMLDocument, image: Element, svgText: string, prefix: string): boolean {
  const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const src = parsed.documentElement;
  if (!src || src.localName !== 'svg' || parsed.querySelector('parsererror')) return false;
  // Class-based styling and nested raster images do not survive the merge — such files are rasterized instead.
  if (parsed.querySelector('style, [class], image, foreignObject, use')) return false;
  const vb = (src.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const iw = parseFloat(src.getAttribute('width') ?? '') || vb[2] || 0;
  const ih = parseFloat(src.getAttribute('height') ?? '') || vb[3] || 0;
  const [vx, vy, vw, vh] = vb.length === 4 && vb.every((n) => !Number.isNaN(n)) ? vb : [0, 0, iw, ih];
  if (!vw || !vh) return false;
  const b = rectBox(image);
  const par = image.getAttribute('preserveAspectRatio') ?? 'xMidYMid meet';
  let sx = b.width / vw;
  let sy = b.height / vh;
  let tx = b.x - vx * sx;
  let ty = b.y - vy * sy;
  if (par !== 'none') {
    const s = /slice/.test(par) ? Math.max(sx, sy) : Math.min(sx, sy);
    tx = b.x + (b.width - vw * s) / 2 - vx * s;
    ty = b.y + (b.height - vh * s) / 2 - vy * s;
    sx = sy = s;
  }
  const g = el(doc, 'g', { transform: `matrix(${num(sx)} 0 0 ${num(sy)} ${num(tx)} ${num(ty)})` });
  // Unique ids inside the inlined image, references rewritten.
  const ids = new Map<string, string>();
  src.querySelectorAll('[id]').forEach((n) => {
    const nid = `${prefix}-${n.id}`;
    ids.set(n.id, nid);
    n.id = nid;
  });
  if (ids.size) {
    src.querySelectorAll('*').forEach((n) => {
      for (const a of Array.from(n.attributes)) {
        let v = a.value;
        for (const [o, nn] of ids) v = v.split(`url(#${o})`).join(`url(#${nn})`).replace(new RegExp(`^#${o}$`), `#${nn}`);
        if (v !== a.value) n.setAttributeNS(a.namespaceURI, a.name, v);
      }
    });
  }
  for (const child of Array.from(src.childNodes)) {
    if (child.nodeType === 1 && /^(script|style|title|metadata)$/i.test((child as Element).localName)) continue;
    g.append(doc.importNode(child, true));
  }
  image.replaceWith(g);
  return true;
}

/** An SVG we cannot inline as plain shapes becomes a PNG at the device resolution. */
async function rasterizeSvg(svgText: string, b: Box): Promise<string> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  try {
    await img.decode();
  } catch {
    return img.src;
  }
  // Keep the file's own aspect ratio — the <image> preserveAspectRatio places it like object-fit did.
  const k = Math.max(2, window.devicePixelRatio || 1);
  const iw = img.naturalWidth || b.width;
  const ih = img.naturalHeight || b.height;
  const fit = Math.min(b.width / iw, b.height / ih) || 1;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(iw * fit * k));
  c.height = Math.max(1, Math.round(ih * fit * k));
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

async function fetchAsset(url: string): Promise<Blob | null> {
  try {
    const r = await fetch(url, { credentials: 'include' });
    return r.ok ? await r.blob() : null;
  } catch {
    return null;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function decodeDataSvg(href: string): string | null {
  const m = /^data:image\/svg\+xml(;[^,]*)?,(.*)$/s.exec(href);
  if (!m) return null;
  try {
    return /;base64/.test(m[1] ?? '') ? new TextDecoder().decode(Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0))) : decodeURIComponent(m[2]);
  } catch {
    return null;
  }
}

async function inlineImages(doc: XMLDocument, s: Session, unresolved: Set<string>): Promise<void> {
  const images = Array.from(doc.getElementsByTagNameNS(SVG_NS, 'image'));
  let n = 0;
  await Promise.all(
    images.map(async (image) => {
      const owner = image.id.endsWith('-image') ? s.images.get(image.id.slice(0, -'-image'.length)) : undefined;
      if (owner?.hidden) {
        image.remove();
        return;
      }
      let href = owner?.src || image.getAttribute('xlink:href') || image.getAttributeNS(XLINK_NS, 'href') || image.getAttribute('href') || '';
      image.removeAttribute('xlink:href');
      image.removeAttributeNS(XLINK_NS, 'href');
      if (owner) image.setAttribute('preserveAspectRatio', owner.fit === 'fill' ? 'none' : owner.fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet');
      if (!href) return image.remove();
      if (!href.startsWith('data:')) {
        const blob = await fetchAsset(href);
        if (!blob) {
          unresolved.add(href);
          image.setAttributeNS(XLINK_NS, 'xlink:href', href);
          return;
        }
        if (blob.type === 'image/svg+xml') {
          const text = await blob.text();
          if (inlineSvgImage(doc, image, text, `img${++n}`)) return;
          href = await rasterizeSvg(text, rectBox(image));
        } else href = await blobToDataUrl(blob);
      } else {
        const svgText = decodeDataSvg(href);
        if (svgText !== null) {
          if (inlineSvgImage(doc, image, svgText, `img${++n}`)) return;
          href = await rasterizeSvg(svgText, rectBox(image));
        }
      }
      image.setAttributeNS(XLINK_NS, 'xlink:href', href);
    }),
  );
}

/** @font-face rules (inline and external sheets) of the families the SVG actually uses, files inlined. */
async function fontFaces(used: Set<string>, budget: number, warnings: string[]): Promise<string> {
  const rules: { css: string; base: string }[] = [];
  const visit = (sheet: CSSStyleSheet) => {
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      return; // cross-origin sheet without CORS
    }
    for (const r of Array.from(list)) {
      if (r instanceof CSSFontFaceRule) {
        const family = r.style.getPropertyValue('font-family').replace(/["']/g, '').trim().toLowerCase();
        if (used.has(family)) rules.push({ css: r.cssText, base: sheet.href ?? document.baseURI });
      } else if (r instanceof CSSImportRule && r.styleSheet) visit(r.styleSheet);
      else if ('cssRules' in r) {
        // @media / @supports / @layer blocks
        const inner = r as CSSGroupingRule;
        for (const x of Array.from(inner.cssRules)) if (x instanceof CSSFontFaceRule) {
          const family = x.style.getPropertyValue('font-family').replace(/["']/g, '').trim().toLowerCase();
          if (used.has(family)) rules.push({ css: x.cssText, base: sheet.href ?? document.baseURI });
        }
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) visit(sheet);
  let spent = 0;
  const out: string[] = [];
  for (const rule of rules) {
    let css = rule.css;
    // Prefer one woff2 source per face: smaller and enough for every modern viewer.
    const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)\s*(?:format\(\s*["']?([\w-]+)["']?\s*\))?/g)];
    const pick = urls.find((u) => /woff2/.test(u[2] ?? u[1])) ?? urls[0];
    if (!pick) continue;
    const abs = new URL(pick[1], rule.base).href;
    if (!abs.startsWith('data:')) {
      const blob = await fetchAsset(abs);
      if (!blob) continue;
      if (spent + blob.size > budget) {
        warnings.push(`шрифты: превышен бюджет ${Math.round(budget / 1024)} КБ — часть начертаний не встроена`);
        break;
      }
      spent += blob.size;
      const data = await blobToDataUrl(blob);
      css = css.replace(/src\s*:[^;]+;?/, `src: url("${data}")${pick[2] ? ` format("${pick[2]}")` : ''};`);
    }
    out.push(css);
  }
  return out.join('\n');
}

function normalizeColors(doc: XMLDocument): void {
  const attrs: [string, string][] = [
    ['fill', 'fill-opacity'],
    ['stroke', 'stroke-opacity'],
    ['stop-color', 'stop-opacity'],
    ['flood-color', 'flood-opacity'],
  ];
  doc.querySelectorAll('*').forEach((n) => {
    for (const [a, op] of attrs) {
      const v = n.getAttribute(a);
      if (!v) continue;
      const c = rgba(v);
      if (!c) continue;
      n.setAttribute(a, hex(c));
      if (c[3] < 1) {
        const prev = parseFloat(n.getAttribute(op) ?? '1');
        n.setAttribute(op, num((Number.isNaN(prev) ? 1 : prev) * c[3]));
      }
    }
    const color = n.getAttribute('color');
    const c = color ? rgba(color) : null;
    if (c) n.setAttribute('color', hex(c));
  });
}

/** tspans sit on the line box bottom via dominant-baseline — Figma and Illustrator ignore it, so use the baseline. */
function fixBaselines(doc: XMLDocument): void {
  for (const t of Array.from(doc.getElementsByTagNameNS(SVG_NS, 'text'))) {
    const mode = t.getAttribute('dominant-baseline');
    if (mode !== 'text-after-edge' && mode !== 'central') continue;
    const font = `${t.getAttribute('font-style') ?? 'normal'} ${t.getAttribute('font-weight') ?? '400'} ${t.getAttribute('font-size') ?? '16px'} ${t.getAttribute('font-family') ?? 'sans-serif'}`;
    const m = fontMetrics(font);
    const shift = mode === 'central' ? (m.ascent - m.descent) / 2 : -m.descent;
    const nodes = [t, ...Array.from(t.getElementsByTagNameNS(SVG_NS, 'tspan'))];
    for (const n of nodes) {
      const y = n.getAttribute('y');
      if (y !== null && y !== '') n.setAttribute('y', num(parseFloat(y) + shift));
    }
    t.removeAttribute('dominant-baseline');
  }
}

/** Computed-style values that are SVG defaults anyway — dropping them halves the file. */
const DEFAULTS: Record<string, RegExp> = {
  'font-size-adjust': /^none$/,
  'font-stretch': /^(100%|normal)$/,
  'font-style': /^normal$/,
  'font-variant': /^normal$/,
  direction: /^ltr$/,
  'letter-spacing': /^(normal|0px)$/,
  'word-spacing': /^(normal|0px)$/,
  'text-decoration': /^none\b/,
  'text-anchor': /^start$/,
  'text-rendering': /^auto$/,
  'unicode-bidi': /^(normal|isolate|plaintext)$/,
  'writing-mode': /^horizontal-tb$/,
};

function readableIds(doc: XMLDocument, names: Map<string, string>): void {
  const taken = new Set(Array.from(doc.querySelectorAll('[id]')).map((n) => n.id));
  const counters = new Map<string, number>();
  doc.querySelectorAll('[id^="scrn-v"]').forEach((n) => {
    const base = names.get(n.id);
    if (!base || n.localName !== 'g') return;
    let name = base;
    for (let i = counters.get(base) ?? 1; taken.has(name); i++) {
      name = `${base}-${i}`;
      counters.set(base, i + 1);
    }
    taken.add(name);
    n.id = name;
  });
}

function strip(doc: XMLDocument): void {
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  for (let c = walker.nextNode(); c; c = walker.nextNode()) comments.push(c);
  comments.forEach((c) => c.parentNode?.removeChild(c));
  doc.querySelectorAll('title, desc').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((n) => {
    for (const a of Array.from(n.attributes)) {
      if (a.name.startsWith('data-') || a.name.startsWith('aria-') || a.name === 'role' || a.name === 'class' || a.name === 'tabindex' || a.name === 'user-select') {
        n.removeAttribute(a.name);
      } else if (DEFAULTS[a.name]?.test(a.value) || (a.name === 'color' && (n.localName === 'text' || n.localName === 'tspan'))) {
        n.removeAttribute(a.name);
      }
    }
  });
  // Empty groups (stacking layers, <head>, invisible elements) — repeat until nothing changes.
  for (let changed = true; changed; ) {
    changed = false;
    doc.querySelectorAll('g, a').forEach((g) => {
      if (!g.firstElementChild && !(g.textContent ?? '').trim()) {
        g.remove();
        changed = true;
      }
    });
  }
  const masks = new Set(Array.from(doc.querySelectorAll('[mask]')).map((n) => n.getAttribute('mask')));
  doc.querySelectorAll('mask').forEach((m) => {
    if (!masks.has(`url(#${m.id})`)) m.remove();
  });
}

/** viewBox in layout px; width/height in the device's CSS px (they differ only on zoomed-out mobile pages). */
function setViewBox(doc: XMLDocument, b: Box, visual = 1): void {
  const svg = doc.documentElement;
  svg.setAttribute('viewBox', [b.x, b.y, b.width, b.height].map(num).join(' '));
  svg.setAttribute('width', num(b.width * visual));
  svg.setAttribute('height', num(b.height * visual));
}

function cloneDoc(doc: XMLDocument): XMLDocument {
  const copy = document.implementation.createDocument(SVG_NS, 'svg', null);
  copy.replaceChild(copy.importNode(doc.documentElement, true), copy.documentElement);
  return copy;
}

export async function render(args: VectorRenderArgs): Promise<VectorResult> {
  const s = session;
  if (!s) throw new Error('vector: сначала prepare()');
  const warnings: string[] = [];
  const unresolved = new Set<string>();
  const area = new DOMRect(s.area.x, s.area.y, s.area.width, s.area.height);
  const doc = elementToSVG(s.root, { captureArea: area, keepLinks: false }) as XMLDocument;

  // Raster patches replace whatever dom-to-svg drew for those elements.
  for (const [id, b] of s.patches) {
    const g = doc.getElementById(id);
    const data = args.patches[id];
    if (!g) continue;
    while (g.firstChild) g.removeChild(g.firstChild);
    g.removeAttribute('opacity'); // already in the screenshot pixels
    if (data) {
      const image = el(doc, 'image', { x: num(b.x), y: num(b.y), width: num(b.width), height: num(b.height), preserveAspectRatio: 'none' });
      image.setAttributeNS(XLINK_NS, 'xlink:href', data);
      g.append(image);
    }
  }

  // Box shadows → filters on the background rect.
  let fid = 0;
  for (const [id, shadows] of s.shadows) {
    const g = doc.getElementById(id);
    const rect = g && backgroundRects(g).find((r) => r.localName === 'rect');
    if (!rect) continue;
    const filterId = `shadow${++fid}`;
    defsOf(doc).append(shadowFilter(doc, filterId, rectBox(rect), shadows));
    rect.setAttribute('filter', `url(#${filterId})`);
  }

  // Placeholders, select values, textarea text.
  for (const [id, f] of s.fields) {
    const g = doc.getElementById(id);
    if (!g) continue;
    const t = el(doc, 'text', { x: num(f.x), y: num(f.y), fill: f.color, 'dominant-baseline': 'central', 'xml:space': 'preserve', ...f.font });
    t.textContent = f.text;
    g.append(t);
  }

  await inlineImages(doc, s, unresolved);
  if (args.fill) {
    const svg = doc.documentElement;
    const r = s.root.getBoundingClientRect();
    const radius = parseFloat(getComputedStyle(s.root).borderTopLeftRadius) || 0;
    const bg = el(doc, 'rect', { x: num(r.x), y: num(r.y), width: num(r.width), height: num(r.height), rx: radius ? num(radius) : '', fill: args.fill });
    svg.insertBefore(bg, Array.from(svg.children).find((c) => c.localName === 'g') ?? null);
  }
  normalizeColors(doc);
  fixBaselines(doc);

  // Fonts of the families in use.
  const used = new Set<string>();
  doc.querySelectorAll('[font-family]').forEach((n) =>
    (n.getAttribute('font-family') ?? '').split(',').forEach((f) => used.add(f.replace(/["']/g, '').trim().toLowerCase())),
  );
  const style = Array.from(doc.documentElement.children).find((c) => c.localName === 'style');
  const faces = await fontFaces(used, args.maxFontBytes ?? 3 * 1024 * 1024, warnings);
  if (style) {
    if (faces) style.textContent = faces;
    else style.remove();
  }

  const { ratio, visual } = zoom();
  setViewBox(doc, s.area, visual);
  const out: VectorResult = { width: s.area.width * visual, height: s.area.height * visual, unresolved: [...unresolved], warnings };
  const serialize = (d: XMLDocument) => {
    strip(d);
    readableIds(d, s.names);
    return new XMLSerializer().serializeToString(d);
  };
  const removeBackdrop = (d: XMLDocument) => {
    for (const id of s.backdrop) {
      const g = d.getElementById(id);
      if (g) for (const r of backgroundRects(g)) r.remove();
    }
  };
  if (args.variants.includes('clear') || args.variants.includes('cards')) {
    const clear = cloneDoc(doc);
    removeBackdrop(clear);
    if (args.variants.includes('cards')) {
      const cards = cloneDoc(clear);
      for (const id of s.chrome) cards.getElementById(id)?.remove();
      const b = args.cardsBoxDevice;
      if (b) setViewBox(cards, { x: b.x / ratio, y: b.y / ratio, width: b.width / ratio, height: b.height / ratio }, visual);
      out.cards = serialize(cards);
    }
    if (args.variants.includes('clear')) out.clear = serialize(clear);
  }
  if (args.variants.includes('default')) out.default = serialize(doc);
  return out;
}

declare global {
  interface Window {
    __scrnVector?: { prepare: typeof prepare; render: typeof render; cleanup: typeof cleanup };
  }
}

window.__scrnVector = { prepare, render, cleanup };
