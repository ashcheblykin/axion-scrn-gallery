import fs from 'node:fs';
import path from 'node:path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadWorkspace, type Workspace } from '../config/load.js';
import { parseTargets, runCapture } from '../capture/runner.js';
import { authProfile, loadSession, sessionAgeDays } from '../capture/session.js';
import type { FlowRecord, ScreenRecord, SectionRecord } from '../core/types.js';
import { EXPORT_VARIANTS, exportScreens } from '../library/export.js';
import { LibrarySearch, type ScreenFilters } from '../library/search.js';
import { INDEX_FILE, isLfsPointer, Library } from '../library/store.js';
import { preview } from '../process/images.js';
import { needsTagging } from '../tagging/claude.js';
import { createLogger } from '../util/log.js';

/**
 * MCP server over the screen library — the same mental model as the Mobbin MCP (search_screens /
 * search_flows / search_sections), but for our own products, plus tools to export presentation-ready
 * variants and to refresh screens. Agents use it to pick screens for slides, docs and brand guides.
 */

const INSTRUCTIONS = `Библиотека скриншотов продуктов Axion (Gen, Command & Control, Sense) — как Mobbin, только для своих продуктов.
Все экраны обезличены (имена — вымышленные персоны, логотипы заказчиков заменены). Retina: desktop @2x, mobile @3x.
Как пользоваться:
- search_screens — найти экраны по смыслу («сводка KPI», «карточка решения», «карта инспекторов»), фильтры: product, platform, pattern, element, brief.
- search_flows — найти пользовательские сценарии (последовательности экранов).
- search_sections — найти отдельные плашки/виджеты (PNG без фона со скруглёнными углами).
- export_screen — получить готовые к слайдам файлы: clear (без фона приложения), cards (только плашки), framed (на фоне с отступами и тенью), layers (SVG со слоями для Figma).
Встроенные картинки — превью низкого разрешения, только чтобы ты видел экран. Для слайдов/Figma бери полноразмерные файлы из files.* (абсолютные пути) или делай export_screen.
Брифовые экраны презентации: brief = quality-check | executive-summary | decision-card | agent-work | customer-system-task.`;

interface State {
  ws: Workspace;
  library: Library;
  search: LibrarySearch;
  mtime: number;
}

