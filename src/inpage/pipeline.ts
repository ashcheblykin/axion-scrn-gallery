/**
 * Text anonymization pipeline shared by Node (API responses) and the page (DOM text).
 *
 * IMPORTANT: `createTextPipeline` is injected into the browser via `Function#toString()`,
 * so it must stay self-contained: no imports, no references to module scope.
 * Everything is deterministic (seeded by the original string) so the same real name becomes
 * the same persona on every screen and on every refresh — otherwise diffs would never settle.
 */

export type PipelineKind = 'person' | 'org' | 'email' | 'digits' | 'chars' | 'text' | 'lorem';

export interface PipelineConfig {
  personas: { latin: string[]; arabic: string[]; cyrillic: string[] };
  organizations: string[];
  people: string[];
  terms: { match: string; replace: string }[];
  patterns: { name: string; regex: string; flags?: string; kind: PipelineKind; value?: string }[];
  blocklist: string[];
  emailDomain: string;
}

export interface TextPipeline {
  /** Apply people → personas, terms, regex patterns. Returns the new text and how many replacements happened. */
  text(input: string): { out: string; n: number };
  /** Replace a whole value according to a kind (selector rules, JSON values). */
  byKind(kind: PipelineKind, original: string, value?: string): string;
  /** Lower-cased values produced by the pipeline — never re-anonymized, never reported by the guard. */
  generated: Set<string>;
  /** Blocklisted terms / real names / unsafe pattern matches found in a text. */
  scan(input: string, extraSafe?: Iterable<string>): string[];
  hash(input: string): number;
}

