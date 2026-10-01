import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Workspace } from '../config/load.js';
import { INDEX_FILE, Library } from '../library/store.js';
import { plural, type Logger } from '../util/log.js';
import { taggingQueue, type TagResult } from './tags.js';

/**
 * Tagging without an API key: Claude Code runs headless (`claude -p`) on the user's own subscription
 * and works through the library with exactly two MCP tools of this repo — tagging_queue (screens + previews)
 * and save_tags. Built-in tools are disabled, nothing else is allowed, so the run can only read previews
 * and write tags.
 */

export const MCP_SERVER = 'axion-screens';
export const TAGGING_TOOLS = [`mcp__${MCP_SERVER}__tagging_queue`, `mcp__${MCP_SERVER}__save_tags`];

export function taggingPrompt(): string {
  return [
    'Разметь экраны библиотеки Axion Screens.',
    'Повторяй цикл: вызови tagging_queue. Если очередь пуста — остановись.',
    'Иначе внимательно посмотри на каждое превью и контекст и сохрани разметку всей пачки одним вызовом save_tags',
    '(передай id и hash каждого экрана из очереди). Правила и словарь — в ответе tagging_queue.',
    'В конце ответь одной строкой: сколько экранов размечено и сколько отправлено на проверку.',
  ].join('\n');
}

/** Path to the `claude` CLI, or undefined if Claude Code is not installed. */
export function findClaudeCli(explicit?: string): string | undefined {
  const candidate = explicit || process.env.SCRN_CLAUDE_PATH || 'claude';
  const r = spawnSync(candidate, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? candidate : undefined;
}

export function headlessArgs(o: { prompt: string; mcpConfig: string; model?: string }): string[] {
  return [
    '-p',
    o.prompt,
    '--mcp-config',
    o.mcpConfig,
    '--strict-mcp-config',
    '--tools',
    '',
    '--allowedTools',
    TAGGING_TOOLS.join(','),
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
    '--output-format',
    'json',
    ...(o.model ? ['--model', o.model] : []),
  ];
}

/** dist/cli/index.js — also when this module runs from src/ (tsx, tests). */
function cliEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sibling = path.resolve(here, '..', 'cli', 'index.js');
  return fs.existsSync(sibling) ? sibling : path.resolve(here, '..', '..', 'dist', 'cli', 'index.js');
}

/** MCP config for the headless run: our server only, with the session filters passed via env. */
export function writeMcpConfig(ws: Workspace, filters: { ids?: string[]; all?: boolean; limit?: number }): string {
  const cli = cliEntry();
  const env: Record<string, string> = {};
  if (filters.ids?.length) env.SCRN_TAG_IDS = filters.ids.join(',');
  if (filters.all) env.SCRN_TAG_ALL = '1';
  if (filters.limit) env.SCRN_TAG_LIMIT = String(filters.limit);
  const config = { mcpServers: { [MCP_SERVER]: { type: 'stdio', command: process.execPath, args: [cli, '--root', ws.root, 'mcp'], env } } };
  fs.mkdirSync(ws.paths.state, { recursive: true });
  const file = path.join(ws.paths.state, 'claude-code-mcp.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

export interface ClaudeCodeTagOptions {
  ids?: string[];
  all?: boolean;
  limit?: number;
  log: Logger;
}

export async function tagWithClaudeCode(ws: Workspace, opts: ClaudeCodeTagOptions): Promise<TagResult> {
  const result: TagResult = { tagged: 0, flagged: [], skipped: 0, errors: [] };
  const queue = taggingQueue(Library.open(ws.paths.library), opts);
  const total = opts.limit ? Math.min(opts.limit, queue.length) : queue.length;
  if (!total) return result;

  const claude = findClaudeCli(ws.config.tagging.claudePath);
  if (!claude) {
    result.errors.push('не найден Claude Code CLI (claude) — установи его или размечай в Claude Code командой /tag-screens');
    return result;
  }

  const startedAt = new Date().toISOString();
  const mcpConfig = writeMcpConfig(ws, opts);
  const args = headlessArgs({ prompt: taggingPrompt(), mcpConfig, model: ws.config.tagging.claudeModel });
  opts.log.info(`Claude Code размечает ${plural(total, ['экран', 'экрана', 'экранов'])} (по подписке, без API-ключа)…`);

  const indexFile = path.join(ws.paths.library, INDEX_FILE);
  const countDone = () =>
    Library.open(ws.paths.library).index.screens.filter((s) => s.tagging?.source === 'claude-code' && s.tagging.at >= startedAt).length;
  let lastReported = 0;
  let lastMtime = fs.existsSync(indexFile) ? fs.statSync(indexFile).mtimeMs : 0;
  const progress = setInterval(() => {
    const mtime = fs.existsSync(indexFile) ? fs.statSync(indexFile).mtimeMs : 0;
    if (mtime === lastMtime) return;
    lastMtime = mtime;
    const done = countDone();
    if (done !== lastReported) {
      lastReported = done;
      opts.log.dim(`  размечено ${done} из ${total}`);
    }
  }, 3000);

  const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(claude, args, { cwd: ws.root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (c) => resolve({ code: c, stdout: out, stderr: err }));
    child.on('error', (e) => resolve({ code: -1, stdout: out, stderr: String(e) }));
  });
  clearInterval(progress);

  const library = Library.open(ws.paths.library);
  const tagged = library.index.screens.filter((s) => s.tagging?.source === 'claude-code' && s.tagging.at >= startedAt);
  result.tagged = tagged.length;
  result.flagged = tagged.filter((s) => s.anonymization.audit?.flagged).map((s) => s.id);
  for (const s of tagged.filter((x) => x.anonymization.audit?.flagged)) {
    opts.log.warn(`${s.id}: privacy-аудит — ${s.anonymization.audit?.findings.join('; ')}`);
  }

  let summary = '';
  try {
    const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean };
    summary = parsed.result ?? '';
    if (parsed.is_error) result.errors.push(`Claude Code: ${summary || 'ошибка выполнения'}`);
  } catch {
    summary = stdout.trim();
  }
  if (code !== 0) {
    const tail = (stderr || stdout).trim().split('\n').slice(-3).join(' ');
    result.errors.push(`claude завершился с кодом ${code}: ${tail || 'без вывода'} — проверь, что выполнен вход (claude, затем /login)`);
  }
  if (summary) opts.log.dim(`  Claude: ${summary.split('\n').at(-1)}`);
  result.skipped = Math.max(0, total - result.tagged);
  return result;
}