export function createServer(root?: string): McpServer {
  const log = createLogger({ stream: process.stderr });
  let state: State | undefined;

  /** Reload when `scrn refresh` (another process) rewrites index.json. */
  const current = (): State => {
    const ws = state?.ws ?? loadWorkspace({ root });
    const indexFile = path.join(ws.paths.library, INDEX_FILE);
    const mtime = fs.existsSync(indexFile) ? fs.statSync(indexFile).mtimeMs : 0;
    if (!state || state.mtime !== mtime) {
      const library = Library.open(ws.paths.library);
      state = { ws, library, search: new LibrarySearch(library.index, ws.taxonomy), mtime };
    }
    return state;
  };

  const productName = (s: State, id: string) => s.ws.products.find((p) => p.id === id)?.name ?? id;
  const abs = (s: State, rel?: string) => (rel ? s.library.abs(rel) : undefined);
  const githubUrl = (s: State, rel: string) =>
    s.ws.config.links.repoUrl ? `${s.ws.config.links.repoUrl}/blob/${s.ws.config.links.branch}/${s.ws.config.library}/${rel}` : undefined;

  const screenJson = (s: State, x: ScreenRecord) => ({
    id: x.id,
    title: x.title,
    product: x.product,
    product_name: productName(s, x.product),
    platform: x.platform,
    theme: x.theme,
    locale: x.locale,
    flow: x.flow,
    flow_name: x.flowName,
    position: x.position,
    brief: x.brief,
    description: x.description,
    patterns: x.patterns,
    elements: x.elements,
    tags: x.tags,
    keywords: x.keywords,
    suggested_use: x.suggestedUse,
    status: x.status,
    privacy_findings: x.anonymization.audit?.flagged ? x.anonymization.audit.findings : undefined,
    quality: x.quality,
    version: x.version,
    changed_at: x.changedAt,
    captured_at: x.capturedAt,
    route: x.route,
    viewport: x.viewport,
    overflow: x.overflow,
    files: {
      default: abs(s, x.files.default.path),
      clear: abs(s, x.files.clear?.path),
      cards: abs(s, x.files.cards?.path),
      full: abs(s, x.files.full?.path),
    },
    github_url: githubUrl(s, x.files.default.path),
    sections: x.sections.map((sec) => ({ id: sec.id, name: sec.name, file: abs(s, sec.file.path) })),
  });

  const sectionJson = (s: State, sec: SectionRecord, screen: ScreenRecord) => ({
    id: sec.id,
    name: sec.name,
    description: sec.description,
    patterns: sec.patterns,
    elements: sec.elements,
    tags: sec.tags,
    screen_id: screen.id,
    screen_title: screen.title,
    product_name: productName(s, screen.product),
    platform: screen.platform,
    file: abs(s, sec.file.path),
    width: sec.file.width,
    height: sec.file.height,
  });

  const flowJson = (s: State, f: FlowRecord, screens: ScreenRecord[]) => ({
    id: f.id,
    name: f.name,
    description: f.description,
    product: f.product,
    product_name: productName(s, f.product),
    platform: f.platform,
    brief: f.brief,
    actions: f.actions,
    tags: f.tags,
    screen_count: screens.length,
    screens: screens.map((x) => ({ screen_id: x.id, position: x.position, title: x.title, file: abs(s, x.files.default.path) })),
  });

  const image = async (s: State, rel: string | undefined, format: 'webp' | 'jpeg', maxEdge?: number) => {
    if (!rel) return undefined;
    const file = s.library.abs(rel);
    if (!fs.existsSync(file) || isLfsPointer(file)) return undefined;
    let data: Buffer = fs.readFileSync(file);
    if (maxEdge || format === 'jpeg' || !rel.endsWith('.webp')) data = await preview(data, maxEdge ?? 768, format);
    return { type: 'image' as const, data: data.toString('base64'), mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/webp' };
  };

  const text = (data: unknown) => ({ type: 'text' as const, text: JSON.stringify(data, null, 2) });
  const filtersFrom = (a: {
    product?: string;
    platform?: string;
    flow?: string;
    pattern?: string;
    element?: string;
    brief?: string;
    brief_only?: boolean;
    theme?: string;
    locale?: string;
    include_unreviewed?: boolean;
  }): ScreenFilters => ({
    product: a.product,
    platform: a.platform,
    flow: a.flow,
    pattern: a.pattern,
    element: a.element,
    brief: a.brief,
    briefOnly: a.brief_only,
    theme: a.theme,
    locale: a.locale,
    statuses: a.include_unreviewed ? ['ok', 'failed', 'review', 'unsafe'] : undefined,
  });

  const server = new McpServer({ name: 'axion-screens', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  const commonFilters = {
    product: z.string().optional().describe('gen | cnc | sense'),
    platform: z.enum(['desktop', 'mobile']).optional(),
    brief: z.string().optional().describe('quality-check | executive-summary | decision-card | agent-work | customer-system-task'),
    brief_only: z.boolean().optional().describe('Только экраны из брифа презентации'),
    include_unreviewed: z.boolean().optional().describe('Включить экраны, которые privacy-аудит пометил на проверку'),
    image_format: z.enum(['webp', 'jpeg']).optional().describe('jpeg, если клиент не поддерживает webp'),
  };

  server.registerTool(
    'search_screens',
    {
      title: 'Search screens',
      description:
        'Найти экраны продуктов Axion по описанию на русском или английском («дашборд с KPI», «таблица инспекторов», «чат с ассистентом»). Возвращает метаданные, абсолютные пути к Retina-файлам и превью.',
      inputSchema: {
        query: z.string().optional().describe('Что ищем; пусто — все экраны по фильтрам'),
        flow: z.string().optional(),
        pattern: z.string().optional().describe('Тип экрана из таксономии: Dashboard, Map view, Chat…'),
        element: z.string().optional().describe('UI-элемент: Table, Chart, Map, KPI card…'),
        theme: z.string().optional(),
        locale: z.string().optional(),
        limit: z.number().int().min(1).max(30).optional(),
        include_images: z.boolean().optional(),
        ...commonFilters,
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const s = current();
      const hits = s.search.searchScreens(a.query ?? '', filtersFrom(a), a.limit ?? 8);
      const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [
        text({ query: a.query ?? '', returned: hits.length, screens: hits.map((h) => screenJson(s, h.screen)) }),
      ];
      if (a.include_images !== false) {
        for (const h of hits) {
          const img = await image(s, h.screen.files.thumb.path, a.image_format ?? 'webp');
          if (img) content.push(img);
        }
      }
      if (!hits.length) content.push(text({ hint: 'Ничего не нашлось. Попробуй другие слова, убери фильтры или проверь list_products.' }));
      return { content };
    },
  );

  server.registerTool(
    'search_flows',
    {
      title: 'Search flows',
      description: 'Найти пользовательские сценарии (флоу) — упорядоченные последовательности экранов, как в Mobbin.',
      inputSchema: {
        query: z.string().optional(),
        limit: z.number().int().min(1).max(10).optional(),
        page: z.number().int().min(1).optional(),
        include_images: z.boolean().optional(),
        ...commonFilters,
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const s = current();
      const limit = a.limit ?? 4;
      const hits = s.search.searchFlows(a.query ?? '', filtersFrom(a), limit + 1, ((a.page ?? 1) - 1) * limit);
      const page = hits.slice(0, limit);
      const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [
        text({ query: a.query ?? '', page: a.page ?? 1, has_next_page: hits.length > limit, flows: page.map((h) => flowJson(s, h.flow, h.screens)) }),
      ];
      if (a.include_images !== false) {
        for (const h of page) {
          // Evenly spaced previews, at most 4 per flow.
          const n = h.screens.length;
          const picks = n <= 4 ? h.screens : [0, 1, 2, 3].map((i) => h.screens[Math.round((i * (n - 1)) / 3)]);
          for (const x of picks) {
            const img = await image(s, x.files.thumb.path, a.image_format ?? 'webp');
            if (img) content.push(img);
          }
        }
      }
      return { content };
    },
  );

  server.registerTool(
    'search_sections',
    {
      title: 'Search sections',
      description: 'Найти отдельные плашки/виджеты (KPI-карточки, графики, таблицы) — PNG без фона со своими скруглениями и тенью.',
      inputSchema: {
        query: z.string().optional(),
        limit: z.number().int().min(1).max(30).optional(),
        page: z.number().int().min(1).optional(),
        include_images: z.boolean().optional(),
        ...commonFilters,
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const s = current();
      const limit = a.limit ?? 10;
      const hits = s.search.searchSections(a.query ?? '', filtersFrom(a), limit, ((a.page ?? 1) - 1) * limit);
      const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [
        text({ query: a.query ?? '', sections: hits.map((h) => sectionJson(s, h.section, h.screen)) }),
      ];
      if (a.include_images !== false) {
        for (const h of hits) {
          const img = await image(s, h.section.thumb?.path ?? h.section.file.path, a.image_format ?? 'webp');
          if (img) content.push(img);
        }
      }
      return { content };
    },
  );

  server.registerTool(
    'get_screen',
    {
      title: 'Get screen',
      description: 'Полная карточка экрана по id: метаданные, версии, файлы вариантов и картинка (thumb / preview 1280px / full).',
      inputSchema: {
        id: z.string(),
        size: z.enum(['thumb', 'preview', 'none']).optional().describe('По умолчанию preview (1280px)'),
        image_format: z.enum(['webp', 'jpeg']).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const s = current();
      const screen = s.search.screen(a.id) ?? s.library.get(a.id);
      if (!screen) return { isError: true, content: [text({ error: `нет экрана ${a.id}` })] };
      const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [
        text({ ...screenJson(s, screen), text_excerpt: screen.text?.slice(0, 800) }),
      ];
      const size = a.size ?? 'preview';
      if (size !== 'none') {
        const img =
          size === 'thumb'
            ? await image(s, screen.files.thumb.path, a.image_format ?? 'webp')
            : await image(s, screen.files.default.path, a.image_format ?? 'webp', 1280);
        if (img) content.push(img);
      }
      return { content };
    },
  );

  server.registerTool(
    'get_flow',
    {
      title: 'Get flow',
      description: 'Флоу по id (<product>.<platform>.<flow>): все шаги по порядку с превью.',
      inputSchema: { id: z.string(), include_images: z.boolean().optional(), image_format: z.enum(['webp', 'jpeg']).optional() },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const s = current();
      const flow = s.library.index.flows.find((f) => f.id === a.id);
      if (!flow) return { isError: true, content: [text({ error: `нет флоу ${a.id}`, flows: s.library.index.flows.map((f) => f.id) })] };
      const screens = flow.steps.map((id) => s.library.get(id)).filter((x): x is ScreenRecord => !!x);
      const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [text(flowJson(s, flow, screens))];
      if (a.include_images !== false) {
        for (const x of screens) {
          const img = await image(s, x.files.thumb.path, a.image_format ?? 'webp');
          if (img) content.push(img);
        }
      }
      return { content };
    },
  );

  server.registerTool(
    'list_products',
    {
      title: 'List products',
      description: 'Продукты, платформы, флоу и покрытие брифа (какие из 5 экранов презентации уже есть в библиотеке).',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const s = current();
      const { index } = s.library;
      const products = s.ws.products.map((p) => {
        const screens = index.screens.filter((x) => x.product === p.id && x.status !== 'orphaned');
        return {
          id: p.id,
          name: p.name,
          description: p.description,
          platforms: p.platforms,
          screens: screens.length,
          flows: index.flows.filter((f) => f.product === p.id).map((f) => ({ id: f.id, name: f.name, steps: f.steps.length, brief: f.brief })),
          todo: p.flows.filter((f) => f.todo).map((f) => `${f.id}: ${f.todo}`),
        };
      });
      const briefs = s.ws.taxonomy.briefs.map((b) => ({
        id: b.id,
        name: b.name,
        screens: index.screens.filter((x) => x.brief === b.id && (x.status === 'ok' || x.status === 'failed')).map((x) => x.id),
      }));
      return { content: [text({ updated_at: index.updatedAt, products, briefs })] };
    },
  );

  server.registerTool(
    'export_screen',
    {
      title: 'Export screen',
      description:
        'Подготовить файлы для слайдов/Figma: default, full, clear (без фона), cards (только плашки), framed (на фоне с отступом, скруглением и тенью), layers (SVG со слоями для Figma). Возвращает пути к файлам.',
      inputSchema: {
        ids: z.array(z.string()).min(1).describe('id экранов или секций (<screenId>--<section>)'),
        variant: z.enum(EXPORT_VARIANTS),
        background: z.string().optional().describe('framed: transparent | white | black | gradient | blur | #hex'),
        padding: z.number().optional().describe('CSS px вокруг экрана (framed/cards)'),
        radius: z.number().optional().describe('Скругление углов экрана, CSS px'),
        shadow: z.boolean().optional(),
        width: z.number().int().optional().describe('Итоговая ширина в px'),
        out_dir: z.string().optional().describe('Папка; по умолчанию exports/<дата>'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (a) => {
      const s = current();
      const outDir = path.resolve(s.ws.root, a.out_dir ?? path.join('exports', new Date().toISOString().slice(0, 10)));
      try {
        const files = await exportScreens(s.library, {
          ids: a.ids,
          variant: a.variant,
          background: a.background,
          padding: a.padding,
          radius: a.radius,
          shadow: a.shadow,
          width: a.width,
          outDir,
        });
        const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [text({ out_dir: outDir, files })];
        const first = files.find((f) => f.file.endsWith('.png'));
        if (first) {
          const img = await preview(fs.readFileSync(first.file), 768, 'webp');
          content.push({ type: 'image', data: img.toString('base64'), mimeType: 'image/webp' });
        }
        return { content };
      } catch (err) {
        return { isError: true, content: [text({ error: err instanceof Error ? err.message : String(err) })] };
      }
    },
  );

  server.registerTool(
    'capture',
    {
      title: 'Capture screens',
      description:
        'Переснять экраны со стенда (нужна сохранённая сессия: scrn auth <product>). targets: "gen", "gen/executive-summary", "cnc/inspectors/list", "brief". Долгая операция.',
      inputSchema: {
        targets: z.array(z.string()).optional(),
        platform: z.enum(['desktop', 'mobile']).optional(),
        force: z.boolean().optional().describe('Записать новую версию, даже если экран не изменился'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (a) => {
      const s = current();
      const { targets, briefOnly } = parseTargets(a.targets ?? []);
      const result = await runCapture(s.ws, {
        targets,
        briefOnly,
        platforms: a.platform ? [a.platform] : undefined,
        force: a.force,
        log: createLogger({ stream: process.stderr }),
      });
      state = undefined;
      return {
        content: [
          text({
            stats: result.run.stats,
            notes: result.run.notes,
            results: result.results.map((r) => ({ id: r.id, outcome: r.outcome, version: r.version, message: r.message })),
          }),
        ],
      };
    },
  );

  server.registerTool(
    'library_status',
    {
      title: 'Library status',
      description: 'Состояние библиотеки: последние прогоны, ошибки, карантин, экраны без автотегов, сессии стендов.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const s = current();
      const { index } = s.library;
      const byStatus: Record<string, number> = {};
      for (const x of index.screens) byStatus[x.status] = (byStatus[x.status] ?? 0) + 1;
      const quarantineDir = path.join(s.ws.paths.state, 'quarantine');
      const quarantine = fs.existsSync(quarantineDir)
        ? fs.readdirSync(quarantineDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
        : [];
      const profiles = [...new Set(s.ws.products.map((p) => authProfile(p)))];
      const sessions = profiles.map((profile) => {
        const sess = loadSession(s.ws.paths.auth, profile, s.ws.config.environment);
        return { profile, environment: s.ws.config.environment, saved: !!sess, age_days: sess ? Math.round(sessionAgeDays(sess) * 10) / 10 : undefined };
      });
      return {
        content: [
          text({
            updated_at: index.updatedAt,
            screens: index.screens.length,
            by_status: byStatus,
            needs_tagging: index.screens.filter(needsTagging).length,
            failed: index.screens.filter((x) => x.status === 'failed').map((x) => ({ id: x.id, error: x.error })),
            review: index.screens.filter((x) => x.status === 'review').map((x) => ({ id: x.id, findings: x.anonymization.audit?.findings })),
            quarantine,
            sessions,
            runs: index.runs.slice(0, 5),
          }),
        ],
      };
    },
  );

  server.registerResource(
    'library-index',
    'library://index',
    { title: 'Library index', description: 'library/index.json — все экраны, флоу и прогоны', mimeType: 'application/json' },
    async (uri) => {
      const s = current();
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(s.library.index) }] };
    },
  );

  server.registerResource(
    'screen',
    new ResourceTemplate('screen://{id}', {
      list: async () => {
        const s = current();
        return {
          resources: s.library.index.screens
            .filter((x) => x.status === 'ok')
            .map((x) => ({ uri: `screen://${x.id}`, name: x.id, title: `${productName(s, x.product)} · ${x.flowName} · ${x.title}`, mimeType: 'image/png' })),
        };
      },
    }),
    { title: 'Screen image', description: 'Retina PNG экрана (вариант default)', mimeType: 'image/png' },
    async (uri, vars) => {
      const s = current();
      const id = String(vars.id);
      const screen = s.library.get(id);
      if (!screen) throw new Error(`нет экрана ${id}`);
      const file = s.library.abs(screen.files.default.path);
      if (isLfsPointer(file)) throw new Error('файл не скачан из LFS: git lfs pull');
      return { contents: [{ uri: uri.href, mimeType: 'image/png', blob: fs.readFileSync(file).toString('base64') }] };
    },
  );

  server.registerPrompt(
    'screens_for_slide',
    {
      title: 'Screens for a slide',
      description: 'Подобрать экраны под тезис слайда и подготовить файлы',
      argsSchema: { topic: z.string().describe('Тезис или заголовок слайда'), style: z.string().optional().describe('clear | cards | framed') },
    },
    ({ topic, style }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Подбери 1–3 экрана из библиотеки Axion для слайда «${topic}». ` +
              'Сначала search_screens (и search_sections, если нужен отдельный виджет), посмотри превью, выбери самые наглядные экраны со статусом ok. ' +
              `Затем вызови export_screen с variant=${style ?? 'framed'} и верни пути к файлам с одной строкой пояснения, почему выбран каждый экран.`,
          },
        },
      ],
    }),
  );

  void log;
  return server;
}

export async function runMcpServer(root?: string): Promise<void> {
  const server = createServer(root);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
