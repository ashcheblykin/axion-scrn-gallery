/**
 * In-page part of `scrn discover`: everything reachable from the current page. Evaluated via
 * `page.evaluate(explorePage, args)` — keep it self-contained (no imports, no module scope).
 *
 * Elements that need a real click (Playwright's, not el.click(): menus often listen to pointer events) are
 * marked with data-scrn-* attributes and clicked from Node.
 */

export interface ExploreArgs {
  mode: 'expanders' | 'nav' | 'content';
  /** Navigation containers: their links are sections, the rest of the page is content. */
  nav: string[];
  /** Regex source: names never clicked (destructive or committing actions). */
  danger: string;
  /** Regex source: buttons whose panel deserves its own screen (filters, columns, view settings). */
  panels: string;
  limits: { tabs: number; panels: number; links: number };
}

export interface ExploreLink {
  href: string;
  text: string;
  /** Label of the collapsible nav group the link sits in ("Planning"). */
  group?: string;
}

export interface ExploreClickable {
  /** Value of the data-scrn-* attribute that marks the element. */
  mark: string;
  text: string;
  group?: string;
}

export interface ExploreResult {
  expanders: ExploreClickable[];
  links: ExploreLink[];
  clickables: ExploreClickable[];
  tabs: { name: string; selected: boolean }[];
  panels: ExploreClickable[];
  rows: ExploreClickable[];
  heading: string;
  /** Open dialogs, drawers, menus — a click that adds one opened a panel. */
  overlays: number;
}

