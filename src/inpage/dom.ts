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
  logoDataUri: string;
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

  /** Selector rules replace every text chunk of the element by kind (whitespace around is kept). */
  function applyRules(root: Document | ShadowRoot) {
    for (const rule of cfg.rules) {
      let els: NodeListOf<Element>;
      try {
        els = root.querySelectorAll(rule.selector);
      } catch {
        continue;
      }
      els.forEach((el) => {
        for (const t of textNodes(el)) {
          const v = t.nodeValue ?? '';
          const core = v.trim();
          if (!core || pipe.generated.has(core.toLowerCase())) continue;
          const lead = v.slice(0, v.indexOf(core));
          const trail = v.slice(v.indexOf(core) + core.length);
          t.nodeValue = lead + pipe.byKind(rule.kind, core, rule.value) + trail;
          stats.replacements++;
        }
        if (el instanceof HTMLInputElement && el.value && !pipe.generated.has(el.value.toLowerCase())) {
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
    const src =
      rule.with === 'avatar'
        ? initialsAvatar(el.getAttribute('alt') || el.getAttribute('src') || el.textContent || '')
        : rule.with === 'logo'
          ? cfg.logoDataUri
          : (rule.dataUri ?? cfg.logoDataUri);
    if (el instanceof HTMLImageElement) {
      el.removeAttribute('srcset');
      const picture = el.parentElement;
      if (picture && picture.tagName === 'PICTURE') picture.querySelectorAll('source').forEach((s) => s.remove());
      el.src = src;
      style.setProperty('object-fit', 'contain', 'important');
    } else if (el instanceof SVGElement && el.tagName.toLowerCase() === 'svg') {
      const r = el.getBoundingClientRect();
      const img = document.createElement('img');
      img.src = src;
      img.setAttribute('data-scrn-img', '1');
      img.style.width = `${r.width}px`;
      img.style.height = `${r.height}px`;
      img.style.objectFit = 'contain';
      el.replaceWith(img);
    } else {
      style.setProperty('background-image', `url("${src}")`, 'important');
      style.setProperty('background-size', 'contain', 'important');
      style.setProperty('background-repeat', 'no-repeat', 'important');
      style.setProperty('background-position', 'center', 'important');
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
