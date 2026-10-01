import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadWorkspace } from '../src/config/load.js';
import type { ScreenRecord } from '../src/core/types.js';
import { emptyIndex, Library } from '../src/library/store.js';
import { needsTagging, tagScreens } from '../src/tagging/claude.js';
import { silentLogger } from '../src/util/log.js';
import { makeWorkspace } from './helpers.js';

/** Fake Messages API: records the request, answers with a structured-output JSON text block. */
let server: http.Server;
let requests: { url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
let root: string;
const saved = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL };

const ANSWER = {
  title: 'Сводка KPI',
  description: 'Дашборд с KPI инспекций и недельным трендом.',
  patterns: ['Dashboard', 'KPI summary'],
  elements: ['KPI card', 'Chart'],
  keywords: ['kpi', 'сводка', 'dashboard'],
  suggestedUse: ['executive-slide'],
  quality: { cutOff: false, emptyState: false, loading: false, broken: false, notes: '' },
  privacy: { flagged: true, findings: ['лицо человека на фото в правом нижнем углу'] },
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(raw) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: JSON.stringify(ANSWER) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  root = makeWorkspace();
  process.env.MOCK_URL = 'http://127.0.0.1:1';
  const lib = path.join(root, 'library');
  fs.mkdirSync(path.join(lib, 'mock/desktop/executive-summary'), { recursive: true });
  const png = await sharp({ create: { width: 64, height: 40, channels: 3, background: '#3b82f6' } }).png().toBuffer();
  fs.writeFileSync(path.join(lib, 'mock/desktop/executive-summary/01-dashboard.png'), png);
  const file = { path: 'mock/desktop/executive-summary/01-dashboard.png', width: 64, height: 40, bytes: png.length };
  const screen: ScreenRecord = {
    id: 'mock.desktop.executive-summary.dashboard',
    product: 'mock',
    platform: 'desktop',
    theme: 'default',
    locale: 'en',
    flow: 'executive-summary',
    flowName: 'Executive summary',
    step: 'dashboard',
    position: 1,
    title: 'Dashboard',
    source: 'web',
    patterns: ['Dashboard'],
    elements: ['Sidebar'],
    tags: [],
    keywords: [],
    files: { default: file, thumb: file },
    sections: [],
    viewport: { width: 32, height: 20, scale: 2 },
    overflow: false,
    version: 1,
    hash: 'abc',
    capturedAt: new Date().toISOString(),
    changedAt: new Date().toISOString(),
    status: 'ok',
    anonymization: { replacements: 0, images: 0, violations: [] },
  };
  fs.writeFileSync(path.join(lib, 'index.json'), JSON.stringify({ ...emptyIndex(), screens: [screen] }));
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  process.env.ANTHROPIC_API_KEY = saved.key;
  process.env.ANTHROPIC_BASE_URL = saved.base;
  if (!saved.key) delete process.env.ANTHROPIC_API_KEY;
  if (!saved.base) delete process.env.ANTHROPIC_BASE_URL;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Claude auto-tagging', () => {
  it('sends a vision + structured-output request with server-side fallbacks and stores the tags', async () => {
    requests = [];
    const ws = loadWorkspace({ root });
    const library = Library.open(ws.paths.library);
    expect(needsTagging(library.index.screens[0])).toBe(true);

    const result = await tagScreens(ws, library, { log: silentLogger });
    expect(result).toMatchObject({ tagged: 1, flagged: ['mock.desktop.executive-summary.dashboard'], errors: [] });

    const req = requests[0];
    expect(req.url).toMatch(/^\/v1\/messages/);
    expect(String(req.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    expect(req.body.model).toBe('claude-opus-5-5');
    expect(req.body.fallbacks).toBe('default');
    const oc = req.body.output_config as { effort: string; format: { type: string; schema: { properties: Record<string, unknown> } } };
    expect(oc.effort).toBe('low');
    expect(oc.format.type).toBe('json_schema');
    expect(Object.keys(oc.format.schema.properties)).toEqual(expect.arrayContaining(['patterns', 'elements', 'privacy']));
    const content = (req.body.messages as { content: { type: string }[] }[])[0].content;
    expect(content.map((c) => c.type)).toEqual(['image', 'text']);

    const s = library.get('mock.desktop.executive-summary.dashboard')!;
    expect(s.patterns).toEqual(['Dashboard', 'KPI summary']);
    expect(s.elements).toEqual(['Sidebar', 'KPI card', 'Chart']);
    expect(s.keywords).toContain('сводка');
    expect(s.status).toBe('review');
    expect(s.anonymization.audit?.findings).toHaveLength(1);
    expect(s.tagging).toMatchObject({ source: 'claude', hash: 'abc' });
    expect(needsTagging(s)).toBe(false);
  });
});
