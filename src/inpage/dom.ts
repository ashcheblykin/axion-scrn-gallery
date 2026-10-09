/**
 * In-page DOM anonymizer. Injected via `Function#toString()` — keep it self-contained.
 * Works on text nodes (incl. SVG <text> of charts), attributes, input values, open shadow roots
 * and same-origin iframes; swaps logos/avatars; blurs or hides configured elements.
 */
import type { PipelineKind, TextPipeline } from './pipeline.js';

export interface DomAnonConfig {
  rules: { selector: string; kind: PipelineKind; value?: string }[];
  images: { selector: string; with: string; dataUri?: string }[];
  blur: string[];
  hide: string[];
  /** Replacement for client logos on light backgrounds… */
  logoDataUri: string;
  /** …and on dark ones (sidebars, dark headers). */
  logoOnDarkDataUri: string;
  attributes: string[];
}

export interface DomAnonymizer {
  apply(): { replacements: number; images: number };
  observe(): void;
  disconnect(): void;
  stats: { replacements: number; images: number };
}

export function createDomAnonymizer(pipe: TextPipeline, cfg: DomAnonConfig): DomAnonymizer {
  const stats = { replacements: 0, images: 0 };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  let observer: MutationObserver | null = null;
  let applying = false;

  function roots(): (Document | ShadowRoot)[] {
    const out: (Document | ShadowRoot)[] = [];
    const visit = (root: Document | ShadowRoot) => {
      out.push(root);
      root.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) visit(el.shadowRoot);
        if (el.tagName === 'IFRAME') {
          try {
            const doc = (el as HTMLIFrameElement).contentDocument;
            if (doc && doc.body) visit(doc);
          } catch {
            // cross-origin iframe — out of reach
          }
        }
      });
    };
    visit(document);
    return out;
  }

  function textNodes(root: Node): Text[] {
    const out: Text[] = [];
    const doc = root.ownerDocument ?? (root as Document);
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || SKIP.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
    return out;
  }

  function rewriteText(node: Text) {
    const v = node.nodeValue ?? '';
    const { out, n } = pipe.text(v);
    if (n && out !== v) {
      node.nodeValue = out;
      stats.replacements += n;
    }
  }

  function rewriteAttrs(el: Element) {
    for (const a of cfg.attributes) {
      const v = el.getAttribute(a);
      if (!v) continue;
      const { out, n } = pipe.text(v);
      if (n && out !== v) {
        el.setAttribute(a, out);
        stats.replacements += n;
      }
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const v = el.value;
      if (v) {
        const { out, n } = pipe.text(v);
        if (n && out !== v) {
          el.value = out;
          stats.replacements += n;
        }
      }
    }
  }

  // Navigation, menus, tabs and trees hold section names: selector rules never rewrite them. Only the
  // identity of the signed-in user (person / email) is replaced there — it often sits inside the sidebar nav.
  const STRUCTURAL = 'nav, [role=navigation], [role=menu], [role=menubar], [role=tablist], [role=tree]';
  const IDENTITY = new Set(['person', 'email']);
  // A rule targets one value (a name, a plate, a phone). A match with a lot of text is a container that the
  // selector caught by accident (e.g. [class*=plate] on "transition-[grid-template-rows]") — leave it alone.
  const MAX_VALUE = 160;
  const DIGIT = /[0-9٠-٩۰-۹]/;
  const UI_WORDS = new Set(['user', 'username', 'user name', 'name', 'full name', 'profile', 'account', 'admin', 'guest', 'me', 'you', 'имя', 'пользователь', 'профиль', 'аккаунт', 'الاسم', 'المستخدم']);

  /** Does the value look like what the rule is meant to replace? Labels and headings next to the value do not. */
  function plausible(kind: PipelineKind, value: string): boolean {
    const v = value.trim();
    switch (kind) {
      case 'chars':
        // Plates, IBANs, document numbers: digits, no lowercase words ("Route 66 checklist" is a title, not a plate)
        return DIGIT.test(v) && v.length <= 40 && !/\p{Ll}/u.test(v);
      case 'digits':
        return DIGIT.test(v);
      case 'email':
        return v.includes('@');
      case 'person':
        return (
          v.length <= 64 &&
          !DIGIT.test(v) &&
          !v.includes('@') &&
          /\p{L}/u.test(v) &&
          v.split(/\s+/).length <= 6 &&
          !UI_WORDS.has(v.toLowerCase().replace(/[:：]$/, ''))
        );
      case 'org':
        return /\p{L}/u.test(v) && v.length <= 120;
      default:
        return true; // text / lorem — explicit fixed replacements
    }
  }

  /** Selector rules replace every text chunk of the element by kind (whitespace around is kept). */
  function applyRules(root: Document | ShadowRoot) {
    for (const rule of cfg.rules) {
      let els: NodeListOf<Element>;
      try {
        els = root.querySelectorAll(rule.selector);
      } catch {
        continue;
      }
      const limited = rule.kind !== 'text' && rule.kind !== 'lorem';
      const structural = !IDENTITY.has(rule.kind);
      els.forEach((el) => {
        if (limited && (el.textContent ?? '').trim().length > MAX_VALUE) return;
        if (structural && el.closest(STRUCTURAL)) return;
        for (const t of textNodes(el)) {
          const v = t.nodeValue ?? '';
          const core = v.trim();
          if (!core || pipe.generated.has(core.toLowerCase()) || !plausible(rule.kind, core)) continue;
          if (structural && t.parentElement?.closest(STRUCTURAL)) continue;
          const lead = v.slice(0, v.indexOf(core));
          const trail = v.slice(v.indexOf(core) + core.length);
          t.nodeValue = lead + pipe.byKind(rule.kind, core, rule.value) + trail;
          stats.replacements++;
        }
        if (el instanceof HTMLInputElement && el.value && !pipe.generated.has(el.value.toLowerCase()) && plausible(rule.kind, el.value)) {
          el.value = pipe.byKind(rule.kind, el.value, rule.value);
          stats.replacements++;
        }
      });
    }
  }

  function initialsAvatar(seed: string): string {
    const palette = ['#5B8DEF', '#7C5CE0', '#2BB5A0', '#E0795C', '#D9A23A', '#4F6B8A'];
    const h = pipe.hash(seed);
    // The alt text is usually anonymized already — reuse that persona so initials match the name next to it.
    const name = pipe.generated.has(seed.trim().toLowerCase()) ? seed.trim() : pipe.byKind('person', seed || 'User Name');
    const initials = name
      .split(/\s+/)
      .map((p) => p[0] ?? '')
      .join('')
      .slice(0, 2)
      .toUpperCase();
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">` +
      `<rect width="96" height="96" rx="48" fill="${palette[h % palette.length]}"/>` +
      `<text x="48" y="58" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="34" font-weight="600" fill="#fff">${initials}</text></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  let probe: CanvasRenderingContext2D | null | undefined;
  /** Any CSS color (rgb, oklch, color(display-p3 …)) → sRGB bytes + alpha 0..1. */
  function rgba(color: string): [number, number, number, number] | null {
    if (probe === undefined) {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      probe = c.getContext('2d', { willReadFrequently: true });
    }
    if (!probe) return null;
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = '#000';
    probe.fillStyle = color;
    probe.fillRect(0, 0, 1, 1);
    const d = probe.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  }

  /** The first sufficiently opaque background behind the element decides which logo version is readable. */
  function onDarkBackground(el: Element): boolean {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') continue;
      const c = rgba(bg);
      if (!c || c[3] < 0.5) continue;
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] < 128;
    }
    return false;
  }

  function swapImage(el: Element, rule: { with: string; dataUri?: string }) {
    if (el.getAttribute('data-scrn-img')) return;
    el.setAttribute('data-scrn-img', '1');
    const style = (el as HTMLElement).style;
    if (rule.with === 'blur') {
      style.setProperty('filter', 'blur(18px) saturate(0.7)', 'important');
      style.setProperty('clip-path', 'inset(0)', 'important');
      stats.images++;
      return;
    }
    if (rule.with === 'hide') {
      style.setProperty('visibility', 'hidden', 'important');
      stats.images++;
      return;
    }
    const logo = () => (onDarkBackground(el) ? cfg.logoOnDarkDataUri : cfg.logoDataUri);
    const src =
      rule.with === 'avatar'
        ? initialsAvatar(el.getAttribute('alt') || el.getAttribute('src') || el.textContent || '')
        : rule.with === 'logo'
          ? logo()
          : (rule.dataUri ?? logo());
    if (el instanceof HTMLImageElement) {
      // Keep the box the original image had: the replacement has another intrinsic size and must not move the layout.
      const box = el.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) {
        style.setProperty('width', `${box.width}px`, 'important');
        style.setProperty('height', `${box.height}px`, 'important');
      }
      el.removeAttribute('srcset');
      const picture = el.parentElement;
      if (picture && picture.tagName === 'PICTURE') picture.querySelectorAll('source').forEach((s) => s.remove());
      el.src = src;
      style.setProperty('object-fit', 'contain', 'important');
      // A wordmark slot (wide box) keeps the mark at its start edge, like the original logo; square slots center it.
      if (rule.with !== 'avatar' && box.width > box.height * 2) {
        style.setProperty('object-position', getComputedStyle(el).direction === 'rtl' ? 'right center' : 'left center', 'important');
      }
    } else if (el instanceof SVGElement && el.tagName.toLowerCase() === 'svg') {
      const r = el.getBoundingClientRect();
      const img = document.createElement('img');
      img.src = src;
      img.setAttribute('data-scrn-img', '1');
      img.style.width = `${r.width}px`;
      img.style.height = `${r.height}px`;
      img.style.objectFit = 'contain';
      if (r.width > r.height * 2) img.style.objectPosition = getComputedStyle(el).direction === 'rtl' ? 'right center' : 'left center';
      el.replaceWith(img);
    } else {
      const r = el.getBoundingClientRect();
      const start = rule.with !== 'avatar' && r.width > r.height * 2;
      style.setProperty('background-image', `url("${src}")`, 'important');
      style.setProperty('background-size', 'contain', 'important');
      style.setProperty('background-repeat', 'no-repeat', 'important');
      style.setProperty('background-position', start ? (getComputedStyle(el).direction === 'rtl' ? 'right center' : 'left center') : 'center', 'important');
    }
    stats.images++;
  }

  function applyImagesAndMasks(root: Document | ShadowRoot) {
    for (const rule of cfg.images) {
      try {
        root.querySelectorAll(rule.selector).forEach((el) => swapImage(el, rule));
      } catch {
        // invalid selector — reported by `scrn doctor`
      }
    }
    for (const sel of cfg.blur) {
      try {
        root.querySelectorAll(sel).forEach((el) => swapImage(el, { with: 'blur' }));
      } catch {
        /* skip */
      }
    }
    for (const sel of cfg.hide) {
      try {
        root.querySelectorAll(sel).forEach((el) => swapImage(el, { with: 'hide' }));
      } catch {
        /* skip */
      }
    }
  }

  function applyTo(root: Document | ShadowRoot) {
    applyRules(root);
    const base: Node = root instanceof Document ? (root.body ?? root.documentElement) : root;
    if (!base) return;
    for (const t of textNodes(base)) rewriteText(t);
    (root.querySelectorAll('*') as NodeListOf<Element>).forEach(rewriteAttrs);
    applyImagesAndMasks(root);
  }

  function apply() {
    applying = true;
    try {
      for (const root of roots()) applyTo(root);
      const { out, n } = pipe.text(document.title);
      if (n) document.title = out;
    } finally {
      applying = false;
    }
    return { ...stats };
  }

  function observe() {
    if (observer) return;
    let scheduled = false;
    observer = new MutationObserver(() => {
      if (applying || scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        apply();
      });
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...cfg.attributes, 'src', 'value'],
    });
  }

  function disconnect() {
    observer?.disconnect();
    observer = null;
  }

  return { apply, observe, disconnect, stats };
}
