import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assignSections, discoveredFlows, roleSelector, routeKey, routeShape, type DiscoveredKind } from '../src/capture/discover.js';
import { expectedIds, parseTargets, planJobs, resolveStep } from '../src/capture/runner.js';
import { interpolateEnv, loadWorkspace } from '../src/config/load.js';
import { ActionSchema, type Action } from '../src/config/schema.js';
import { humanFileName, screenId, variantPath } from '../src/core/naming.js';

const root = path.resolve(import.meta.dirname, '..');

describe('catalog', () => {
  it('loads the real catalog without warnings and plans every brief flow', () => {
    const ws = loadWorkspace({ root });
    expect(ws.warnings).toEqual([]);
    expect(ws.products.map((p) => p.id).sort()).toEqual(['cnc', 'gen', 'sense']);
    const briefs = new Set(ws.products.flatMap((p) => p.flows.map((f) => f.brief)).filter(Boolean));
    for (const b of ws.taxonomy.briefs) expect(briefs).toContain(b.id);
    const ids = expectedIds(ws);
    expect(ids).toContain('gen.desktop.executive-summary.dashboards');
    expect(ids).toContain('sense.desktop.quality-check.rejected-frames');
    // TODO flows are not captured until clarified
    expect([...ids].some((id) => id.startsWith('gen.desktop.agent-work'))).toBe(false);
  });

  it('filters jobs by targets and keeps preparatory steps before the selected one', () => {
    const ws = loadWorkspace({ root });
    const { targets } = parseTargets(['cnc/inspectors/profile']);
    const { jobs } = planJobs(ws, { targets, platforms: ['desktop'] });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].steps.map((s) => [s.step.id, s.capture])).toEqual([
      ['list', false],
      ['profile', true],
    ]);
  });

  it('validates actions with readable errors', () => {
    expect(ActionSchema.parse({ click: 'text=Insights' })).toEqual({ kind: 'click', arg: 'text=Insights' });
    expect(() => ActionSchema.parse({ tap: '#x' })).toThrow(/неизвестное действие/);
    expect(() => ActionSchema.parse({ click: 'a', wait: 1 })).toThrow(/ровно один ключ/);
  });

  it('interpolates env vars with fallbacks', () => {
    expect(interpolateEnv({ a: '${X_TEST_URL}/api', b: ['${MISSING:-def}'] }, { X_TEST_URL: 'https://h' })).toEqual({ a: 'https://h/api', b: ['def'] });
  });

  it('applies per-platform overrides', () => {
    const ws = loadWorkspace({ root });
    const step = { ...ws.products[0].flows[0].steps[0], on: { mobile: { url: '/m' } }, platforms: ['desktop', 'mobile'] };
    expect(resolveStep(step, 'mobile')?.url).toBe('/m');
    expect(resolveStep({ ...step, platforms: ['desktop'] }, 'mobile')).toBeNull();
  });
});

describe('naming', () => {
  const key = { product: 'gen', platform: 'desktop', flow: 'executive-summary', step: 'kpi', theme: 'dark', locale: 'ar', position: 3 };
  it('builds stable ids and human-readable paths', () => {
    expect(screenId(key, 'en')).toBe('gen.desktop.executive-summary.kpi.dark.ar');
    expect(variantPath(key, 'en', 'default')).toBe('gen/desktop/executive-summary/03-kpi.dark.ar.png');
    expect(variantPath({ ...key, theme: 'default', locale: 'en' }, 'en', 'clear')).toBe('gen/desktop/executive-summary/03-kpi.clear.png');
    expect(
      humanFileName({ productName: 'Axion Gen', flowName: 'Сводка', position: 1, title: 'KPI', platform: 'desktop', theme: 'default', locale: 'en', variant: 'clear' }),
    ).toBe('Axion Gen · Сводка · 01 KPI (desktop, en, clear).png');
  });

  it('collapses ids in routes but keeps the leading org segment', () => {
    expect(routeShape('/9/inspectors/38717')).toBe('/9/inspectors/:id');
    expect(routeShape('/library/AZ1R6M9Of9iGWIPvFDXrqQ/axion_sense.frames')).toBe('/library/:id/axion_sense.frames');
  });

  it('turns crawled pages into one valid flow per section with unique step ids', () => {
    const page = (route: string, name: string, section: string, kind: DiscoveredKind = 'page', actions: Action[] = []) => ({
      route,
      name,
      kind,
      actions,
      section,
      sectionName: section[0].toUpperCase() + section.slice(1),
    });
    const flows = discoveredFlows(
      {
        visited: 3,
        notes: [],
        steps: [
          page('/9/inspectors', 'Inspectors', 'inspectors'),
          page('/9/inspectors?tab=map', 'Map', 'inspectors'),
          page('/9/inspectors', 'Inspectors · Map', 'inspectors', 'tab', [{ kind: 'click', arg: 'role=tab[name="Map"s]' }]),
          page('/9/planning/schedule', 'Schedule', 'planning'),
        ],
      },
      ['desktop'],
    );
    expect(flows.map((f) => f.id)).toEqual(['_inspectors', '_planning']);
    expect(flows[0].steps.map((s) => s.id)).toEqual(['9-inspectors', '9-inspectors-tab-map', '9-inspectors-tab-map-2']);
    expect(flows[0].steps[2].actions).toEqual([{ kind: 'click', arg: 'role=tab[name="Map"s]' }]);
  });

  it('builds role selectors that survive counters in tab names', () => {
    expect(roleSelector('tab', 'Map')).toBe('role=tab[name="Map"s]');
    expect(roleSelector('tab', 'Violations 12')).toBe('role=tab[name=/^Violations/]');
  });

  it('keeps meaningful query params in route keys and collapses ids', () => {
    expect(routeKey(new URL('https://h/9/frames?imageQuality=rejected'))).toBe('/9/frames?imageQuality=rejected');
    expect(routeKey(new URL('https://h/9/inspectors/38717?page=2'))).toBe('/9/inspectors/:id?page=:v');
  });
});

describe('discovery of a shared app', () => {
  it('splits sections of one app (C&C + Sense) between products by the routes their catalogs open', () => {
    const ws = loadWorkspace({ root });
    const cnc = ws.products.find((p) => p.id === 'cnc')!;
    const sense = ws.products.find((p) => p.id === 'sense')!;
    expect(cnc.auth.profile).toBe(sense.auth.profile);
    expect(new URL(cnc.environments.stage.baseUrl).origin).toBe(new URL(sense.environments.stage.baseUrl).origin);
    const step = (route: string, section: string) => ({ route, name: section, kind: 'page' as const, actions: [], section, sectionName: section });
    const owner = assignSections(
      [step('/9/inspectors/38717', 'inspectors'), step('/frames?imageQuality=rejected', 'frames'), step('/frames/42', 'frames'), step('/9/planning', 'planning')],
      [cnc, sense],
      'stage',
    );
    expect(Object.fromEntries(owner)).toEqual({ inspectors: 'cnc', frames: 'sense', planning: 'cnc' });
  });
});
