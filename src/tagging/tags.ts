import { z } from 'zod';
import type { Workspace } from '../config/load.js';
import type { ScreenRecord } from '../core/types.js';
import type { Library } from '../library/store.js';

/**
 * Auto-tagging — "the neural net sorts and tags the archive" from the meeting, built into the engine:
 * Mobbin-like patterns/elements from the controlled taxonomy, RU+EN keywords for search, a short
 * description, suitability for slides and a second-line privacy audit of the pixels (canvas/map text,
 * faces, plates, logos — things the DOM guard cannot see).
 *
 * Who looks at the pictures is pluggable: Claude Code on the user's own subscription (default, via the
 * MCP tools tagging_queue/save_tags — interactively or headless `claude -p`), or the Claude API.
 */

export const SUGGESTED_USE = ['hero', 'executive-slide', 'feature-detail', 'mockup-desktop', 'mockup-mobile', 'brand-guide', 'docs', 'not-recommended'] as const;

export type TagSource = 'claude-code' | 'claude-api';

export interface TagResult {
  tagged: number;
  flagged: string[];
  skipped: number;
  errors: string[];
}

export function tagSchema(ws: Workspace) {
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

export type ScreenTags = z.infer<ReturnType<typeof tagSchema>>;

/** Rules for whoever does the tagging (system prompt for the API, tool result text for Claude Code). */
export function taggingGuide(ws: Workspace): string {
  const personas = [...ws.dictionary.personas.latin, ...ws.dictionary.personas.arabic, ...ws.dictionary.personas.cyrillic];
  return [
    'Ты размечаешь скриншоты интерфейсов продуктов Axion (Gen, Command & Control, Sense) для внутренней библиотеки экранов в духе Mobbin.',
    'По скриншоту и контексту заполни разметку. Названия и описания — по-русски, коротко и по делу.',
    '',
    'Типы экранов (patterns) и элементы (elements) выбирай строго из словаря. Отмечай только то, что действительно видно.',
    `patterns: ${ws.taxonomy.patterns.join(', ')}`,
    `elements: ${ws.taxonomy.elements.join(', ')}`,
    'suggestedUse: hero — эффектный экран для обложки или крупного слайда; executive-slide — сводки и KPI для руководителей;',
    'feature-detail — иллюстрация конкретной функции; mockup-desktop / mockup-mobile — подходит для макапа устройства;',
    'brand-guide — показывает визуальный стиль; docs — документация; not-recommended — сырой, пустой или сломанный экран.',
    '',
    'Privacy-аудит (privacy): данные на экранах уже обезличены, имена заменены вымышленными персонами из списка ниже — они безопасны.',
    'Отмечай flagged=true, если видишь: имена людей НЕ из списка персон; логотипы, гербы и названия реальных заказчиков',
    '(министерства, муниципалитеты, MOMRA/MOMRAH, Balady, NCIM, REGA, госсимволика); лица людей; читаемые номера автомобилей;',
    'телефоны, e-mail (кроме @example.com), ID-номера, внутренние адреса/хосты.',
    'Значения из строки «Подставлено обезличиванием» — уже фейки с сохранённым форматом (телефоны, номера, имена): их не отмечай.',
    'Безопасные персоны:',
    personas.join(', '),
  ].join('\n');
}

export function screenContext(ws: Workspace, screen: ScreenRecord): string {
  const product = ws.products.find((p) => p.id === screen.product)?.name ?? screen.product;
  return [
    `Продукт: ${product}; платформа: ${screen.platform}`,
    `Флоу: ${screen.flowName}; шаг ${screen.position}: ${screen.title}`,
    screen.route ? `Маршрут: ${screen.route}` : '',
    screen.patterns.length ? `Паттерны из каталога: ${screen.patterns.join(', ')}` : '',
    screen.elements.length ? `Элементы (эвристики DOM): ${screen.elements.join(', ')}` : '',
    screen.text ? `Видимый текст (обезличен):\n${screen.text.slice(0, 1500)}` : '',
    screen.anonymization.substitutes?.length
      ? `Подставлено обезличиванием (фейки, не утечка): ${screen.anonymization.substitutes.join(' | ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** New or changed pixels since the last tagging pass. */
export function needsTagging(s: ScreenRecord): boolean {
  return s.status !== 'orphaned' && (!s.tagging || s.tagging.source === 'heuristics' || s.tagging.hash !== s.hash);
}

export function taggingQueue(library: Library, opts: { ids?: string[]; all?: boolean } = {}): ScreenRecord[] {
  return library.index.screens.filter((s) =>
    opts.ids?.length ? opts.ids.includes(s.id) : s.status !== 'orphaned' && (opts.all || needsTagging(s)),
  );
}

export function applyTags(library: Library, screen: ScreenRecord, tags: ScreenTags, meta: { source: TagSource; model?: string }): void {
  const now = new Date().toISOString();
  const merge = (a: string[], b: string[]) => [...new Map([...a, ...b].map((x) => [x.toLowerCase(), x])).values()];
  library.update(screen.id, {
    // Curated titles from the catalog win; discovered screens get Claude's title.
    title: screen.source === 'discover' ? tags.title : screen.title,
    description: screen.description || tags.description,
    patterns: merge(screen.patterns, tags.patterns),
    elements: merge(screen.elements, tags.elements),
    keywords: tags.keywords,
    suggestedUse: tags.suggestedUse,
    quality: tags.quality,
    status: tags.privacy.flagged ? 'review' : screen.status === 'review' ? 'ok' : screen.status,
    anonymization: { ...screen.anonymization, audit: { flagged: tags.privacy.flagged, findings: tags.privacy.findings, at: now } },
    tagging: { source: meta.source, model: meta.model, at: now, hash: screen.hash },
  });
}
