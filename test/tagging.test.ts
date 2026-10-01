import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import sharp from 'sharp';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkspace } from '../src/config/load.js';
import type { ScreenRecord } from '../src/core/types.js';
import { emptyIndex, Library } from '../src/library/store.js';
import { createServer } from '../src/mcp/server.js';
import { tagWithApi } from '../src/tagging/api.js';
import { headlessArgs, TAGGING_TOOLS } from '../src/tagging/claude-code.js';
import { runTagging } from '../src/tagging/run.js';
import { needsTagging } from '../src/tagging/tags.js';
import { silentLogger } from '../src/util/log.js';
import { makeWorkspace } from './helpers.js';

const ROOT = path.resolve(import.meta.dirname, '..');

const TAGS = {
  title: 'Сводка KPI',
  description: 'Дашборд с KPI инспекций и недельным трендом.',
  patterns: ['Dashboard', 'KPI summary'],
  elements: ['KPI card', 'Chart'],
  keywords: ['kpi', 'сводка', 'dashboard'],
  suggestedUse: ['executive-slide'],
  quality: { cutOff: false, emptyState: false, loading: false, broken: false, notes: '' },
  privacy: { flagged: true, findings: ['лицо человека на фото в правом нижнем углу'] },
};

const roots: string[] = [];

/** A workspace with two tiny screens in the library and no browser involved. */
async function libraryWorkspace(): Promise<string> {
  const root = makeWorkspace();
  roots.push(root);
  process.env.MOCK_URL = 'http://127.0.0.1:1';
  const lib = path.join(root, 'library');
  const png = await sharp({ create: { width: 64, height: 40, channels: 3, background: '#3b82f6' } }).png().toBuffer();
  const screens = ['dashboard', 'inspectors'].map((step, i): ScreenRecord => {
    const rel = `mock/desktop/flow/0${i + 1}-${step}.png`;
    fs.mkdirSync(path.dirname(path.join(lib, rel)), { recursive: true });
    fs.writeFileSync(path.join(lib, rel), png);
    const file = { path: rel, width: 64, height: 40, bytes: png.length };
    return {
      id: `mock.desktop.flow.${step}`,
      product: 'mock',
      platform: 'desktop',
      theme: 'default',
      locale: 'en',
      flow: 'flow',
      flowName: 'Flow',
      step,
      position: i + 1,
      title: step,
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
      hash: `hash-${step}`,
      capturedAt: new Date().toISOString(),
      changedAt: new Date().toISOString(),
      status: 'ok',
      anonymization: { replacements: 0, images: 0, violations: [] },
    };
  });
  fs.writeFileSync(path.join(lib, 'index.json'), JSON.stringify({ ...emptyIndex(), screens }));
  return root;
}