export function createTextPipeline(cfg: PipelineConfig): TextPipeline {
  const generated = new Set<string>();
  const ARABIC = /[؀-ۿ]/;
  const CYRILLIC = /[Ѐ-ӿ]/;
  const LOREM = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua'.split(' ');

  function hash(input: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function rng(seed: number): () => number {
    let x = seed || 0x9e3779b9;
    return () => {
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      return x / 4294967296;
    };
  }

  function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Unicode-aware whole-word literal; spaces inside the literal match any whitespace run. */
  function literalSource(s: string): string {
    return s
      .trim()
      .split(/\s+/)
      .map(escapeRe)
      .join('\\s+');
  }

  function normalize(s: string): string {
    return s
      .toLowerCase()
      .replace(/[ً-ٰٟـ]/g, '') // Arabic diacritics + tatweel
      .replace(/[إأآ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function remember(v: string): string {
    generated.add(v.toLowerCase());
    return v;
  }

  function pick<T>(list: T[], seed: string): T {
    return list[hash(normalize(seed)) % list.length];
  }

  function person(original: string): string {
    const list = ARABIC.test(original) ? cfg.personas.arabic : CYRILLIC.test(original) ? cfg.personas.cyrillic : cfg.personas.latin;
    const persona = pick(list, original);
    const tokens = original.trim().split(/\s+/).filter(Boolean).length;
    return tokens <= 1 ? persona.split(/\s+/)[0] : persona;
  }

  function email(original: string): string {
    const at = original.lastIndexOf('@');
    if (at > 0 && original.slice(at + 1).toLowerCase() === cfg.emailDomain.toLowerCase()) return original;
    const local = at > 0 ? original.slice(0, at) : original;
    const persona = pick(cfg.personas.latin, local);
    const handle = persona
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z\s]/g, '')
      .trim()
      .split(/\s+/)
      .join('.');
    return `${handle || 'user'}@${cfg.emailDomain}`;
  }

  /**
   * Format-preserving: digits become other digits, everything else stays. The country code
   * (after "+") or the first digit is kept so numbers still look plausible (+966 5…, 1… for IDs).
   */
  function digits(original: string): string {
    const next = rng(hash(original));
    let keep = original.trim().startsWith('+') ? 3 : 1;
    let out = '';
    for (const ch of original) {
      if (ch >= '0' && ch <= '9') {
        out += keep > 0 ? ch : other(ch, '0123456789', next);
        keep--;
      } else {
        out += ch;
      }
    }
    return out;
  }

  /** A random symbol from `alphabet` that is guaranteed to differ from `ch`. */
  function other(ch: string, alphabet: string, next: () => number): string {
    const pool = alphabet.replace(ch, '');
    return pool[Math.floor(next() * pool.length)];
  }

  /** Plates, IBANs, document numbers: every letter and digit changes, script and layout stay (Saudi plates mix Arabic and Latin). */
  function chars(original: string): string {
    const next = rng(hash(original));
    const alphabets = [
      '0123456789',
      '٠١٢٣٤٥٦٧٨٩',
      '۰۱۲۳۴۵۶۷۸۹',
      'ABCDEFGHJKLMNPRSTUVWXYZ',
      'abcdefghjkmnpqrstuvwxyz',
      'ابحدرسصطعقكلمنهوى',
      'АБВГДЕЖЗИКЛМНПРСТУФХЦЧШЭЮЯ',
      'абвгдежзиклмнпрстуфхцчшэюя',
    ];
    let out = '';
    for (const ch of original) {
      const alphabet = alphabets.find((a) => a.includes(ch)) ?? (/[A-Z]/.test(ch) ? alphabets[3] : /[a-z]/.test(ch) ? alphabets[4] : '');
      out += alphabet ? other(ch, alphabet, next) : ch;
    }
    return out;
  }

  function lorem(original: string): string {
    const next = rng(hash(original));
    return original.replace(/[\p{L}\p{N}]+/gu, (w) => {
      const word = LOREM[Math.floor(next() * LOREM.length)];
      return word.length >= w.length ? word.slice(0, Math.max(1, w.length)) : word;
    });
  }

  function byKind(kind: PipelineKind, original: string, value?: string): string {
    if (!original.trim()) return original;
    switch (kind) {
      case 'person':
        return remember(person(original));
      case 'org':
        return remember(pick(cfg.organizations, original));
      case 'email':
        return remember(email(original));
      case 'digits':
        return remember(digits(original));
      case 'chars':
        return remember(chars(original));
      case 'lorem':
        return remember(lorem(original));
      case 'text':
        return remember(value ?? '—');
    }
  }

  const people = [...new Set(cfg.people.map((p) => p.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  const peopleRe = people.length
    ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${people.map(literalSource).join('|')})(?![\\p{L}\\p{N}])`, 'giu')
    : null;

  const termMap = new Map<string, string>();
  for (const t of cfg.terms) termMap.set(normalize(t.match), t.replace);
  const termKeys = cfg.terms.map((t) => t.match.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  // Arabic terms often carry attached prefixes (و، ال، ب) — match them as substrings, Latin/Cyrillic as whole words.
  const termsRe = termKeys.length
    ? new RegExp(
        termKeys
          .map((t) => (ARABIC.test(t) ? literalSource(t) : `(?<![\\p{L}\\p{N}])${literalSource(t)}(?![\\p{L}\\p{N}])`))
          .join('|'),
        'giu',
      )
    : null;

  const patterns = cfg.patterns.map((p) => {
    const flags = new Set((p.flags ?? '').split(''));
    flags.add('g');
    flags.add('u');
    return { ...p, re: new RegExp(p.regex, [...flags].join('')) };
  });

  function text(input: string): { out: string; n: number } {
    let n = 0;
    let out = input;
    if (peopleRe) {
      out = out.replace(peopleRe, (m) => {
        n++;
        return remember(person(m));
      });
    }
    if (termsRe) {
      out = out.replace(termsRe, (m) => {
        const r = termMap.get(normalize(m));
        if (r === undefined) return m;
        n++;
        return remember(r);
      });
    }
    for (const p of patterns) {
      out = out.replace(p.re, (m) => {
        if (generated.has(m.toLowerCase())) return m;
        const r = byKind(p.kind, m, p.value);
        if (r !== m) n++;
        return r;
      });
    }
    return { out, n };
  }

  const blockTerms = [...new Set([...cfg.blocklist, ...cfg.people, ...cfg.terms.map((t) => t.match)].map(normalize).filter(Boolean))];
  const blockRes = blockTerms.map((t) => ({
    term: t,
    re: ARABIC.test(t)
      ? new RegExp(literalSource(t), 'iu')
      : new RegExp(`(?<![\\p{L}\\p{N}])${literalSource(t)}(?![\\p{L}\\p{N}])`, 'iu'),
  }));

  function scan(input: string, extraSafe?: Iterable<string>): string[] {
    const found = new Set<string>();
    const norm = normalize(input);
    for (const b of blockRes) if (b.re.test(norm)) found.add(b.term);
    const safe = new Set(generated);
    if (extraSafe) for (const s of extraSafe) safe.add(s.toLowerCase());
    for (const p of patterns) {
      p.re.lastIndex = 0;
      for (const m of input.matchAll(p.re)) {
        const v = m[0];
        if (safe.has(v.toLowerCase())) continue;
        if (p.kind === 'email' && v.toLowerCase().endsWith(`@${cfg.emailDomain.toLowerCase()}`)) continue;
        found.add(`${p.name}: ${v}`);
      }
    }
    return [...found];
  }

  return { text, byKind, generated, scan, hash };
}
