import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { Workspace } from '../config/load.js';
import type { ScreenRecord } from '../core/types.js';
import { isLfsPointer, type Library } from '../library/store.js';
import { preview } from '../process/images.js';
import type { Logger } from '../util/log.js';
import { errorMessage, mapPool } from '../util/pool.js';

/**
 * Auto-tagging with Claude vision — the "neural net sorts and tags the archive" step from the meeting,
 * built into the engine: Mobbin-like patterns/elements from the controlled taxonomy, RU+EN keywords for
 * search, a short description, suitability for slides, and a second-line privacy audit of the pixels
 * (canvas/map text, faces, plates, logos — things the DOM guard cannot see).
 */

export const SUGGESTED_USE = ['hero', 'executive-slide', 'feature-detail', 'mockup-desktop', 'mockup-mobile', 'brand-guide', 'docs', 'not-recommended'] as const;

export function hasClaudeCredentials(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  return fs.existsSync(path.join(os.homedir(), '.config', 'anthropic'));
}

function tagSchema(ws: Workspace) {
  const patterns = ws.taxonomy.patterns as [string, ...string[]];
  const elements = ws.taxonomy.elements as [string, ...string[]];
  return z.object({
    title: z.string().describe('Короткое название экрана по-русски, до 6 слов'),
    description: z.string().describe('1–2 предложения по-русски: что на экране и для чего он нужен'),
    patterns: z.array(z.enum(patterns)).describe('Типы экрана из словаря, 1–4 штуки'),
    elements: z.array(z.enum(elements)).describe('Заметные UI-элементы из словаря'),
    keywords: z.array(z.string()).describe('8–15 ключевых слов для поиска, по-русски и по-английски'),
    suggestedUse: z.array(z.enum(SUGGESTED_USE)).describe('Где экран уместен в презентации или бренд-гайде'),
    quality: z.object({
      cutOff: z.boolean().describe('Важный контент обрезан краем кадра'),
      emptyState: z.boolean(),
      loading: z.boolean().describe('Видны лоадеры/скелетоны вместо данных'),
      broken: z.boolean().describe('Ошибка, сломанная вёрстка, пустые плейсхолдеры'),
      notes: z.string().describe('Коротко, что не так; пусто, если всё хорошо'),
    }),
    privacy: z.object({
      flagged: z.boolean(),
      findings: z.array(z.string()).describe('Что именно небезопасно и где на экране'),
    }),
  });
}

function systemPrompt(ws: Workspace): string {
  const personas = [...ws.dictionary.personas.latin, ...ws.dictionary.personas.arabic, ...ws.dictionary.personas.cyrillic];
  return [
    'Ты размечаешь скриншоты интерфейсов продуктов Axion (Gen, Command & Control, Sense) для внутренней библиотеки экранов в духе Mobbin.',
    'По скриншоту и контексту верни структурированную разметку. Названия и описания — по-русски, коротко и по делу.',
    '',
    'Типы экранов (patterns) и элементы (elements) выбирай строго из словаря схемы. Отмечай только то, что действительно видно.',
    'suggestedUse: hero — эффектный экран для обложки или крупного слайда; executive-slide — сводки и KPI для руководителей;',
    'feature-detail — иллюстрация конкретной функции; mockup-desktop / mockup-mobile — подходит для макапа устройства;',
    'brand-guide — показывает визуальный стиль; docs — документация; not-recommended — сырой, пустой или сломанный экран.',
    '',
    'Privacy-аудит (privacy): данные на экранах уже обезличены, имена заменены вымышленными персонами из списка ниже — они безопасны.',
    'Отмечай flagged=true, если видишь: имена людей НЕ из списка персон; логотипы, гербы и названия реальных заказчиков',
    '(министерства, муниципалитеты, MOMRA/MOMRAH, Balady, NCIM, REGA, госсимволика); лица людей; читаемые номера автомобилей;',
    'телефоны, e-mail (кроме @example.com), ID-номера, внутренние адреса/хосты. Безопасные персоны:',
    personas.join(', '),
  ].join('\n');
}

export interface TagOptions {
  ids?: string[];
  all?: boolean;
  limit?: number;
  dryRun?: boolean;
  log: Logger;
}

