import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { anonymizeJson, globToRegExp, pipelineConfig } from '../src/capture/anonymize.js';
import { loadWorkspace } from '../src/config/load.js';
import { createTextPipeline } from '../src/inpage/pipeline.js';

const ws = loadWorkspace({ root: path.resolve(import.meta.dirname, '..') });
const make = () => createTextPipeline(pipelineConfig(ws.dictionary));

describe('text pipeline', () => {
  it('maps a real person to the same persona every time, keeping the script', () => {
    const a = make().text('Report by Alexander Shcheblykin').out;
    const b = make().text('Report by Alexander Shcheblykin').out;
    expect(a).toBe(b);
    expect(a).not.toContain('Shcheblykin');
    const ru = make().text('Подготовил Александр Щеблыкин').out;
    expect(ru).not.toContain('Щеблыкин');
    expect(ru).toMatch(/[А-Яа-яЁё]/);
    expect(ws.dictionary.personas.cyrillic.some((p) => ru.includes(p))).toBe(true);
  });

  it('replaces client names as whole words in Latin and as substrings in Arabic', () => {
    const p = make();
    expect(p.text('MOMRA and Balady requests').out).toBe('Demo Ministry and Axion City requests');
    expect(p.text('Baladyville').out).toBe('Baladyville');
    expect(p.text('والبلدي').out).not.toContain('بلدي');
  });

  it('keeps the country code but changes every other digit of a phone', () => {
    const p = make();
    const out = p.text('Call +966 55 123 4567').out;
    expect(out).toMatch(/^Call \+966 \d\d \d{3} \d{4}$/);
    const digits = (s: string) => s.replace(/\D/g, '');
    const before = digits('+966 55 123 4567').slice(3);
    const after = digits(out).slice(3);
    for (let i = 0; i < before.length; i++) expect(after[i]).not.toBe(before[i]);
  });

  it('changes every character of a plate (no accidental survivors)', () => {
    const p = make();
    for (const plate of ['ABC 1234', 'XYZ 9876', 'KLM 5555']) {
      const out = p.byKind('chars', plate);
      expect(out).toMatch(/^[A-Z]{3} \d{4}$/);
      for (let i = 0; i < plate.length; i++) if (plate[i] !== ' ') expect(out[i]).not.toBe(plate[i]);
    }
  });

  it('rewrites e-mails to the safe domain and leaves safe ones alone', () => {
    const p = make();
    expect(p.text('mail a.shcheblykin@axionx.ai').out).toMatch(/@example\.com$/);
    expect(p.text('mail alex.morgan@example.com').out).toBe('mail alex.morgan@example.com');
  });

  it('guard finds blocklisted terms and raw PII, but not values it generated itself', () => {
    const p = make();
    const safe = p.text('Owner Varvara Spirina, MOMRA, x@y.com').out;
    expect(p.scan(safe)).toEqual([]);
    expect(p.scan('Owner Varvara Spirina from MOMRA, mail x@y.com')).toEqual(
      expect.arrayContaining(['varvara spirina', 'momra', 'email: x@y.com']),
    );
  });
});

describe('JSON (network layer)', () => {
  it('anonymizes content strings but not ids, enum constants or URLs', () => {
    const p = make();
    const { value, n } = anonymizeJson(
      {
        id: 'Varvara Spirina',
        owner: 'Varvara Spirina',
        status: 'BALADY_APPROVED',
        title: 'Weekly trend — Balady districts',
        logo: 'https://cdn.example/momra.svg',
        nested: [{ name: 'MOMRA' }],
      },
      p,
      new Set(['id', 'status']),
    );
    const v = value as Record<string, unknown>;
    expect(n).toBe(3);
    expect(v.id).toBe('Varvara Spirina');
    expect(v.owner).not.toContain('Varvara');
    expect(v.status).toBe('BALADY_APPROVED');
    expect(v.title).toBe('Weekly trend — Axion City districts');
    expect(v.logo).toBe('https://cdn.example/momra.svg');
    expect((v.nested as { name: string }[])[0].name).toBe('Demo Ministry');
  });
});

describe('network URL globs', () => {
  it('matches like Playwright globs', () => {
    expect(globToRegExp('**/api/**').test('https://h.ai/api/v1/kpi?x=1')).toBe(true);
    expect(globToRegExp('**/api/me').test('https://h.ai/api/me')).toBe(true);
    expect(globToRegExp('**/api/me').test('https://h.ai/api/members')).toBe(false);
    expect(globToRegExp('https://h.ai/*/x').test('https://h.ai/a/b/x')).toBe(false);
    expect(globToRegExp('**/*.{png,jpg}').test('https://h.ai/a/b.jpg')).toBe(true);
  });
});
