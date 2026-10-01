import fs from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../config/load.js';
import { humanFileName } from '../core/naming.js';
import type { LibraryIndex } from '../core/types.js';

/**
 * Static Mobbin-like gallery: library/index.html with the catalog embedded — open it from disk or
 * via `scrn serve`. Thumbnails live in plain git, so the grid works even before `git lfs pull`.
 */

export function galleryData(ws: Workspace, index: LibraryIndex) {
  const productNames = new Map(ws.products.map((p) => [p.id, p.name]));
  return {
    updatedAt: index.updatedAt,
    products: index.products,
    briefs: ws.taxonomy.briefs,
    flows: index.flows,
    runs: index.runs.slice(0, 5),
    screens: index.screens
      .filter((s) => s.status !== 'orphaned')
      .map((s) => ({
        id: s.id,
        product: s.product,
        platform: s.platform,
        theme: s.theme,
        locale: s.locale,
        flow: s.flow,
        flowName: s.flowName,
        position: s.position,
        title: s.title,
        description: s.description,
        brief: s.brief,
        patterns: s.patterns,
        elements: s.elements,
        tags: s.tags,
        keywords: s.keywords,
        status: s.status,
        findings: s.anonymization.audit?.flagged ? s.anonymization.audit.findings : [],
        quality: s.quality,
        version: s.version,
        changedAt: s.changedAt,
        capturedAt: s.capturedAt,
        route: s.route,
        overflow: s.overflow,
        viewport: s.viewport,
        files: s.files,
        sections: s.sections.map((x) => ({ id: x.id, name: x.name, file: x.file })),
        download: humanFileName({
          productName: productNames.get(s.product) ?? s.product,
          flowName: s.flowName,
          position: s.position,
          title: s.title,
          platform: s.platform,
          theme: s.theme,
          locale: s.locale,
        }).replace(/\.png$/, ''),
      })),
  };
}

export function buildGallery(ws: Workspace, index: LibraryIndex): string {
  const data = JSON.stringify(galleryData(ws, index)).replace(/</g, '\\u003c');
  const html = TEMPLATE.replace('__DATA__', data);
  const file = path.join(ws.paths.library, 'index.html');
  fs.mkdirSync(ws.paths.library, { recursive: true });
  fs.writeFileSync(file, html);
  return file;
}

