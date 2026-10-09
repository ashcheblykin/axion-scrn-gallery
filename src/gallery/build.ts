import fs from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../config/load.js';
import { axionFavicon, axionMarkSvg } from '../core/brand.js';
import { DEFAULT_THEME } from '../core/naming.js';
import type { LibraryIndex } from '../core/types.js';

/**
 * Static Mobbin-like gallery: library/index.html with the catalog embedded — open it from disk or
 * via `scrn serve`. Thumbnails live in plain git, so the grid works even before `git lfs pull`.
 * Opened through `scrn serve`, the export panel can hand out any scale, vector or raster SVG and slide
 * backgrounds (/api/export); from disk it links the files that already exist.
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
        sections: s.sections.map((x) => ({ id: x.id, name: x.name, file: x.file, svg: x.svg })),
        // File names are built in the page the same way humanFileName does (variant, scale, section).
        name: {
          product: productNames.get(s.product) ?? s.product,
          flow: s.flowName,
          nn: String(s.position).padStart(2, '0'),
          title: s.title,
          quals: [s.platform, ...(s.theme !== DEFAULT_THEME ? [s.theme] : []), s.locale],
        },
      })),
  };
}

export function buildGallery(ws: Workspace, index: LibraryIndex): string {
  const data = JSON.stringify(galleryData(ws, index)).replace(/</g, '\\u003c');
  const html = TEMPLATE.replace('__FAVICON__', axionFavicon())
    .replace('__MARK__', axionMarkSvg('currentColor', 'class="mark" aria-hidden="true"'))
    .replace('__DATA__', () => data);
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
<link rel="icon" href="__FAVICON__">
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
  .brand { font-weight: 700; font-size: 16px; margin-right: 8px; display: inline-flex; align-items: center; gap: 8px; }
  .brand .mark { height: 18px; width: auto; display: block; }
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
  .viewer { display: grid; grid-template-columns: minmax(0, 1fr) 344px; max-height: 94vh; }
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
  .export { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--line); border-radius: 12px; }
  .export h3 { margin: 0; font-size: 13px; }
  .ex-row { display: grid; gap: 5px; }
  .ex-row > span { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .opts { display: flex; flex-wrap: wrap; gap: 4px; }
  .opt { background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 4px 9px; font: inherit; font-size: 12px; cursor: pointer; }
  .opt[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
  .opt:disabled { opacity: .4; cursor: not-allowed; }
  .ex-file { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
  .ex-note { font-size: 12px; color: var(--warn); }
  .btn[aria-disabled="true"] { opacity: .45; pointer-events: none; }
  @media (max-width: 860px) { .viewer { grid-template-columns: 1fr; } .side { border-left: 0; border-top: 1px solid var(--line); } }
</style>
</head>
<body>
<header>
  <div class="bar">
    <span class="brand">__MARK__Axion Screens</span>
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
        '<section class="flow"><h3>' + esc(productName(f.product)) + ' · ' + esc(f.name) + ' <span class="meta">' + esc(f.platform) + ' · ' + screens.length + ' экр.' + (f.brief ? ' · бриф: ' + esc(briefName(f.brief)) : '') + ((f.tags || []).includes('auto') ? ' · из обхода разделов' : '') + '</span></h3>' +
        (f.description ? '<div class="meta">' + esc(f.description) + '</div>' : '') +
        '<div class="strip">' + screens.map(card).join('') + '</div></section>').join('');
    }
  };

  // ---------------------------------------------------------------------------
  // Viewer + export panel
  // ---------------------------------------------------------------------------
  const VARIANTS = [['default', 'С фоном'], ['clear', 'Без фона'], ['cards', 'Только плашки'], ['full', 'Вся страница'], ['framed', 'На подложке']];
  const BACKGROUNDS = [['gradient', 'Градиент'], ['blur', 'Размытие'], ['white', 'Белая'], ['black', 'Чёрная'], ['transparent', 'Прозрачная']];
  const SVG_TWIN = { default: 'svg', clear: 'clearSvg', cards: 'cardsSvg', full: 'fullSvg' };
  const ex = { format: 'png', scale: 2, svg: 'vector', bg: 'gradient' };
  try { Object.assign(ex, JSON.parse(localStorage.getItem('scrn-export') || '{}')); } catch (e) {}
  const saveEx = () => { try { localStorage.setItem('scrn-export', JSON.stringify(ex)); } catch (e) {} };
  let api = false;
  let cur = null; // { s, section, variant }

  // scrn serve answers /api/ping; a page opened from disk cannot compute exports.
  fetch('api/ping', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j) => { api = !!(j && j.export); if (cur) side(); }).catch(() => {});

  const rasterFile = (s, section, variant) => section ? section.file : variant === 'cards' ? (s.files.cards || s.files.clear) : variant === 'framed' ? s.files.default : s.files[variant];
  const vectorFile = (s, section, variant) => section ? section.svg : variant === 'framed' ? s.files.svg : s.files[SVG_TWIN[variant]];
  const fileName = (s, section, variant, ext, scale, raster) => {
    const quals = [...s.name.quals];
    const v = section ? (variant === 'framed' ? 'framed' : 'section') : variant;
    if (v !== 'default') quals.push(v);
    if (raster) quals.push('raster');
    const at = scale && scale !== 1 ? '@' + scale + 'x' : '';
    const title = section ? s.name.title + ' — ' + section.name : s.name.title;
    return (s.name.product + ' · ' + s.name.flow + ' · ' + s.name.nn + ' ' + title + ' (' + quals.join(', ') + ')' + at + '.' + ext).replace(/[\\/\\\\:*?"<>|]+/g, '-');
  };
  const exportUrl = (s, section, variant, extra) => {
    const q = new URLSearchParams({ id: section ? section.id : s.id, variant: section && variant !== 'framed' ? 'default' : variant, format: ex.format });
    if (ex.format === 'png') q.set('scale', String(ex.scale));
    else q.set('svg', ex.svg);
    if (variant === 'framed') q.set('bg', ex.bg);
    for (const [k, v] of Object.entries(extra || {})) q.set(k, String(v));
    return 'api/export?' + q.toString();
  };

  const showImage = (src, fallback) => {
    const img = $('#dlg-img');
    img.onerror = () => { img.onerror = null; if (fallback) img.src = fallback; };
    img.src = src;
  };

  const preview = () => {
    const { s, section, variant } = cur;
    if (variant === 'framed' && api) return showImage(exportUrl(s, section, 'framed', { format: 'png', scale: 1, inline: 1 }), s.files.thumb.path);
    const f = rasterFile(s, section, variant);
    showImage(f ? f.path : s.files.default.path, s.files.thumb.path);
  };

  const opt = (group, value, label, pressed, disabled, title) =>
    '<button type="button" class="opt" data-g="' + group + '" data-v="' + esc(value) + '" aria-pressed="' + pressed + '"' + (disabled ? ' disabled' : '') + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(label) + '</button>';

  const exportPanel = () => {
    const { s, section, variant } = cur;
    const native = Math.max(1, Math.floor(s.viewport.scale));
    const scales = Array.from({ length: native }, (_, i) => i + 1);
    if (!scales.includes(ex.scale)) ex.scale = Math.min(2, native);
    const variants = section ? [['default', 'Плашка'], ['framed', 'На подложке']] : VARIANTS.filter(([k]) => k === 'framed' || (k === 'cards' ? s.files.cards || s.files.clear : s.files[k]));
    const vector = vectorFile(s, section, variant);
    const staticOnly = !api;
    // From disk only existing files can be handed out: native PNG, captured SVG.
    const canFramed = api;
    const svgOk = api || !!vector;
    if (ex.format === 'svg' && !svgOk) ex.format = 'png';
    const svgMode = ex.format === 'svg' && !api ? 'vector' : ex.svg;
    let href = '';
    let name = '';
    let dims = '';
    const r = rasterFile(s, section, variant);
    if (ex.format === 'png') {
      const k = ex.scale / s.viewport.scale;
      dims = variant === 'framed' ? '' : r ? Math.round(r.width * k) + '×' + Math.round(r.height * k) + ' px' : '';
      name = fileName(s, section, variant, 'png', ex.scale, false);
      href = api ? exportUrl(s, section, variant) : ex.scale === native && variant !== 'framed' && r ? r.path : '';
    } else {
      const raster = svgMode === 'raster' || !vector;
      name = fileName(s, section, variant, 'svg', 0, raster && (api || !vector));
      dims = vector && variant !== 'framed' ? vector.width + '×' + vector.height + ' pt' : '';
      href = api ? exportUrl(s, section, variant) : vector && variant !== 'framed' ? vector.path : '';
    }
    const notes = [];
    if (ex.format === 'svg' && !vector) notes.push('Векторной версии ещё нет (экран снят до SVG) — будет картинка внутри SVG. Пересними экран.');
    if (staticOnly) notes.push('Масштабы кроме @' + native + 'x, подложки и растровый SVG — в галерее через ./scrn serve.');
    return '<section class="export"><h3>Экспорт</h3>' +
      '<div class="ex-row"><span>Вариант</span><div class="opts">' + variants.map(([k, label]) => opt('variant', k, label, variant === k, k === 'framed' && !canFramed, k === 'framed' && !canFramed ? 'Нужен ./scrn serve' : '')).join('') + '</div></div>' +
      '<div class="ex-row"><span>Формат</span><div class="opts">' + opt('format', 'png', 'PNG', ex.format === 'png') + opt('format', 'svg', 'SVG', ex.format === 'svg', !svgOk, svgOk ? '' : 'Нет векторной версии') + '</div></div>' +
      (ex.format === 'png'
        ? '<div class="ex-row"><span>Масштаб</span><div class="opts">' + scales.map((n) => opt('scale', String(n), n + 'x', ex.scale === n, staticOnly && n !== native, staticOnly && n !== native ? 'Нужен ./scrn serve' : '')).join('') + '</div></div>'
        : '<div class="ex-row"><span>SVG</span><div class="opts">' + opt('svg', 'vector', 'Вектор', svgMode === 'vector', !vector && !api, 'Редактируемый текст и фигуры — для Figma') + opt('svg', 'raster', 'Растр', svgMode === 'raster', staticOnly, 'Пиксель в пиксель: PNG внутри SVG') + '</div></div>') +
      (variant === 'framed' ? '<div class="ex-row"><span>Подложка</span><div class="opts">' + BACKGROUNDS.map(([k, label]) => opt('bg', k, label, ex.bg === k)).join('') + '</div></div>' : '') +
      '<div class="actions"><a class="btn" id="ex-download"' + (href ? ' href="' + esc(href) + '" download="' + esc(name) + '"' : ' aria-disabled="true"') + '>⬇ Скачать ' + (ex.format === 'png' ? 'PNG @' + ex.scale + 'x' : 'SVG') + '</a></div>' +
      '<div class="ex-file">' + esc(name) + (dims ? ' · ' + dims : '') + '</div>' +
      notes.map((n) => '<div class="ex-note">' + esc(n) + '</div>').join('') +
      (s.sections.length ? '<div class="ex-row"><span>Плашки</span><div class="opts">' + (section ? opt('target', '', '← Весь экран', false) : '') + s.sections.map((x) => opt('target', x.id, x.name, !!section && section.id === x.id)).join('') + '</div></div>' : '') +
      '</section>';
  };

  const side = () => {
    const { s } = cur;
    $('#dlg-side').innerHTML =
      '<h2>' + esc(s.title) + '</h2><div class="meta">' + esc(productName(s.product)) + ' · ' + esc(s.flowName) + ' · шаг ' + s.position + '</div>' +
      (s.description ? '<div>' + esc(s.description) + '</div>' : '') +
      (s.findings.length ? '<div class="badge bad">Privacy: ' + esc(s.findings.join('; ')) + '</div>' : '') +
      exportPanel() +
      '<dl class="kv">' +
      '<dt>id</dt><dd>' + esc(s.id) + '</dd>' +
      '<dt>Платформа</dt><dd>' + esc(s.platform) + ' · ' + s.viewport.width + '×' + s.viewport.height + ' @' + s.viewport.scale + 'x</dd>' +
      '<dt>Паттерны</dt><dd>' + esc(s.patterns.join(', ') || '—') + '</dd>' +
      '<dt>Элементы</dt><dd>' + esc(s.elements.join(', ') || '—') + '</dd>' +
      '<dt>Теги</dt><dd>' + esc([...s.tags, ...(s.keywords || [])].join(', ') || '—') + '</dd>' +
      '<dt>Маршрут</dt><dd>' + esc(s.route || '—') + '</dd>' +
      '<dt>Версия</dt><dd>v' + s.version + ' · изменён ' + new Date(s.changedAt).toLocaleDateString('ru-RU') + ' · проверен ' + new Date(s.capturedAt).toLocaleDateString('ru-RU') + '</dd>' +
      '</dl>';
  };

  $('#dlg-side').addEventListener('click', (e) => {
    const b = e.target.closest('.opt');
    if (!b || b.disabled || !cur) return;
    const v = b.dataset.v;
    switch (b.dataset.g) {
      case 'variant': cur.variant = v; break;
      case 'format': ex.format = v; break;
      case 'scale': ex.scale = Number(v); break;
      case 'svg': ex.svg = v; break;
      case 'bg': ex.bg = v; break;
      case 'target': cur.section = cur.s.sections.find((x) => x.id === v) || null; cur.variant = 'default'; break;
    }
    saveEx();
    side();
    if (b.dataset.g === 'variant' || b.dataset.g === 'target' || (cur.variant === 'framed' && b.dataset.g === 'bg')) preview();
  });

  const open = (id) => {
    const s = D.screens.find((x) => x.id === id);
    if (!s) return;
    cur = { s, section: null, variant: 'default' };
    side();
    preview();
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