export function explorePage(args: ExploreArgs): ExploreResult {
  const danger = new RegExp(args.danger, 'i');
  const panelRe = new RegExp(args.panels, 'i');
  const out: ExploreResult = { expanders: [], links: [], clickables: [], tabs: [], panels: [], rows: [], heading: '', overlays: 0 };

  const query = (sel: string, root: ParentNode = document): Element[] => {
    try {
      return Array.from(root.querySelectorAll(sel));
    } catch {
      return [];
    }
  };
  const all = args.nav.flatMap((s) => query(s));
  const navRoots = all.filter((el, i) => all.indexOf(el) === i && !all.some((o) => o !== el && o.contains(el)));
  const inNav = (el: Element) => navRoots.some((r) => r.contains(el));
  const label = (el: Element) =>
    (el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const sameOrigin = (href: string) => {
    try {
      const u = new URL(href, location.href);
      return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === location.origin;
    } catch {
      return false;
    }
  };
  const clean = (href: string) => {
    const u = new URL(href, location.href);
    u.hash = '';
    return u.toString();
  };
  document.querySelectorAll('[data-scrn-x],[data-scrn-c],[data-scrn-p],[data-scrn-r]').forEach((e) => {
    for (const a of ['data-scrn-x', 'data-scrn-c', 'data-scrn-p', 'data-scrn-r']) e.removeAttribute(a);
  });

  // Collapsible nav groups: aria-expanded triggers and <details>.
  const groupOf = new Map<Element, string>();
  const LINKISH = 'a[href], [role=link], [role=menuitem], [role=treeitem]';
  for (const root of navRoots) {
    for (const x of query('[aria-expanded]', root)) {
      const name = label(x);
      if (!name) continue;
      const controls = x.getAttribute('aria-controls');
      const candidates = [controls ? document.getElementById(controls) : null, x.nextElementSibling, x.parentElement];
      const box = candidates.find((c) => {
        if (!c || navRoots.includes(c)) return false;
        const n = query(LINKISH, c).filter((a) => a !== x && !x.contains(a)).length;
        return n > 0 && n < 40;
      });
      if (box) for (const a of query(LINKISH, box)) if (a !== x && !x.contains(a)) groupOf.set(a, name);
    }
    for (const d of query('details', root)) {
      const s = d.querySelector('summary');
      if (s) for (const a of query(LINKISH, d)) groupOf.set(a, label(s));
    }
  }

  const overlays = query('[role=dialog], [aria-modal=true], [role=menu], [role=listbox], [class*=drawer i], [class*=popover i]').filter(visible);
  out.overlays = overlays.length;
  out.heading = label(document.querySelector('h1, [role=heading][aria-level="1"]') ?? document.createElement('i'));

  if (args.mode === 'expanders') {
    let n = 0;
    for (const root of navRoots) {
      for (const d of query('details:not([open])', root)) (d as HTMLDetailsElement).open = true;
      for (const x of query('[aria-expanded="false"]', root)) {
        const text = label(x);
        if (!text || danger.test(text) || !visible(x)) continue;
        const mark = String(++n);
        x.setAttribute('data-scrn-x', mark);
        out.expanders.push({ mark, text });
      }
    }
    return out;
  }

  if (args.mode === 'nav') {
    const seen = new Set<string>();
    for (const root of navRoots) {
      for (const a of query('a[href]', root) as HTMLAnchorElement[]) {
        if (!sameOrigin(a.href) || a.hasAttribute('download')) continue;
        const href = clean(a.href);
        if (seen.has(href)) continue;
        seen.add(href);
        out.links.push({ href, text: label(a), group: groupOf.get(a) });
      }
    }
    // Menu items that navigate from a click handler (no href).
    let n = 0;
    const candidates = navRoots.flatMap((root) =>
      query('[role=link]:not(a), [role=menuitem]:not(a), [role=treeitem]:not(a), [data-href], [data-to], [data-url], [data-path], li, div, span', root),
    );
    const picked: Element[] = [];
    for (const el of candidates) {
      if (el.closest('a[href]') || el.querySelector('a[href]') || el.hasAttribute('aria-expanded') || el.closest('[aria-expanded]') === el) continue;
      if (!visible(el)) continue;
      const roleish = el.matches('[role=link], [role=menuitem], [role=treeitem], [data-href], [data-to], [data-url], [data-path]');
      if (!roleish) {
        const cs = getComputedStyle(el);
        if (cs.cursor !== 'pointer' || (el.textContent ?? '').trim().length > 60 || el.querySelectorAll('*').length > 6) continue;
        if (el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer' && !navRoots.includes(el.parentElement)) continue;
      }
      const text = label(el);
      if (!text || danger.test(text) || picked.some((p) => p.contains(el) || el.contains(p))) continue;
      picked.push(el);
      const mark = String(++n);
      el.setAttribute('data-scrn-c', mark);
      out.clickables.push({ mark, text, group: groupOf.get(el) });
    }
    return out;
  }

  // Content: links to deeper pages, tabs, panels, clickable rows.
  const seen = new Set<string>();
  for (const a of query('a[href]') as HTMLAnchorElement[]) {
    if (out.links.length >= args.limits.links) break;
    if (inNav(a) || !sameOrigin(a.href) || a.hasAttribute('download') || !visible(a)) continue;
    const href = clean(a.href);
    if (seen.has(href) || href === clean(location.href)) continue;
    seen.add(href);
    out.links.push({ href, text: label(a) });
  }
  for (const t of query('[role=tab]')) {
    if (out.tabs.length >= args.limits.tabs) break;
    if (inNav(t) || !visible(t) || (t as HTMLAnchorElement).href) continue;
    const name = label(t);
    if (!name || danger.test(name)) continue;
    out.tabs.push({ name, selected: t.getAttribute('aria-selected') === 'true' });
  }
  let p = 0;
  for (const b of query('button, [role=button]')) {
    if (out.panels.length >= args.limits.panels) break;
    if (inNav(b) || !visible(b) || b.closest('[role=dialog], [aria-modal=true]')) continue;
    const name = label(b);
    if (!name || danger.test(name) || (!panelRe.test(name) && b.getAttribute('aria-haspopup') !== 'dialog')) continue;
    if ((b as HTMLButtonElement).type === 'submit' && b.closest('form')) continue;
    const mark = String(++p);
    b.setAttribute('data-scrn-p', mark);
    out.panels.push({ mark, text: name });
  }
  for (const r of query('tbody tr, [role=row]')) {
    if (inNav(r) || r.querySelector('a[href], th, [role=columnheader]') || !visible(r)) continue;
    if (getComputedStyle(r).cursor !== 'pointer') continue;
    r.setAttribute('data-scrn-r', '1');
    out.rows.push({ mark: '1', text: label(r).slice(0, 60) });
    break;
  }
  return out;
}
