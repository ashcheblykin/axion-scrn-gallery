import MiniSearch from 'minisearch';
import type { Taxonomy } from '../config/schema.js';
import type { FlowRecord, LibraryIndex, ScreenRecord, ScreenStatus, SectionRecord } from '../core/types.js';

/** Russian query words → taxonomy terms (queries come in both languages, the vocabulary is English). */
const SYNONYMS: Record<string, string[]> = {
  дашборд: ['dashboard'],
  дашборды: ['dashboard'],
  сводка: ['summary', 'overview', 'kpi'],
  кпи: ['kpi'],
  инсайты: ['insights'],
  таблица: ['table'],
  список: ['list'],
  карта: ['map'],
  карте: ['map'],
  чат: ['chat'],
  диалог: ['chat'],
  диалоги: ['chat'],
  ассистент: ['assistant'],
  агент: ['agent', 'assistant'],
  агентная: ['agent'],
  график: ['chart'],
  графики: ['chart'],
  фильтр: ['filter'],
  фильтры: ['filter'],
  поиск: ['search'],
  карточка: ['card', 'detail'],
  плашка: ['card'],
  плашки: ['card'],
  решение: ['decision'],
  решения: ['decision'],
  штраф: ['decision', 'fines'],
  качество: ['quality'],
  качества: ['quality'],
  проверка: ['review', 'check'],
  кадры: ['frames'],
  кадр: ['frame'],
  инспекторы: ['inspectors'],
  инспектор: ['inspector'],
  задача: ['task'],
  заявка: ['task', 'integration'],
  планер: ['planner', 'planning'],
  настройки: ['settings'],
  профиль: ['profile'],
  модалка: ['modal'],
  форма: ['form'],
  пустое: ['empty'],
  мобилка: ['mobile'],
  мобильный: ['mobile'],
  десктоп: ['desktop'],
};

export interface ScreenFilters {
  product?: string;
  platform?: string;
  flow?: string;
  pattern?: string;
  element?: string;
  theme?: string;
  locale?: string;
  brief?: string;
  briefOnly?: boolean;
  /** Default: publishable screens only (ok; failed = last refresh failed, previous version is fine). */
  statuses?: ScreenStatus[];
}

// 'review' (privacy audit flagged) and 'unsafe' are opt-in: an agent assembling slides must not pick them by accident.
const PUBLISHABLE: ScreenStatus[] = ['ok', 'failed'];

function expand(query: string): string {
  const words = query.toLowerCase().split(/[\s,;]+/).filter(Boolean);
  const extra = words.flatMap((w) => SYNONYMS[w] ?? []);
  return [...words, ...extra].join(' ');
}

function eq(a: string | undefined, b: string | undefined): boolean {
  return !b || (a ?? '').toLowerCase() === b.toLowerCase();
}

function hasTerm(list: string[], term?: string): boolean {
  if (!term) return true;
  const t = term.toLowerCase();
  return list.some((x) => x.toLowerCase() === t || x.toLowerCase().includes(t));
}

export function screenMatches(s: ScreenRecord, f: ScreenFilters): boolean {
  const statuses = f.statuses ?? PUBLISHABLE;
  return (
    statuses.includes(s.status) &&
    eq(s.product, f.product) &&
    eq(s.platform, f.platform) &&
    eq(s.flow, f.flow) &&
    eq(s.theme, f.theme) &&
    eq(s.locale, f.locale) &&
    eq(s.brief, f.brief) &&
    (!f.briefOnly || !!s.brief) &&
    hasTerm(s.patterns, f.pattern) &&
    hasTerm(s.elements, f.element)
  );
}

export class LibrarySearch {
  private screens: MiniSearch;
  private sections: MiniSearch;
  private byId: Map<string, ScreenRecord>;
  private sectionsById: Map<string, SectionRecord>;

