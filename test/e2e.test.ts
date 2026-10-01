import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodePipeline } from '../src/capture/anonymize.js';
import { launchBrowser } from '../src/capture/browser.js';
import { crawl, discoveredFlow } from '../src/capture/discover.js';
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
  });

  it('does not create versions for unchanged screens and does for changed data', async () => {
    const again = await runCapture(ws, { targets: [{ product: 'mock', flow: 'executive-summary' }], platforms: ['desktop'], log: silentLogger });
    expect(again.results[0]).toMatchObject({ outcome: 'unchanged', version: 1 });

    mock.setVersion(2);
    const changed = await runCapture(ws, { targets: [{ product: 'mock', flow: 'executive-summary' }], platforms: ['desktop'], log: silentLogger });
    expect(changed.results[0]).toMatchObject({ outcome: 'changed', version: 2 });
    mock.setVersion(1);
  });

  it('discovers sections that are not in the catalog', async () => {
    const browser = await launchBrowser(ws.config);
    try {
      const pages = await crawl(ws, browser, ws.products[0], { env: 'stage', log: silentLogger });
      expect(pages.map((p) => p.route)).toEqual(['/decision/42']);
      const flow = discoveredFlow(pages, ['desktop'])!;
      const { results } = await runCapture(ws, {
        targets: [{ product: 'mock' }],
        extraFlows: [{ product: 'mock', flow }],
        onlyExtra: true,
        platforms: ['desktop'],
        browser,
        log: silentLogger,
      });
      expect(results).toMatchObject([{ id: 'mock.desktop._discovered.decision-42', outcome: 'added' }]);
      expect(Library.open(ws.paths.library).get('mock.desktop._discovered.decision-42')?.files.default.path).toBe(
        'mock/desktop/_discovered/decision-42.png',
      );
    } finally {
      await browser.close();
    }
  });

  it('exports presentation variants with human-readable names', async () => {
    const library = Library.open(ws.paths.library);
    const out = path.join(root, 'exports-test');
    const files = [
      ...(await exportScreens(library, { ids: ['mock.desktop.executive-summary.dashboard'], variant: 'framed', background: 'blur', outDir: out })),
      ...(await exportScreens(library, { ids: ['mock.desktop.executive-summary.dashboard'], variant: 'cards', outDir: out })),
      ...(await exportScreens(library, { ids: ['mock.desktop.executive-summary.dashboard'], variant: 'layers', outDir: out })),
      ...(await exportScreens(library, { ids: ['mock.desktop.executive-summary.dashboard--kpi-card'], variant: 'framed', outDir: out })),
    ];
    expect(files.map((f) => path.basename(f.file))).toEqual([
      'Mock App · Executive summary · 01 Dashboard (desktop, en, framed).png',
      'Mock App · Executive summary · 01 Dashboard (desktop, en, cards).png',
      'Mock App · Executive summary · 01 Dashboard (desktop, en, layers).svg',
      'Mock App · Executive summary · 01 Dashboard — KPI card (desktop, en, framed).png',
    ]);
    const svg = fs.readFileSync(files[2].file, 'utf8');
    expect(svg).toContain('<g id="content-no-background">');
  });

  it('builds the gallery', () => {
    const file = buildGallery(ws, Library.open(ws.paths.library).index);
    const html = fs.readFileSync(file, 'utf8');
    expect(html).toContain('mock.desktop.executive-summary.dashboard');
    expect(html).not.toContain('__DATA__');
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
