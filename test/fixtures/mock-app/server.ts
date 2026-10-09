/**
 * Mock of an Axion web app for end-to-end tests: SPA shell with a sidebar, inner scroll container,
 * API-driven data full of things that must never reach a published screen (real names, client
 * names, phones, e-mails, client logo), a login form and a cookie session.
 *
 * Navigation is deliberately awkward, like the real stands: a collapsible "Planning" group whose items exist
 * only while it is open (and whose container carries a Tailwind-like `transition-[grid-template-rows]` class),
 * a menu item without href, in-page tabs without URLs, a filters drawer, detail pages behind table rows and
 * destructive buttons that discovery must never press (`/__admin/danger` counts the presses).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const state = { version: 1, danger: [] as string[] };

const MOMRA_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="32"><rect width="120" height="32" rx="6" fill="#0a7d3b"/><text x="10" y="21" font-size="14" fill="#fff" font-family="Arial">MOMRA</text></svg>`;
const AVATAR = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#c0392b"/><text x="14" y="42" font-size="28" fill="#fff" font-family="Arial">AS</text></svg>`;

function api(path: string): unknown {
  switch (path) {
    case '/api/me':
      return { name: 'Alexander Shcheblykin', email: 'a.shcheblykin@axionx.ai', org: 'MOMRA Balady', role: 'ADMIN_USER' };
    case '/api/kpi':
      return {
        owner: 'Varvara Spirina',
        cards: [
          { id: 'k1', label: 'Violations detected', value: state.version === 1 ? '1,284' : '2,917' },
          { id: 'k2', label: 'Balady requests closed', value: '342' },
          { id: 'k3', label: 'Inspectors on shift', value: '57' },
          { id: 'k4', label: 'SLA (MOMRA target)', value: '93%' },
        ],
        chart: [12, 18, 9, 22, 30, 26, state.version === 1 ? 14 : 40],
        chartTitle: 'Weekly trend — Balady districts',
        status: 'BALADY_APPROVED',
      };
    case '/api/inspectors':
      return INSPECTORS;
    case '/api/templates':
      return [
        { id: 't1', title: 'Weekly inspection' },
        { id: 't2', title: 'Night shift' },
      ];
    default: {
      const m = /^\/api\/inspectors\/(\w+)$/.exec(path);
      if (m) return INSPECTORS.find((i) => i.id === m[1]) ?? null;
      return null;
    }
  }
}

const INSPECTORS = [
  { id: 'i1', name: 'Ahmed Al-Qahtani', phone: '+966 55 123 4567', plate: 'ABC 1234', zone: 'North' },
  { id: 'i2', name: 'محمد العتيبي', phone: '+966 50 765 4321', plate: 'XYZ 9876', zone: 'East' },
  { id: 'i3', name: 'Varvara Spirina', phone: '+966 54 222 3333', plate: 'KLM 5555', zone: 'West' },
];

const SHELL = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Axion Mock — MOMRA</title>
<style>
  html, body { margin: 0; height: 100%; background: #e9edf5; font-family: Arial, Helvetica, sans-serif; color: #0f172a; }
  #root { display: flex; height: 100vh; background: #e9edf5; }
  aside { width: 220px; flex: none; background: #0f172a; color: #e2e8f0; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
  aside a { color: #e2e8f0; text-decoration: none; padding: 8px 10px; border-radius: 8px; }
  aside a.active { background: #1e293b; }
  aside .user { margin-top: auto; display: flex; align-items: center; gap: 8px; font-size: 13px; }
  aside .user .avatar { width: 32px; height: 32px; border-radius: 50%; }
  .app { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  header { height: 56px; flex: none; background: #fff; display: flex; align-items: center; gap: 12px; padding: 0 20px; border-bottom: 1px solid #e2e8f0; }
  header .org-logo { height: 28px; }
  main { flex: 1; overflow: auto; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 16px; }
  #kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
  .kpi-card { background: #fff; border-radius: 16px; padding: 16px; box-shadow: 0 6px 20px rgba(15, 23, 42, 0.12); }
  .kpi-card .v { font-size: 28px; font-weight: 700; margin-top: 8px; }
  .panel { background: #fff; border-radius: 16px; padding: 16px; margin-top: 16px; }
  .tall { height: 900px; background: linear-gradient(#fff, #f1f5f9); }
  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: 10px; border-bottom: 1px solid #e2e8f0; }
  .chat .msg { max-width: 60%; padding: 10px 14px; border-radius: 14px; margin: 8px 0; background: #f1f5f9; }
  .chat .msg.me { margin-left: auto; background: #dbeafe; }
  .dialog-backdrop { position: fixed; inset: 0; background: rgba(15, 23, 42, .45); display: flex; align-items: center; justify-content: center; }
  .dialog { width: 420px; background: #fff; border-radius: 20px; padding: 24px; }
  .loader { position: fixed; top: 8px; right: 8px; }
  aside nav { display: flex; flex-direction: column; gap: 2px; }
  .nav-group-trigger, .nav-item { background: none; border: 0; color: #e2e8f0; font: inherit; text-align: left; padding: 8px 10px; border-radius: 8px; cursor: pointer; }
  .nav-sub { display: grid; grid-template-rows: 1fr; padding-left: 14px; border-left: 1px solid #334155; margin-left: 12px; }
  .nav-sub[hidden] { display: none; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
  .toolbar button, [role=tab] { font: inherit; padding: 6px 12px; border-radius: 8px; border: 1px solid #cbd5e1; background: #fff; cursor: pointer; }
  [role=tab][aria-selected=true] { background: #0f172a; color: #fff; }
  .drawer { position: fixed; top: 0; right: 0; bottom: 0; width: 320px; background: #fff; box-shadow: -8px 0 24px rgba(15, 23, 42, .2); padding: 24px; }
</style></head>
<body><div id="root">
  <aside>
    <strong>Axion</strong>
    <nav class="side-nav">
      <a href="/dashboard">Dashboard</a>
      <a href="/inspectors">Inspectors</a>
      <a href="/assistant">Assistant</a>
      <a href="/decision/42">Decisions</a>
      <a href="/secret">Secret</a>
      <div class="nav-group">
        <button type="button" class="nav-group-trigger" aria-expanded="false" aria-controls="planning-items">Planning</button>
        <div id="planning-items" class="nav-sub overflow-hidden transition-[grid-template-rows]" hidden>
          <a href="/planning/schedule">Inspections &amp; schedule</a>
          <a href="/planning/templates">Templates</a>
        </div>
      </div>
      <span class="nav-item" role="link" tabindex="0" data-to="/reports">Reports</span>
      <a href="/logout">Log out</a>
    </nav>
    <div class="user"><img class="avatar" src="/static/avatar.svg" alt="Alexander Shcheblykin"><span class="user-name" id="me">…</span></div>
  </aside>
  <div class="app">
    <header><img class="org-logo" src="/static/momra-logo.svg" alt="MOMRA Balady"><span id="org"></span><input placeholder="Search Balady records" /></header>
    <main id="main"></main>
  </div>
</div>
<div class="loader" id="loader" aria-busy="true">Loading…</div>
<script>
  const $ = (s) => document.querySelector(s);
  const j = (u) => fetch(u).then((r) => r.json());
  const danger = (what) => fetch('/__admin/danger?what=' + encodeURIComponent(what), { method: 'POST' });
  function setGroup(open) {
    $('.nav-group-trigger').setAttribute('aria-expanded', String(open));
    $('#planning-items').hidden = !open;
  }
  const TABS = {
    calendar: '<div class="panel">Calendar: 12 inspections this week</div>',
    list: '<div class="panel"><table><tr><td>North zone</td><td>Mon</td></tr><tr><td>East zone</td><td>Tue</td></tr></table></div>',
    map: '<div class="panel">Map of planned routes</div>',
    timeline: '<div class="panel">Shift started 08:00 · 14 stops</div>',
    violations: '<div class="panel">3 violations recorded</div>',
  };
  function tabs(names, selected) {
    return '<div role="tablist" class="tabs">' + names.map((n) =>
      '<button type="button" role="tab" data-tab="' + n.toLowerCase() + '" aria-selected="' + (n === selected) + '">' + n + '</button>').join('') +
      '</div><div id="tab-panel">' + TABS[selected.toLowerCase()] + '</div>';
  }
  async function render() {
    const path = location.pathname;
    document.querySelectorAll('aside a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === path));
    setGroup(path.startsWith('/planning'));
    const me = await j('/api/me');
    $('#me').textContent = me.name;
    $('#org').textContent = me.org;
    const main = $('#main');
    if (path === '/dashboard' || path === '/') {
      const k = await j('/api/kpi');
      main.innerHTML = '<h1>Executive summary</h1><div id="kpi-grid">' +
        k.cards.map((c) => '<div class="kpi-card"><div>' + c.label + '</div><div class="v">' + c.value + '</div></div>').join('') +
        '</div><div class="panel"><div>Owner: <b>' + k.owner + '</b> · status ' + k.status + '</div>' +
        '<p>Report prepared by Alexander Shcheblykin, contact a.shcheblykin@axionx.ai, +966 55 000 1122</p>' +
        '<canvas id="chart" width="900" height="220"></canvas>' +
        '<svg width="300" height="60"><text x="0" y="30">Reviewed by Varvara Spirina</text></svg></div>' +
        '<div class="panel tall">Long report body…</div>';
      const ctx = $('#chart').getContext('2d');
      ctx.fillStyle = '#3b82f6';
      k.chart.forEach((v, i) => ctx.fillRect(40 + i * 110, 200 - v * 5, 60, v * 5));
      ctx.fillStyle = '#0f172a'; ctx.font = '16px Arial'; ctx.fillText(k.chartTitle, 40, 20);
    } else if (path === '/inspectors') {
      const rows = await j('/api/inspectors');
      main.innerHTML = '<h1>Inspectors</h1><div class="panel"><table><thead><tr><th>Name</th><th>Phone</th><th>Plate</th><th>Zone</th></tr></thead><tbody>' +
        rows.map((r) => '<tr><td class="inspector-name"><a href="/inspectors/' + r.id + '">' + r.name + '</a></td><td class="phone">' + r.phone + '</td><td class="plate">' + r.plate + '</td><td>' + r.zone + '</td></tr>').join('') +
        '</tbody></table></div>';
    } else if (path.startsWith('/inspectors/')) {
      const r = await j('/api' + path);
      main.innerHTML = '<h1 class="inspector-name">' + r.name + '</h1><div class="panel">Vehicle <span class="plate">' + r.plate + '</span> · zone ' + r.zone + '</div>' +
        tabs(['Timeline', 'Violations'], 'Timeline');
    } else if (path === '/planning/schedule') {
      main.innerHTML = '<h1>Inspections &amp; schedule</h1><div class="toolbar"><button type="button" id="filters">Filters</button>' +
        '<button type="button" id="delete">Delete plan</button></div>' + tabs(['Calendar', 'List', 'Map'], 'Calendar');
    } else if (path === '/planning/templates') {
      const t = await j('/api/templates');
      main.innerHTML = '<h1>Templates</h1><div class="panel template-list">' + t.map((x) => '<div class="template-card">' + x.title + '</div>').join('') + '</div>';
    } else if (path === '/reports') {
      main.innerHTML = '<h1>Reports</h1><div class="panel">Monthly report · 4 sections</div>';
    } else if (path === '/assistant') {
      main.innerHTML = '<h1>Assistant</h1><div class="panel chat">' +
        '<div class="msg me">Show MOMRA violations for this week</div>' +
        '<div class="msg">According to Balady data, violations grew 12%. Escalated to Varvara Spirina.</div></div>';
    } else if (path.startsWith('/decision/')) {
      main.innerHTML = '<h1>Decisions</h1><div class="panel">Queue</div>' +
        '<div class="dialog-backdrop"><div class="dialog" role="dialog" aria-modal="true"><h2>Fine 500 SAR?</h2>' +
        '<p>Violation by Ahmed Al-Qahtani, vehicle ABC 1234.</p><button>Approve</button> <button>Reject</button></div></div>';
    } else if (path === '/secret') {
      main.innerHTML = '<h1>Roadmap</h1><div class="panel">Project Codename Falcon launches next week.</div>';
    } else {
      main.innerHTML = '<h1>Not found</h1>';
    }
    setTimeout(() => $('#loader')?.remove(), 300);
  }
  const go = (to) => { history.pushState({}, '', to); render(); };
  document.addEventListener('click', (e) => {
    const t = e.target;
    const a = t.closest('a');
    if (a && a.getAttribute('href') && !a.getAttribute('href').startsWith('/logout')) {
      e.preventDefault();
      go(a.getAttribute('href'));
      return;
    }
    const item = t.closest('[data-to]');
    if (item) return go(item.dataset.to);
    if (t.closest('.nav-group-trigger')) return setGroup($('.nav-group-trigger').getAttribute('aria-expanded') !== 'true');
    const tab = t.closest('[role=tab]');
    if (tab) {
      tab.parentElement.querySelectorAll('[role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x === tab)));
      $('#tab-panel').innerHTML = TABS[tab.dataset.tab];
      return;
    }
    if (t.closest('#filters')) {
      document.body.insertAdjacentHTML('beforeend', '<div class="drawer" role="dialog" aria-label="Filters"><h2>Filters</h2><p>Zone · Inspector · Date</p></div>');
      return;
    }
    if (t.closest('#delete')) return danger('delete plan');
    const b = t.closest('button');
    if (b && /approve|reject/i.test(b.textContent)) return danger(b.textContent.trim());
  });
  window.addEventListener('popstate', render);
  render();
</script></body></html>`;

const LOGIN = `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title></head><body>
<form method="post" action="/login"><input name="user" placeholder="user"><input name="password" type="password"><button>Sign in</button></form>
</body></html>`;

function authed(req: http.IncomingMessage): boolean {
  return /(?:^|;\s*)sid=ok(?:;|$)/.test(req.headers.cookie ?? '');
}

export function createMockServer(): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    if (p === '/__admin/version') {
      state.version = Number(url.searchParams.get('v') ?? 1);
      res.end('ok');
      return;
    }
    if (p === '/__admin/danger') {
      if (req.method === 'POST') state.danger.push(url.searchParams.get('what') ?? '?');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state.danger));
      return;
    }
    if (p === '/login' && req.method === 'POST') {
      res.writeHead(302, { 'set-cookie': 'sid=ok; Path=/; HttpOnly', location: '/dashboard' });
      res.end();
      return;
    }
    if (p === '/login') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(LOGIN);
      return;
    }
    if (p === '/logout') {
      res.writeHead(302, { 'set-cookie': 'sid=; Path=/; Max-Age=0', location: '/login' });
      res.end();
      return;
    }
    if (p.startsWith('/static/')) {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end(p.endsWith('avatar.svg') ? AVATAR : MOMRA_LOGO);
      return;
    }
    if (!authed(req)) {
      if (p.startsWith('/api/')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"unauthorized"}');
      } else {
        res.writeHead(302, { location: '/login' });
        res.end();
      }
      return;
    }
    if (p.startsWith('/api/')) {
      const data = api(p);
      res.writeHead(data === null ? 404 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SHELL);
  });
}

export async function startMockServer(
  port = 0,
): Promise<{ url: string; close: () => Promise<void>; setVersion: (v: number) => void; dangerousClicks: () => string[] }> {
  const server = createMockServer();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: actual } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${actual}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    setVersion: (v) => {
      state.version = v;
    },
    dangerousClicks: () => [...state.danger],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4580);
  startMockServer(port).then((s) => console.log(`mock app: ${s.url} (login: any user/password)`));
}
