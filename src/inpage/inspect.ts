/**
 * Functions evaluated in the page via `page.evaluate(fn, arg)`. Each one must be self-contained.
 */

export interface InspectArgs {
  scrollContainer?: string;
  /** [taxonomy element name, CSS selector] */
  elementRules: [string, string][];
  textLimit: number;
}

export interface InspectResult {
  title: string;
  heading: string;
  elements: string[];
  text: string;
  viewportHeight: number;
  /** Height (CSS px) the viewport needs to show everything without inner scrolling. */
  neededHeight: number;
  overflow: boolean;
  cardCount: number;
}

export function inspectPage(args: InspectArgs): InspectResult {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };

  const elements: string[] = [];
  for (const [name, selector] of args.elementRules) {
    try {
      const found = Array.from(document.querySelectorAll(selector)).some((el) => {
        if (!visible(el)) return false;
        if (name === 'Chart' && el.tagName === 'CANVAS') {
          const r = el.getBoundingClientRect();
          return r.width > 120 && r.height > 60 && !el.closest('.mapboxgl-map,.maplibregl-map,.leaflet-container,.ol-viewport,.gm-style');
        }
        if (name === 'Sidebar') return el.getBoundingClientRect().height > vh * 0.5;
        return true;
      });
      if (found && !elements.includes(name)) elements.push(name);
    } catch {
      // invalid selector in config
    }
  }

  // Cards: rounded boxes with their own background or shadow, reasonably large.
  let cardCount = 0;
  document.querySelectorAll('div,section,article,li').forEach((el) => {
    if (cardCount > 50) return;
    const r = el.getBoundingClientRect();
    if (r.width < 120 || r.height < 60 || r.width > vw * 0.9) return;
    const cs = getComputedStyle(el);
    const radius = parseFloat(cs.borderTopLeftRadius) || 0;
    const hasBg = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
    const hasShadow = cs.boxShadow && cs.boxShadow !== 'none';
    const hasBorder = parseFloat(cs.borderTopWidth) > 0;
    if (radius >= 6 && (hasBg || hasShadow || hasBorder) && visible(el)) cardCount++;
  });
  if (cardCount >= 3 && !elements.includes('Card')) elements.push('Card');

  const doc = document.scrollingElement ?? document.documentElement;
  let container: Element | null = null;
  if (args.scrollContainer) {
    try {
      container = document.querySelector(args.scrollContainer);
    } catch {
      container = null;
    }
  }
  if (!container) {
    let best = 0;
    document.querySelectorAll('*').forEach((el) => {
      if (el === doc || el === document.body) return;
      const h = el as HTMLElement;
      if (h.scrollHeight <= h.clientHeight + 4) return;
      const oy = getComputedStyle(h).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') return;
      if (h.clientHeight < vh * 0.4 || h.clientWidth < vw * 0.4) return;
      const area = h.clientWidth * h.clientHeight;
      if (area > best) {
        best = area;
        container = el;
      }
    });
  }
  document.querySelectorAll('[data-scrn-scroll]').forEach((el) => el.removeAttribute('data-scrn-scroll'));
  let extra = 0;
  if (container) {
    const h = container as HTMLElement;
    h.setAttribute('data-scrn-scroll', '1');
    extra = Math.max(0, h.scrollHeight - h.clientHeight);
  }
  const neededHeight = Math.ceil(Math.max(doc.scrollHeight, vh + extra));

  const text = (document.body?.innerText ?? '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const h1 = document.querySelector('h1, [role=heading][aria-level="1"]');

  return {
    title: document.title,
    heading: (h1?.textContent ?? '').trim().slice(0, 120),
    elements,
    text: text.slice(0, args.textLimit),
    viewportHeight: vh,
    neededHeight,
    overflow: neededHeight > vh + 4,
    cardCount,
  };
}

/** Everything a viewer could read on the screenshot: rendered text, visible attributes, image URLs. */
export function collectVisibleText(): string {
  const parts: string[] = [];
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const seen = new Set<Document | ShadowRoot>();
  const visit = (root: Document | ShadowRoot) => {
    if (seen.has(root)) return;
    seen.add(root);
    if (root instanceof Document) parts.push(root.body?.innerText ?? '');
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) {
        parts.push((el.shadowRoot as unknown as HTMLElement).textContent ?? '');
        visit(el.shadowRoot);
      }
      if (el.tagName === 'IFRAME') {
        try {
          const d = (el as HTMLIFrameElement).contentDocument;
          if (d) visit(d);
        } catch {
          /* cross-origin */
        }
      }
      const r = el.getBoundingClientRect();
      const onScreen = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh * 8 && r.right > 0 && r.left < vw;
      if (!onScreen) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return;
      for (const a of ['title', 'alt', 'aria-label', 'placeholder']) {
        const v = el.getAttribute(a);
        if (v) parts.push(v);
      }
      if (el.tagName === 'IMG') {
        const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src;
        if (src && !src.startsWith('data:')) parts.push(decodeURIComponent(src.split('?')[0]));
      }
      if (el.tagName.toLowerCase() === 'text' || el.tagName.toLowerCase() === 'tspan') parts.push(el.textContent ?? '');
      if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && (el as HTMLInputElement).value) {
        parts.push((el as HTMLInputElement).value);
      }
    });
  };
  visit(document);
  return parts.join('\n');
}

/** Bounding boxes (CSS px, viewport-relative) of everything matching the selectors. */
export function measureRects(selectors: string[]): { x: number; y: number; width: number; height: number }[] {
  const out: { x: number; y: number; width: number; height: number }[] = [];
  for (const sel of selectors) {
    try {
      document.querySelectorAll(sel).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) out.push({ x: r.x, y: r.y, width: r.width, height: r.height });
      });
    } catch {
      /* invalid selector */
    }
  }
  return out;
}

/** Discover same-origin navigation links (for `scrn discover`). */
export function collectLinks(selectors: string[]): { href: string; text: string }[] {
  const out = new Map<string, string>();
  for (const sel of selectors) {
    try {
      document.querySelectorAll(sel).forEach((el) => {
        const a = el as HTMLAnchorElement;
        if (!a.href) return;
        const url = new URL(a.href, location.href);
        if (url.origin !== location.origin) return;
        url.hash = '';
        const key = url.toString();
        if (!out.has(key)) out.set(key, (a.textContent ?? a.getAttribute('aria-label') ?? '').trim().slice(0, 80));
      });
    } catch {
      /* invalid selector */
    }
  }
  return [...out.entries()].map(([href, text]) => ({ href, text }));
}
