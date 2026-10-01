import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ScreenRecord } from '../src/core/types.js';
import { emptyIndex, Library } from '../src/library/store.js';

function screen(id: string, flow: string): ScreenRecord {
  const [product, platform, , step] = id.split('.');
  const file = { path: `${product}/${platform}/${flow}/${step}.png`, width: 1, height: 1, bytes: 1 };
  return {
    id,
    product,
    platform,
    theme: 'default',
    locale: 'en',
    flow,
    flowName: flow,
    step,
    position: 1,
    title: step,
    source: flow === '_discovered' ? 'discover' : 'web',
    patterns: [],
    elements: [],
    tags: [],
    keywords: [],
    files: { default: file, thumb: file },
    sections: [],
    viewport: { width: 1, height: 1, scale: 1 },
    overflow: false,
    version: 1,
    hash: 'h',
    capturedAt: '',
    changedAt: '',
    status: 'ok',
    anonymization: { replacements: 0, images: 0, violations: [] },
  };
}

describe('orphans', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrn-lib-'));
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({
      ...emptyIndex(),
      screens: [screen('gen.desktop.flow.kept', 'flow'), screen('gen.desktop.flow.removed', 'flow'), screen('gen.desktop._discovered.x', '_discovered')],
    }),
  );

  it('marks removed catalog steps, but leaves discovered screens alone when discovery did not run', () => {
    const lib = Library.open(dir);
    const orphaned = lib.markOrphans(new Set(['gen.desktop.flow.kept']), new Set(['gen']), new Set());
    expect(orphaned).toEqual(['gen.desktop.flow.removed']);
    expect(lib.get('gen.desktop._discovered.x')?.status).toBe('ok');
  });

  it('judges discovered screens when discovery ran for the product', () => {
    const lib = Library.open(dir);
    expect(lib.markOrphans(new Set(['gen.desktop.flow.kept']), new Set(['gen']), new Set(['gen']))).toContain('gen.desktop._discovered.x');
  });
});