export interface TagResult {
  tagged: number;
  flagged: string[];
  skipped: number;
  errors: string[];
}

export function needsTagging(s: ScreenRecord): boolean {
  return s.status !== 'orphaned' && (!s.tagging || s.tagging.source !== 'claude' || s.tagging.hash !== s.hash);
}

export async function tagScreens(ws: Workspace, library: Library, opts: TagOptions): Promise<TagResult> {
  const cfg = ws.config.tagging;
  const result: TagResult = { tagged: 0, flagged: [], skipped: 0, errors: [] };
  let queue = library.index.screens.filter((s) => (opts.ids?.length ? opts.ids.includes(s.id) : opts.all || needsTagging(s)));
  if (opts.limit) queue = queue.slice(0, opts.limit);
  if (!queue.length) return result;
  if (opts.dryRun) {
    for (const s of queue) opts.log.info(`  ${s.id}`);
    result.skipped = queue.length;
    return result;
  }

  const client = new Anthropic();
  const schema = tagSchema(ws);
  const system = systemPrompt(ws);
  const productNames = new Map(ws.products.map((p) => [p.id, p.name]));

  await mapPool(queue, cfg.concurrency, async (screen) => {
    const file = library.abs(screen.files.default.path);
    if (!fs.existsSync(file) || isLfsPointer(file)) {
      result.skipped++;
      return;
    }
    try {
      const image = await preview(fs.readFileSync(file), cfg.maxImageEdge, 'png');
      const context = [
        `Продукт: ${productNames.get(screen.product) ?? screen.product}; платформа: ${screen.platform}`,
        `Флоу: ${screen.flowName}; шаг ${screen.position}: ${screen.title}`,
        screen.route ? `Маршрут: ${screen.route}` : '',
        screen.patterns.length ? `Паттерны из каталога: ${screen.patterns.join(', ')}` : '',
        screen.elements.length ? `Элементы (эвристики DOM): ${screen.elements.join(', ')}` : '',
        screen.text ? `Видимый текст (обезличен):\n${screen.text.slice(0, 1500)}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      const response = await client.beta.messages.parse({
        model: cfg.model,
        max_tokens: 4000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        output_config: { effort: cfg.effort, format: betaZodOutputFormat(schema) },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.toString('base64') } },
              { type: 'text', text: context },
            ],
          },
        ],
      });

      if (response.stop_reason === 'refusal') throw new Error('модель отказалась размечать экран');
      const tags = response.parsed_output;
      if (!tags) throw new Error(`пустой ответ (stop_reason: ${response.stop_reason})`);

      const now = new Date().toISOString();
      const merge = (a: string[], b: string[]) => [...new Map([...a, ...b].map((x) => [x.toLowerCase(), x])).values()];
      library.update(screen.id, {
        title: screen.source === 'discover' ? tags.title : screen.title,
        description: screen.description || tags.description,
        patterns: merge(screen.patterns, tags.patterns),
        elements: merge(screen.elements, tags.elements),
        keywords: tags.keywords,
        suggestedUse: tags.suggestedUse,
        quality: tags.quality,
        status: tags.privacy.flagged ? 'review' : screen.status === 'review' ? 'ok' : screen.status,
        anonymization: { ...screen.anonymization, audit: { flagged: tags.privacy.flagged, findings: tags.privacy.findings, at: now } },
        tagging: { source: 'claude', model: response.model, at: now, hash: screen.hash },
      });
      result.tagged++;
      if (tags.privacy.flagged) {
        result.flagged.push(screen.id);
        opts.log.warn(`${screen.id}: privacy-аудит — ${tags.privacy.findings.join('; ')}`);
      } else {
        opts.log.ok(`${screen.id}: ${tags.patterns.join(', ')}`);
      }
    } catch (err) {
      let message = errorMessage(err);
      if (err instanceof Anthropic.AuthenticationError) message = 'нет доступа к Claude API — проверь ANTHROPIC_API_KEY';
      else if (err instanceof Anthropic.RateLimitError) message = 'rate limit Claude API — повтори позже или снизь tagging.concurrency';
      result.errors.push(`${screen.id}: ${message}`);
      opts.log.error(`${screen.id}: ${message}`);
    }
  });
  return result;
}
