import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoveredFlow, routeShape } from '../src/capture/discover.js';
import { expectedIds, parseTargets, planJobs, resolveStep } from '../src/capture/runner.js';
import { interpolateEnv, loadWorkspace } from '../src/config/load.js';
import { ActionSchema } from '../src/config/schema.js';
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

  it('turns crawled pages into a valid synthetic flow with unique step ids', () => {
    const flow = discoveredFlow(
      [
        { url: 'x', route: '/9/inspectors', text: 'Inspectors', depth: 1 },
        { url: 'y', route: '/9/inspectors?tab=map', text: '', depth: 1 },
      ],
      ['desktop'],
    );
    expect(flow?.id).toBe('_discovered');
    expect(flow?.steps.map((s) => s.id)).toEqual(['9-inspectors', '9-inspectors-2']);
  });
});