const saved = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL, path: process.env.SCRN_CLAUDE_PATH };
beforeEach(() => {
  delete process.env.SCRN_TAG_IDS;
  delete process.env.SCRN_TAG_ALL;
  delete process.env.SCRN_TAG_LIMIT;
});
afterAll(() => {
  for (const [k, v] of [
    ['ANTHROPIC_API_KEY', saved.key],
    ['ANTHROPIC_BASE_URL', saved.base],
    ['SCRN_CLAUDE_PATH', saved.path],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe('tagging by Claude Code through MCP (no API key)', () => {
  it('hands out a queue with previews and stores what the agent saves', async () => {
    const root = await libraryWorkspace();
    const client = new Client({ name: 'test', version: '1.0.0' });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([createServer(root).connect(s), client.connect(c)]);

    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['tagging_queue', 'save_tags']));
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toContain('tag_new_screens');

    const queue = await client.callTool({ name: 'tagging_queue', arguments: { limit: 1 } });
    const content = queue.content as { type: string; text?: string }[];
    const json = JSON.parse(content[0].text!);
    expect(json.remaining).toBe(2);
    expect(json.batch).toEqual([expect.objectContaining({ id: 'mock.desktop.flow.dashboard', hash: 'hash-dashboard' })]);
    expect(json.rules).toContain('Privacy-аудит');
    expect(content[1].type).toBe('image');

    // The schema rejects terms outside the taxonomy
    const bad = await client.callTool({ name: 'save_tags', arguments: { items: [{ ...TAGS, id: 'mock.desktop.flow.dashboard', patterns: ['Made up'] }] } });
    expect(bad.isError).toBe(true);

    const res = await client.callTool({
      name: 'save_tags',
      arguments: { items: [{ ...TAGS, id: 'mock.desktop.flow.dashboard', hash: 'hash-dashboard' }, { ...TAGS, id: 'mock.desktop.flow.inspectors', hash: 'stale' }] },
    });
    const out = JSON.parse((res.content as { text: string }[])[0].text);
    expect(out).toMatchObject({ saved: ['mock.desktop.flow.dashboard'], flagged: ['mock.desktop.flow.dashboard'], stale: ['mock.desktop.flow.inspectors'], remaining: 1 });

    const lib = Library.open(path.join(root, 'library'));
    const screen = lib.get('mock.desktop.flow.dashboard')!;
    expect(screen.tagging).toMatchObject({ source: 'claude-code', hash: 'hash-dashboard' });
    expect(screen.status).toBe('review');
    expect(screen.elements).toEqual(['Sidebar', 'KPI card', 'Chart']);
    expect(needsTagging(screen)).toBe(false);
    expect(fs.existsSync(path.join(root, 'library', 'index.html'))).toBe(true);
    await client.close();
  });

  it('runs headless `claude -p` with only the two tagging tools, and the run tags the library', async () => {
    const root = await libraryWorkspace();
    // A stand-in for the Claude Code CLI: checks the flags, then talks to our MCP server like the agent would.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'scrn-claude-'));
    roots.push(bin);
    const sdk = (p: string) => pathToFileURL(path.join(ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm', p)).href;
    const fake = path.join(bin, 'claude');
    fs.writeFileSync(
      fake,
      `#!${process.execPath}
import fs from 'node:fs';
import { Client } from '${sdk('client/index.js')}';
import { StdioClientTransport } from '${sdk('client/stdio.js')}';
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('fake'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(path.join(bin, 'argv.json'))}, JSON.stringify(argv));
const config = JSON.parse(fs.readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf8'));
const server = Object.values(config.mcpServers)[0];
const client = new Client({ name: 'fake-claude', version: '1' });
await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...server.env } }));
const tags = ${JSON.stringify({ ...TAGS, privacy: { flagged: false, findings: [] } })};
let n = 0;
for (;;) {
  const q = JSON.parse((await client.callTool({ name: 'tagging_queue', arguments: {} })).content[0].text);
  if (!q.batch) break;
  await client.callTool({ name: 'save_tags', arguments: { items: q.batch.map((b) => ({ ...tags, id: b.id, hash: b.hash })) } });
  n += q.batch.length;
}
await client.close();
console.log(JSON.stringify({ type: 'result', is_error: false, result: 'Размечено ' + n }));
`,
      { mode: 0o755 },
    );
    process.env.SCRN_CLAUDE_PATH = fake;

    const ws = loadWorkspace({ root });
    const r = await runTagging(ws, { provider: 'claude-code', limit: 1, log: silentLogger });
    expect(r).toMatchObject({ provider: 'claude-code', tagged: 1, errors: [] });

    const argv = JSON.parse(fs.readFileSync(path.join(bin, 'argv.json'), 'utf8')) as string[];
    expect(argv[0]).toBe('-p');
    expect(argv).toEqual(expect.arrayContaining(['--strict-mcp-config', '--permission-mode', 'dontAsk', '--no-session-persistence']));
    expect(argv[argv.indexOf('--tools') + 1]).toBe('');
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe(TAGGING_TOOLS.join(','));

    // limit: 1 is enforced by the MCP server, not by the prompt
    const lib = Library.open(path.join(root, 'library'));
    expect(lib.index.screens.filter((s) => s.tagging?.source === 'claude-code')).toHaveLength(1);
  });

  it('builds headless args without built-in tools', () => {
    const args = headlessArgs({ prompt: 'p', mcpConfig: '/tmp/x.json', model: 'sonnet' });
    expect(args.slice(-2)).toEqual(['--model', 'sonnet']);
    expect(args).not.toContain('--dangerously-skip-permissions');
  });
});

describe('tagging through the Claude API (optional provider)', () => {
  let server: http.Server;
  let requests: { url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
  });

  it('sends a vision + structured-output request with server-side fallbacks and stores the tags', async () => {
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
            content: [{ type: 'text', text: JSON.stringify(TAGS) }],
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
    requests = [];

    const root = await libraryWorkspace();
    const ws = loadWorkspace({ root });
    const library = Library.open(ws.paths.library);
    const result = await tagWithApi(ws, library, { ids: ['mock.desktop.flow.dashboard'], log: silentLogger });
    expect(result).toMatchObject({ tagged: 1, flagged: ['mock.desktop.flow.dashboard'], errors: [] });

    const req = requests[0];
    expect(req.url).toMatch(/^\/v1\/messages/);
    expect(String(req.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    expect(req.body.fallbacks).toBe('default');
    const oc = req.body.output_config as { effort: string; format: { type: string; schema: { properties: Record<string, unknown> } } };
    expect(oc.effort).toBe('low');
    expect(oc.format.type).toBe('json_schema');
    expect(Object.keys(oc.format.schema.properties)).toEqual(expect.arrayContaining(['patterns', 'elements', 'privacy']));
    const content = (req.body.messages as { content: { type: string }[] }[])[0].content;
    expect(content.map((c) => c.type)).toEqual(['image', 'text']);

    const s = library.get('mock.desktop.flow.dashboard')!;
    expect(s.keywords).toContain('сводка');
    expect(s.tagging).toMatchObject({ source: 'claude-api', hash: 'hash-dashboard' });
  });
});
