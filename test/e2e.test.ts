import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodePipeline } from '../src/capture/anonymize.js';
import { launchBrowser } from '../src/capture/browser.js';
import { crawl, discoveredFlows } from '../src/capture/discover.js';
import { runCapture } from '../src/capture/runner.js';
import { loadWorkspace, type Workspace } from '../src/config/load.js';
import { buildGallery } from '../src/gallery/build.js';
import { exportScreens } from '../src/library/export.js';
import { Library } from '../src/library/store.js';
import { createServer } from '../src/mcp/server.js';
import { silentLogger } from '../src/util/log.js';
import { startMockServer } from './fixtures/mock-app/server.js';
import { chromiumPath, login, makeWorkspace } from './helpers.js';

let mock: Awaited<ReturnType<typeof startMockServer>>;
let root: string;
let ws: Workspace;

beforeAll(async () => {
  if (!process.env.SCRN_CHROMIUM_PATH && chromiumPath()) process.env.SCRN_CHROMIUM_PATH = chromiumPath();
  mock = await startMockServer();
  process.env.MOCK_URL = mock.url;
  root = makeWorkspace();
  await login(root, mock.url);
  ws = loadWorkspace({ root });
});

afterAll(async () => {
  await mock?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const alpha = async (file: string, x: number, y: number) => {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return data[(y * info.width + x) * 4 + 3];
};

describe('capture → library (mock app)', () => {
  it('captures every flow at Retina, anonymized, with variants and sections', async () => {
    const { run, results } = await runCapture(ws, { log: silentLogger });
    expect(run.stats.failed).toBe(0);
    expect(run.stats.added).toBe(7);

    const library = Library.open(ws.paths.library);
    const dash = library.get('mock.desktop.executive-summary.dashboard')!;
    expect(dash.files.default).toMatchObject({ path: 'mock/desktop/executive-summary/01-dashboard.png', width: 2560, height: 1440 });
    expect(dash.overflow).toBe(true);
    expect(dash.files.full!.height).toBeGreaterThan(1440);
    expect(dash.sections.map((s) => s.section)).toEqual(['kpi-card', 'kpi-grid']);

    const mobile = library.get('mock.mobile.inspectors.list')!;
    expect(mobile.files.default).toMatchObject({ width: 1179, height: 2556 });

    // .clear: app background transparent, cards opaque; sections: transparent corners
    const clear = library.abs(dash.files.clear!.path);
    expect(await alpha(clear, 1500, 130)).toBeLessThan(10); // main padding above the title (backdrop)
    expect(await alpha(clear, 200, 600)).toBe(255); // sidebar keeps its fill
    const card = library.abs(dash.sections[0].file.path);
    expect(await alpha(card, 0, 0)).toBe(0);

    // Guard: the page with a blocklisted codename never reaches the library
    expect(results.find((r) => r.id === 'mock.desktop.secret.roadmap')?.outcome).toBe('unsafe');
    expect(library.get('mock.desktop.secret.roadmap')).toBeUndefined();
    expect(fs.existsSync(path.join(ws.paths.state, 'quarantine', 'mock.desktop.secret.roadmap.png'))).toBe(true);

    // Nothing sensitive leaks into the searchable text either
    const pipe = createNodePipeline(ws.dictionary);
    for (const s of library.index.screens) {
      expect(s.text).not.toMatch(/Shcheblykin|Varvara|MOMRA|Balady|axionx\.ai|123 4567/);
      // Format-preserving fakes (phones, ids) look like real numbers to a fresh pipeline — the engine syncs
      // the generated set, here we only assert literal blocklist terms and e-mails.
      expect(pipe.scan(s.text ?? '').filter((v) => !/^(phone|national-id|iban)/.test(v))).toEqual([]);
    }
    expect(dash.text).toContain('@example.com');
    // /api/me matches two network rules: both apply (anonymize + merge)
    expect(dash.text).toContain('Axion Demo City');

    // Navigation stays readable even though "[class*='plate' i]" also matches its collapsible group
    const planning = library.get('mock.desktop.inspectors.list')!;
    expect(planning.text).toContain('Inspectors');
    const inspectorsText = planning.text ?? '';
    expect(inspectorsText).not.toContain('ABC 1234'); // the real plate is still scrambled
    expect(inspectorsText).not.toMatch(/Ahmed|Al-Qahtani/);
  });

  it('stores editable SVG twins: text as text, anonymized, no URLs or debug attributes', async () => {
    const library = Library.open(ws.paths.library);
    const dash = library.get('mock.desktop.executive-summary.dashboard')!;
    expect(dash.files.svg).toMatchObject({ path: 'mock/desktop/executive-summary/01-dashboard.svg', width: 1280, height: 720 });
    expect(dash.files.clearSvg?.path).toBe('mock/desktop/executive-summary/01-dashboard.clear.svg');
    expect(dash.files.cardsSvg?.path).toBe('mock/desktop/executive-summary/01-dashboard.cards.svg');
    expect(dash.files.fullSvg?.height).toBeGreaterThan(720);
    expect(dash.sections.every((x) => x.svg?.path.endsWith('.svg'))).toBe(true);

    const svg = fs.readFileSync(library.abs(dash.files.svg!.path), 'utf8');
    expect(svg).toContain('<text');
    expect(svg).toContain('Executive summary');
    expect(svg).toMatch(/<image[^>]+xlink:href="data:image\/png;base64,/); // the canvas chart, as a raster patch
    expect(svg).toContain('filter="url(#shadow'); // KPI card shadows
    expect(svg).not.toMatch(/Shcheblykin|Varvara|MOMRA|Balady|axionx\.ai|127\.0\.0\.1|data-stacking|aria-|<a /);
    // The Axion mark replaced the client logo — inlined as vector shapes
    expect(svg).toContain('M116.884 91.8565');

    // cards: chrome gone, viewBox trimmed to the content
    const cards = fs.readFileSync(library.abs(dash.files.cardsSvg!.path), 'utf8');
    expect(cards).not.toMatch(/Log out|Assistant|Planning/); // sidebar items
    const vb = /viewBox="([^"]+)"/.exec(cards)![1].split(' ').map(Number);
    expect(vb[0]).toBeGreaterThan(200); // sidebar (220px) is not part of it
    expect(vb[2]).toBeLessThan(1280);
  });

  it('does not create versions for unchanged screens and does for changed data', async () => {
    const again = await runCapture(ws, { targets: [{ product: 'mock', flow: 'executive-summary' }], platforms: ['desktop'], log: silentLogger });
    expect(again.results[0]).toMatchObject({ outcome: 'unchanged', version: 1 });

    mock.setVersion(2);
    const changed = await runCapture(ws, { targets: [{ product: 'mock', flow: 'executive-summary' }], platforms: ['desktop'], log: silentLogger });
    expect(changed.results[0]).toMatchObject({ outcome: 'changed', version: 2 });
    mock.setVersion(1);
  });

  it('walks the app like a person: collapsed groups, href-less items, tabs, panels, details — never a destructive click', async () => {
    const browser = await launchBrowser(ws.config);
    try {
      const found = await crawl(ws, browser, ws.products[0], { env: 'stage', log: silentLogger });
      const flows = discoveredFlows(found, ['desktop']);
      const byId = Object.fromEntries(flows.map((f) => [f.id, f]));
      expect(Object.keys(byId).sort()).toEqual(['_inspectors', '_planning', '_reports']);

      // The collapsed "Planning" group becomes a flow of its own, with tab and panel states
      expect(byId._planning.name).toBe('Planning');
      expect(byId._planning.steps.map((x) => x.name)).toEqual([
        'Inspections & schedule',
        'Inspections & schedule · List',
        'Inspections & schedule · Map',
        'Inspections & schedule · Filters',
        'Templates',
      ]);
      expect(byId._planning.steps[1]).toMatchObject({ id: 'planning-schedule-tab-list', url: '/planning/schedule' });
      // A menu item without href (click handler only) is found by clicking it
      expect(byId._reports.steps.map((x) => x.url)).toEqual(['/reports']);
      // Detail page behind a table link (curated list itself is not repeated) + its tab; names are anonymized
      expect(byId._inspectors.steps.map((x) => x.url)).toEqual(['/inspectors/i1', '/inspectors/i1']);
      expect(byId._inspectors.steps.map((x) => x.name).join(' ')).not.toMatch(/Ahmed|Qahtani/);
      expect(byId._inspectors.steps[1].name).toMatch(/· Violations$/);
      // Delete / Approve / Reject were never pressed
      expect(mock.dangerousClicks()).toEqual([]);

      const { results } = await runCapture(ws, {
        targets: [{ product: 'mock' }],
        extraFlows: flows.map((flow) => ({ product: 'mock', flow })),
        onlyExtra: true,
        platforms: ['desktop'],
        browser,
        log: silentLogger,
      });
      expect(results.length).toBe(8);
      expect(results.every((r) => r.outcome === 'added')).toBe(true);
      const library = Library.open(ws.paths.library);
      const list = library.get('mock.desktop._planning.planning-schedule-tab-list')!;
      expect(list.files.default.path).toBe('mock/desktop/_planning/planning-schedule-tab-list.png');
      expect(list.title).toBe('Inspections & schedule · List');
      expect(list.text).toContain('North zone'); // the List tab is what got captured
      expect(library.get('mock.desktop._planning.planning-schedule-panel-filters')!.text).toContain('Zone · Inspector · Date');
      // section names stay readable on every screen, the plate on the detail page does not
      const detail = library.get('mock.desktop._inspectors.inspectors-id')!;
      expect(detail.text).toMatch(/Planning[\s\S]*Reports/);
      // …including the items of the open "Planning" group (its container matches [class*='plate' i])
      expect(list.text).toContain('Inspections & schedule\nTemplates');
      expect(detail.text).not.toContain('ABC 1234');
      library.rebuildFlows(ws.products);
      expect(library.index.flows.find((f) => f.id === 'mock.desktop._planning')?.steps).toHaveLength(5);
      expect(mock.dangerousClicks()).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('exports presentation variants with human-readable names', async () => {
    const library = Library.open(ws.paths.library);
    const out = path.join(root, 'exports-test');
    const dash = 'mock.desktop.executive-summary.dashboard';
    const files = [
      ...(await exportScreens(library, { ids: [dash], variant: 'framed', background: 'blur', outDir: out })),
      ...(await exportScreens(library, { ids: [dash], variant: 'cards', outDir: out })),
      ...(await exportScreens(library, { ids: [dash], variant: 'layers', outDir: out })),
      ...(await exportScreens(library, { ids: [`${dash}--kpi-card`], variant: 'framed', outDir: out })),
      ...(await exportScreens(library, { ids: [dash], variant: 'default', scale: 1, outDir: out })),
      ...(await exportScreens(library, { ids: [dash], variant: 'clear', format: 'svg', outDir: out })),
      ...(await exportScreens(library, { ids: [dash], variant: 'framed', format: 'svg', outDir: out })),
      ...(await exportScreens(library, { ids: [dash], variant: 'default', format: 'svg', svgMode: 'raster', outDir: out })),
      ...(await exportScreens(library, { ids: ['mock.mobile.inspectors.list'], variant: 'default', scale: 2, outDir: out })),
    ];
    expect(files.map((f) => path.basename(f.file))).toEqual([
      'Mock App · Executive summary · 01 Dashboard (desktop, en, framed)@2x.png',
      'Mock App · Executive summary · 01 Dashboard (desktop, en, cards)@2x.png',
      'Mock App · Executive summary · 01 Dashboard (desktop, en, layers).svg',
      'Mock App · Executive summary · 01 Dashboard — KPI card (desktop, en, framed)@2x.png',
      'Mock App · Executive summary · 01 Dashboard (desktop, en).png',
      'Mock App · Executive summary · 01 Dashboard (desktop, en, clear).svg',
      'Mock App · Executive summary · 01 Dashboard (desktop, en, framed).svg',
      'Mock App · Executive summary · 01 Dashboard (desktop, en, raster).svg',
      'Mock App · Inspectors · 01 Inspectors (mobile, en)@2x.png',
    ]);
    expect(fs.readFileSync(files[2].file, 'utf8')).toContain('<g id="content-no-background">');
    expect((await sharp(files[4].file).metadata()).width).toBe(1280); // 1x of a 1280×720 viewport
    expect((await sharp(files[8].file).metadata()).width).toBe(786); // iPhone 393 pt × 2
    const framed = fs.readFileSync(files[6].file, 'utf8');
    expect(framed).toContain('mask="url(#frame-mask)"');
    expect(framed).toContain('<text'); // still editable inside the frame
    expect(fs.readFileSync(files[7].file, 'utf8')).toContain('xlink:href="data:image/png;base64,');
    // asking for more pixels than were captured is capped, and said so
    const [capped] = await exportScreens(library, { ids: [dash], variant: 'default', scale: 3, outDir: out });
    expect(capped.scale).toBe(2);
    expect(capped.notes.join(' ')).toMatch(/@2x/);
  });

  it('serves the gallery with an export API (any scale, SVG, backgrounds)', async () => {
    const { serveLibrary } = await import('../src/cli/serve.js');
    const server = await serveLibrary(ws.paths.library, 0);
    const { port } = server.address() as import('node:net').AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    try {
      expect(await (await fetch(`${base}/api/ping`)).json()).toMatchObject({ ok: true, export: true });
      const r = await fetch(`${base}/api/export?id=mock.desktop.executive-summary.dashboard&variant=clear&format=png&scale=1`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('image/png');
      expect(r.headers.get('content-disposition')).toContain("filename*=UTF-8''Mock%20App%20%C2%B7%20Executive%20summary");
      expect((await sharp(Buffer.from(await r.arrayBuffer())).metadata()).width).toBe(1280);
      const svg = await fetch(`${base}/api/export?id=mock.desktop.executive-summary.dashboard--kpi-grid&format=svg`);
      expect(svg.headers.get('content-type')).toBe('image/svg+xml');
      expect(await svg.text()).toContain('<text');
      const bad = await fetch(`${base}/api/export?id=nope`);
      expect(bad.status).toBe(422);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('builds the gallery', () => {
    const file = buildGallery(ws, Library.open(ws.paths.library).index);
    const html = fs.readFileSync(file, 'utf8');
    expect(html).toContain('mock.desktop.executive-summary.dashboard');
    expect(html).not.toMatch(/__DATA__|__MARK__|__FAVICON__/);
    expect(html).toContain('M116.884 91.8565'); // Axion mark in the header
    expect(html).toContain('api/export?');
  });
});

describe('MCP server', () => {
  it('answers Mobbin-like searches in Russian with paths and previews', async () => {
    const server = createServer(root);
    const client = new Client({ name: 'test', version: '1.0.0' });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(
      expect.arrayContaining(['search_screens', 'search_flows', 'search_sections', 'get_screen', 'get_flow', 'list_products', 'export_screen', 'capture', 'library_status']),
    );

    const res = await client.callTool({ name: 'search_screens', arguments: { query: 'сводка KPI', limit: 1 } });
    const content = res.content as { type: string; text?: string; mimeType?: string }[];
    const json = JSON.parse(content[0].text!);
    expect(json.screens[0].id).toBe('mock.desktop.executive-summary.dashboard');
    expect(fs.existsSync(json.screens[0].files.default)).toBe(true);
    expect(content[1]).toMatchObject({ type: 'image', mimeType: 'image/webp' });

    const flows = await client.callTool({ name: 'search_flows', arguments: { brief: 'decision-card', include_images: false } });
    const fjson = JSON.parse((flows.content as { text: string }[])[0].text);
    expect(fjson.flows[0].screens.map((s: { title: string }) => s.title)).toEqual(['Queue', 'Decision card']);

    const sections = await client.callTool({ name: 'search_sections', arguments: { query: 'kpi card', limit: 1, include_images: false } });
    expect(JSON.parse((sections.content as { text: string }[])[0].text).sections[0].id).toBe('mock.desktop.executive-summary.dashboard--kpi-card');

    const status = await client.callTool({ name: 'library_status', arguments: {} });
    expect(JSON.parse((status.content as { text: string }[])[0].text).quarantine).toEqual(['mock.desktop.secret.roadmap']);
    await client.close();
  });
});