  constructor(
    readonly index: LibraryIndex,
    taxonomy?: Taxonomy,
  ) {
    const briefNames = new Map((taxonomy?.briefs ?? []).map((b) => [b.id, `${b.name} ${b.description ?? ''}`]));
    const productNames = new Map(index.products.map((p) => [p.id, p.name]));
    this.byId = new Map(index.screens.map((s) => [s.id, s]));
    this.sectionsById = new Map(index.screens.flatMap((s) => s.sections.map((x) => [x.id, x] as const)));

    const join = (v: unknown) => (Array.isArray(v) ? v.join(' ') : String(v ?? ''));
    this.screens = new MiniSearch({
      fields: ['title', 'flowName', 'description', 'patterns', 'elements', 'tags', 'keywords', 'text', 'productName', 'brief', 'route', 'platform'],
      storeFields: ['id'],
      extractField: (doc, field) => join((doc as Record<string, unknown>)[field]),
      searchOptions: {
        boost: { title: 3, patterns: 2.5, flowName: 2, elements: 2, tags: 2, keywords: 2, brief: 2, description: 1.5, productName: 1.5 },
        fuzzy: 0.2,
        prefix: true,
        combineWith: 'OR',
      },
    });
    this.screens.addAll(
      index.screens.map((s) => ({
        ...s,
        productName: productNames.get(s.product) ?? s.product,
        brief: s.brief ? `${s.brief} ${briefNames.get(s.brief) ?? ''}` : '',
      })),
    );

    this.sections = new MiniSearch({
      fields: ['name', 'description', 'patterns', 'elements', 'tags', 'screenTitle', 'flowName', 'productName'],
      storeFields: ['id'],
      extractField: (doc, field) => join((doc as Record<string, unknown>)[field]),
      searchOptions: { boost: { name: 3, patterns: 2, elements: 2, tags: 2 }, fuzzy: 0.2, prefix: true, combineWith: 'OR' },
    });
    this.sections.addAll(
      index.screens.flatMap((s) =>
        s.sections.map((x) => ({
          ...x,
          screenTitle: s.title,
          flowName: s.flowName,
          productName: productNames.get(s.product) ?? s.product,
        })),
      ),
    );
  }

  screen(id: string): ScreenRecord | undefined {
    return this.byId.get(id);
  }

  searchScreens(query: string, filters: ScreenFilters = {}, limit = 10, offset = 0): { screen: ScreenRecord; score: number }[] {
    const q = query.trim();
    let hits: { screen: ScreenRecord; score: number }[];
    if (!q) {
      hits = this.index.screens.map((screen) => ({ screen, score: 0 }));
      hits.sort((a, b) => a.screen.id.localeCompare(b.screen.id) || a.screen.position - b.screen.position);
    } else {
      hits = this.screens
        .search(expand(q))
        .map((r) => ({ screen: this.byId.get(r.id as string)!, score: r.score }))
        .filter((h) => !!h.screen);
    }
    return hits.filter((h) => screenMatches(h.screen, filters)).slice(offset, offset + limit);
  }

  searchFlows(query: string, filters: ScreenFilters = {}, limit = 5, offset = 0): { flow: FlowRecord; score: number; screens: ScreenRecord[] }[] {
    const q = query.trim();
    const scores = new Map<string, number>();
    if (q) {
      for (const r of this.screens.search(expand(q))) {
        const s = this.byId.get(r.id as string);
        if (!s) continue;
        const fid = `${s.product}.${s.platform}.${s.flow}`;
        scores.set(fid, (scores.get(fid) ?? 0) + r.score);
      }
      const words = expand(q).split(' ');
      for (const f of this.index.flows) {
        const hay = `${f.name} ${f.description ?? ''} ${f.actions.join(' ')} ${f.tags.join(' ')} ${f.brief ?? ''}`.toLowerCase();
        const bonus = words.filter((w) => w.length > 2 && hay.includes(w)).length * 5;
        if (bonus) scores.set(f.id, (scores.get(f.id) ?? 0) + bonus);
      }
    }
    const flows = this.index.flows
      .map((flow) => ({
        flow,
        score: scores.get(flow.id) ?? 0,
        screens: flow.steps.map((id) => this.byId.get(id)).filter((s): s is ScreenRecord => !!s && screenMatches(s, { ...filters, flow: undefined })),
      }))
      .filter((x) => x.screens.length && (!q || x.score > 0))
      .filter((x) => eq(x.flow.product, filters.product) && eq(x.flow.platform, filters.platform) && eq(x.flow.flow, filters.flow))
      .filter((x) => (!filters.briefOnly || !!x.flow.brief) && eq(x.flow.brief, filters.brief));
    flows.sort((a, b) => b.score - a.score || a.flow.id.localeCompare(b.flow.id));
    return flows.slice(offset, offset + limit);
  }

  searchSections(query: string, filters: ScreenFilters = {}, limit = 10, offset = 0): { section: SectionRecord; screen: ScreenRecord; score: number }[] {
    const q = query.trim();
    const hits = q
      ? this.sections.search(expand(q)).map((r) => ({ id: r.id as string, score: r.score }))
      : [...this.sectionsById.keys()].map((id) => ({ id, score: 0 }));
    return hits
      .map((h) => {
        const section = this.sectionsById.get(h.id)!;
        return { section, screen: this.byId.get(section.screenId)!, score: h.score };
      })
      .filter((h) => h.screen && screenMatches(h.screen, filters))
      .slice(offset, offset + limit);
  }
}