const TEMPLATE = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Axion Screens</title>
<style>
  :root {
    --bg: #f6f7f9; --panel: #ffffff; --text: #0f172a; --muted: #64748b; --line: #e2e8f0;
    --accent: #3b5bdb; --chip: #eef2ff; --chip-text: #3730a3; --warn: #b45309; --bad: #b91c1c;
    --shadow: 0 1px 2px rgba(15,23,42,.06), 0 8px 24px rgba(15,23,42,.06);
    --check-a: #e5e7eb; --check-b: #f8fafc;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0b0f17; --panel: #121826; --text: #e5e7eb; --muted: #94a3b8; --line: #1f2937;
      --accent: #8da2fb; --chip: #1e2540; --chip-text: #c7d2fe; --warn: #f59e0b; --bad: #f87171;
      --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.35); --check-a: #1f2937; --check-b: #111827;
    }
  }
  :root[data-theme="dark"] {
    --bg: #0b0f17; --panel: #121826; --text: #e5e7eb; --muted: #94a3b8; --line: #1f2937;
    --accent: #8da2fb; --chip: #1e2540; --chip-text: #c7d2fe; --warn: #f59e0b; --bad: #f87171;
    --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.35); --check-a: #1f2937; --check-b: #111827;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif; }
  header { position: sticky; top: 0; z-index: 5; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(12px); border-bottom: 1px solid var(--line); }
  .bar { max-width: 1440px; margin: 0 auto; padding: 14px 16px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .brand { font-weight: 700; font-size: 16px; margin-right: 8px; }
  .meta { color: var(--muted); font-size: 12px; }
  input[type=search], select { background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; font: inherit; }
  input[type=search] { flex: 1 1 260px; min-width: 0; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  .seg button { background: var(--panel); color: var(--text); border: 0; padding: 8px 12px; font: inherit; cursor: pointer; }
  .seg button[aria-pressed="true"] { background: var(--accent); color: #fff; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip { background: var(--chip); color: var(--chip-text); border-radius: 999px; padding: 3px 9px; font-size: 12px; border: 0; cursor: pointer; font: inherit; font-size: 12px; }
  .chip[aria-pressed="true"] { background: var(--accent); color: #fff; }
  main { max-width: 1440px; margin: 0 auto; padding: 18px 16px 60px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 18px; }
  .grid.mobile { grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); }
  .card { background: var(--panel); border-radius: 14px; box-shadow: var(--shadow); overflow: hidden; cursor: pointer; display: flex; flex-direction: column; border: 1px solid var(--line); }
  .card img { width: 100%; display: block; background: var(--line); aspect-ratio: 16 / 10; object-fit: cover; object-position: top; }
  .card.mobile img { aspect-ratio: 9 / 19.5; }
  .card .body { padding: 10px 12px 12px; display: grid; gap: 4px; }
  .card .title { font-weight: 600; }
  .badges { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
  .badge { font-size: 11px; border-radius: 6px; padding: 1px 6px; border: 1px solid var(--line); color: var(--muted); }
  .badge.brief { border-color: var(--accent); color: var(--accent); }
  .badge.warn { border-color: var(--warn); color: var(--warn); }
  .badge.bad { border-color: var(--bad); color: var(--bad); }
  .flow { margin-bottom: 28px; }
  .flow h3 { margin: 0 0 4px; font-size: 15px; }
  .strip { display: flex; gap: 14px; overflow-x: auto; padding: 8px 2px 12px; scroll-snap-type: x mandatory; }
  .strip .card { flex: 0 0 300px; scroll-snap-align: start; }
  .strip .card.mobile { flex-basis: 170px; }
  .empty { color: var(--muted); padding: 40px 0; text-align: center; }
  dialog { border: 0; border-radius: 16px; padding: 0; width: min(1280px, 96vw); max-height: 94vh; background: var(--panel); color: var(--text); box-shadow: var(--shadow); }
  dialog::backdrop { background: rgba(2, 6, 23, .6); }
  .viewer { display: grid; grid-template-columns: minmax(0, 1fr) 320px; max-height: 94vh; }
  .stage { overflow: auto; background: repeating-conic-gradient(var(--check-a) 0% 25%, var(--check-b) 0% 50%) 50% / 24px 24px; display: flex; align-items: flex-start; justify-content: center; padding: 16px; }
  .stage img { max-width: 100%; height: auto; box-shadow: var(--shadow); border-radius: 6px; }
  .side { padding: 16px; overflow: auto; border-left: 1px solid var(--line); display: grid; gap: 12px; align-content: start; }
  .side h2 { margin: 0; font-size: 17px; }
  .kv { display: grid; grid-template-columns: 90px 1fr; gap: 4px 8px; font-size: 12px; }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; overflow-wrap: anywhere; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .btn { display: inline-flex; align-items: center; gap: 6px; background: var(--accent); color: #fff; border-radius: 10px; padding: 8px 12px; text-decoration: none; font-size: 13px; border: 0; cursor: pointer; }
  .btn.ghost { background: transparent; color: var(--text); border: 1px solid var(--line); }
  .close { position: absolute; top: 10px; right: 12px; }
  @media (max-width: 860px) { .viewer { grid-template-columns: 1fr; } .side { border-left: 0; border-top: 1px solid var(--line); } }
</style>
</head>
<body>
<header>
  <div class="bar">
    <span class="brand">Axion Screens</span>
    <input type="search" id="q" placeholder="Поиск: сводка KPI, карта инспекторов, чат…" aria-label="Поиск">
    <div class="seg" id="view" role="group" aria-label="Вид">
      <button data-v="screens" aria-pressed="true">Экраны</button><button data-v="flows" aria-pressed="false">Флоу</button>
    </div>
    <select id="product" aria-label="Продукт"><option value="">Все продукты</option></select>
    <select id="platform" aria-label="Платформа"><option value="">Все платформы</option><option value="desktop">Desktop</option><option value="mobile">Mobile</option></select>
    <select id="pattern" aria-label="Паттерн"><option value="">Все паттерны</option></select>
    <button class="btn ghost" id="theme" type="button" aria-label="Тема">◐</button>
  </div>
  <div class="bar" style="padding-top:0">
    <div class="chips" id="briefs"></div>
    <span class="meta" id="meta"></span>
  </div>
</header>
<main id="main"></main>
<dialog id="dlg"><div style="position:relative">
  <button class="btn ghost close" id="dlg-close" type="button">✕</button>
  <div class="viewer"><div class="stage"><img id="dlg-img" alt=""></div><div class="side" id="dlg-side"></div></div>
</div></dialog>
<script id="data" type="application/json">__DATA__</script>
<script>
(() => {
  const D = JSON.parse(document.getElementById('data').textContent);
  const $ = (s) => document.querySelector(s);
  const state = { q: '', view: 'screens', product: '', platform: '', pattern: '', brief: '' };
  try { Object.assign(state, JSON.parse(localStorage.getItem('scrn-gallery') || '{}')); } catch (e) {}
  const save = () => { try { localStorage.setItem('scrn-gallery', JSON.stringify(state)); } catch (e) {} };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const productName = (id) => (D.products.find((p) => p.id === id) || {}).name || id;
  const briefName = (id) => (D.briefs.find((b) => b.id === id) || {}).name || id;

  for (const p of D.products) $('#product').insertAdjacentHTML('beforeend', '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>');
  const patterns = [...new Set(D.screens.flatMap((s) => s.patterns))].sort();
  for (const p of patterns) $('#pattern').insertAdjacentHTML('beforeend', '<option>' + esc(p) + '</option>');
  $('#briefs').innerHTML = '<button class="chip" data-b="">Все</button>' + D.briefs.map((b) => '<button class="chip" data-b="' + esc(b.id) + '" title="' + esc(b.description || '') + '">' + esc(b.name) + '</button>').join('');

  const matches = (s) => {
    if (state.product && s.product !== state.product) return false;
    if (state.platform && s.platform !== state.platform) return false;
    if (state.pattern && !s.patterns.includes(state.pattern)) return false;
    if (state.brief && s.brief !== state.brief) return false;
    if (!state.q) return true;
    const hay = [s.title, s.flowName, s.description, productName(s.product), s.patterns.join(' '), s.elements.join(' '), s.tags.join(' '), (s.keywords || []).join(' '), s.route, s.brief && briefName(s.brief)].join(' ').toLowerCase();
    return state.q.toLowerCase().split(/\\s+/).filter(Boolean).every((w) => hay.includes(w));
  };

  const card = (s) => {
    const badges = [];
    if (s.brief) badges.push('<span class="badge brief">' + esc(briefName(s.brief)) + '</span>');
    badges.push('<span class="badge">v' + s.version + '</span>');
    if (s.overflow) badges.push('<span class="badge warn" title="Контент ниже первого экрана — есть вариант full">↓ ещё</span>');
    if (s.status === 'review') badges.push('<span class="badge bad" title="' + esc(s.findings.join('; ')) + '">проверить</span>');
    if (s.status === 'failed') badges.push('<span class="badge warn">не обновился</span>');
    return '<article class="card ' + esc(s.platform) + '" data-id="' + esc(s.id) + '" tabindex="0">' +
      '<img loading="lazy" src="' + esc(s.files.thumb.path) + '" alt="' + esc(s.title) + '">' +
      '<div class="body"><div class="title">' + esc(s.title) + '</div>' +
      '<div class="meta">' + esc(productName(s.product)) + ' · ' + esc(s.flowName) + ' · ' + esc(s.platform) + '</div>' +
      '<div class="badges">' + badges.join('') + '</div></div></article>';
  };

  const render = () => {
    save();
    $('#q').value = state.q;
    for (const id of ['product', 'platform', 'pattern']) $('#' + id).value = state[id];
    document.querySelectorAll('#view button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === state.view)));
    document.querySelectorAll('#briefs .chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.b === state.brief)));
    const list = D.screens.filter(matches);
    $('#meta').textContent = list.length + ' из ' + D.screens.length + ' экранов · обновлено ' + new Date(D.updatedAt).toLocaleString('ru-RU');
    if (!list.length) { $('#main').innerHTML = '<div class="empty">Ничего не нашлось</div>'; return; }
    if (state.view === 'screens') {
      const byPlatform = (p) => list.filter((s) => s.platform === p);
      $('#main').innerHTML = ['desktop', 'mobile'].map((p) => byPlatform(p).length
        ? '<h3 class="meta" style="margin:6px 0 10px">' + (p === 'desktop' ? 'Desktop' : 'Mobile') + '</h3><div class="grid ' + p + '">' + byPlatform(p).map(card).join('') + '</div>'
        : '').join('<div style="height:24px"></div>');
    } else {
      const flows = D.flows.map((f) => ({ f, screens: f.steps.map((id) => list.find((s) => s.id === id)).filter(Boolean) })).filter((x) => x.screens.length);
      $('#main').innerHTML = flows.map(({ f, screens }) =>
        '<section class="flow"><h3>' + esc(productName(f.product)) + ' · ' + esc(f.name) + ' <span class="meta">' + esc(f.platform) + ' · ' + screens.length + ' экр.' + (f.brief ? ' · бриф: ' + esc(briefName(f.brief)) : '') + '</span></h3>' +
        (f.description ? '<div class="meta">' + esc(f.description) + '</div>' : '') +
        '<div class="strip">' + screens.map(card).join('') + '</div></section>').join('');
    }
  };

  const open = (id) => {
    const s = D.screens.find((x) => x.id === id);
    if (!s) return;
    const variants = [['default', 'С фоном'], ['clear', 'Без фона'], ['cards', 'Только плашки'], ['full', 'Вся страница']].filter(([k]) => s.files[k]);
    const show = (path) => { const img = $('#dlg-img'); img.onerror = () => { img.onerror = null; img.src = s.files.thumb.path; }; img.src = path; };
    const dl = (path, suffix) => '<a class="btn ghost" href="' + esc(path) + '" download="' + esc(s.download + (suffix ? ' ' + suffix : '') + '.png') + '">⬇ ' + esc(suffix || 'PNG') + '</a>';
    $('#dlg-side').innerHTML =
      '<h2>' + esc(s.title) + '</h2><div class="meta">' + esc(productName(s.product)) + ' · ' + esc(s.flowName) + ' · шаг ' + s.position + '</div>' +
      (s.description ? '<div>' + esc(s.description) + '</div>' : '') +
      (s.findings.length ? '<div class="badge bad">Privacy: ' + esc(s.findings.join('; ')) + '</div>' : '') +
      '<div class="actions">' + variants.map(([k, label], i) => '<button class="btn ' + (i ? 'ghost' : '') + '" data-variant="' + k + '">' + esc(label) + '</button>').join('') + '</div>' +
      '<div class="actions">' + variants.map(([k, label]) => dl(s.files[k].path, k === 'default' ? '' : label)).join('') + '</div>' +
      (s.sections.length ? '<div><div class="meta">Плашки</div><div class="actions">' + s.sections.map((x) => '<button class="btn ghost" data-section="' + esc(x.file.path) + '">' + esc(x.name) + '</button>' + dl(x.file.path, x.name)).join('') + '</div></div>' : '') +
      '<dl class="kv">' +
      '<dt>id</dt><dd>' + esc(s.id) + '</dd>' +
      '<dt>Платформа</dt><dd>' + esc(s.platform) + ' · ' + s.viewport.width + '×' + s.viewport.height + ' @' + s.viewport.scale + 'x</dd>' +
      '<dt>Паттерны</dt><dd>' + esc(s.patterns.join(', ') || '—') + '</dd>' +
      '<dt>Элементы</dt><dd>' + esc(s.elements.join(', ') || '—') + '</dd>' +
      '<dt>Теги</dt><dd>' + esc([...s.tags, ...(s.keywords || [])].join(', ') || '—') + '</dd>' +
      '<dt>Маршрут</dt><dd>' + esc(s.route || '—') + '</dd>' +
      '<dt>Версия</dt><dd>v' + s.version + ' · изменён ' + new Date(s.changedAt).toLocaleDateString('ru-RU') + ' · проверен ' + new Date(s.capturedAt).toLocaleDateString('ru-RU') + '</dd>' +
      '</dl>';
    $('#dlg-side').querySelectorAll('[data-variant]').forEach((b) => b.addEventListener('click', () => {
      $('#dlg-side').querySelectorAll('[data-variant]').forEach((x) => x.classList.add('ghost'));
      b.classList.remove('ghost');
      show(s.files[b.dataset.variant].path);
    }));
    $('#dlg-side').querySelectorAll('[data-section]').forEach((b) => b.addEventListener('click', () => show(b.dataset.section)));
    show(s.files.default.path);
    $('#dlg').showModal();
  };

  $('#q').addEventListener('input', (e) => { state.q = e.target.value; render(); });
  for (const id of ['product', 'platform', 'pattern']) $('#' + id).addEventListener('change', (e) => { state[id] = e.target.value; render(); });
  $('#view').addEventListener('click', (e) => { const v = e.target.dataset && e.target.dataset.v; if (v) { state.view = v; render(); } });
  $('#briefs').addEventListener('click', (e) => { if (e.target.dataset && 'b' in e.target.dataset) { state.brief = e.target.dataset.b; render(); } });
  $('#main').addEventListener('click', (e) => { const c = e.target.closest('.card'); if (c) open(c.dataset.id); });
  $('#main').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const c = e.target.closest('.card'); if (c) open(c.dataset.id); } });
  $('#dlg-close').addEventListener('click', () => $('#dlg').close());
  $('#dlg').addEventListener('click', (e) => { if (e.target === $('#dlg')) $('#dlg').close(); });
  $('#theme').addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
  });
  render();
})();
</script>
</body>
</html>
`;
