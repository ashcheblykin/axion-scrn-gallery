import fs from 'node:fs';
import path from 'node:path';
import type { Product } from '../config/schema.js';
import { flowId, isAutoFlow, sectionPath, SVG_VARIANT, variantPath, type ScreenKey } from '../core/naming.js';
import type {
  CapturedScreen,
  FlowRecord,
  ImageFile,
  LibraryIndex,
  RunRecord,
  ScreenRecord,
  SectionRecord,
} from '../core/types.js';
import { compare, optimizePng, pixelHash, raw, size, thumbnail, type RawImage } from '../process/images.js';

export const INDEX_FILE = 'index.json';
const MAX_RUNS = 30;
/** [raster variant, its vector twin in ScreenRecord.files] */
const SVG_TWINS = Object.entries(SVG_VARIANT) as [keyof typeof SVG_VARIANT, (typeof SVG_VARIANT)[keyof typeof SVG_VARIANT]][];

export type IngestOutcome = 'added' | 'changed' | 'unchanged';

export interface IngestOptions {
  force?: boolean;
  threshold: number;
  pixelThreshold: number;
  thumbWidth: number;
  thumbQuality: number;
  /** Locale id that is not spelled out in file names (first locale of the product). */
  defaultLocale: string;
}

export function emptyIndex(): LibraryIndex {
  return { schemaVersion: 1, updatedAt: new Date(0).toISOString(), products: [], flows: [], screens: [], runs: [] };
}

export function isLfsPointer(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(40);
    fs.readSync(fd, buf, 0, 40, 0);
    fs.closeSync(fd);
    return buf.toString('utf8').startsWith('version https://git-lfs');
  } catch {
    return false;
  }
}

export class Library {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly root: string,
    public index: LibraryIndex,
  ) {}

  static open(root: string): Library {
    const file = path.join(root, INDEX_FILE);
    let index = emptyIndex();
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as LibraryIndex;
      index = { ...emptyIndex(), ...parsed };
    }
    return new Library(root, index);
  }

  abs(rel: string): string {
    return path.join(this.root, ...rel.split('/'));
  }

  get(id: string): ScreenRecord | undefined {
    return this.index.screens.find((s) => s.id === id);
  }

  /** Serialize mutations: captures run concurrently, index updates must not interleave. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async writeImage(rel: string, png: Buffer, optimize = true): Promise<ImageFile> {
    const file = this.abs(rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const data = optimize ? await optimizePng(png) : png;
    fs.writeFileSync(file, data);
    const { width, height } = await size(data);
    return { path: rel, width, height, bytes: data.length };
  }

  /** Vector files are written as is; width/height are the CSS px of the root <svg>. */
  private writeSvg(rel: string, svg: string): ImageFile {
    const file = this.abs(rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, svg);
    const head = svg.slice(0, 600);
    const dim = (name: string) => Math.round(Number(new RegExp(`\\s${name}="([\\d.]+)"`).exec(head)?.[1] ?? 0));
    return { path: rel, width: dim('width'), height: dim('height'), bytes: Buffer.byteLength(svg) };
  }

  private async writeThumb(rel: string, png: Buffer, o: IngestOptions): Promise<ImageFile> {
    const file = this.abs(rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const data = await thumbnail(png, o.thumbWidth, o.thumbQuality);
    fs.writeFileSync(file, data);
    const { width, height } = await size(data);
    return { path: rel, width, height, bytes: data.length };
  }

  private removeFile(rel: string | undefined) {
    if (!rel) return;
    const file = this.abs(rel);
    if (fs.existsSync(file)) fs.rmSync(file);
  }

  private async readRaw(rel: string): Promise<RawImage | undefined> {
    const file = this.abs(rel);
    if (!fs.existsSync(file) || isLfsPointer(file)) return undefined;
    try {
      return await raw(fs.readFileSync(file));
    } catch {
      return undefined;
    }
  }

  ingest(c: CapturedScreen, o: IngestOptions): Promise<{ outcome: IngestOutcome; ratio: number; record: ScreenRecord }> {
    return this.exclusive(() => this.ingestNow(c, o));
  }

  private async ingestNow(c: CapturedScreen, o: IngestOptions) {
    const now = new Date().toISOString();
    const key: ScreenKey = {
      product: c.product,
      platform: c.platform,
      flow: c.flow,
      step: c.step,
      theme: c.theme,
      locale: c.locale,
      position: isAutoFlow(c.flow) ? 0 : c.position,
    };
    const prev = this.get(c.id);
    const nextRaw = await raw(c.images.default);
    const hash = pixelHash(nextRaw);

    let outcome: IngestOutcome = 'added';
    let ratio = 1;
    if (prev) {
      outcome = 'changed';
      const sameLayout = prev.files.default.path === variantPath(key, o.defaultLocale, 'default');
      // New anonymization rules or logo: a fixed label is a few hundred pixels — below the threshold, but it must
      // replace the old picture. Identical pixels stay unchanged either way.
      const sameRendering = !c.fingerprint || prev.fingerprint === c.fingerprint;
      if (!o.force && sameLayout) {
        if (prev.hash === hash) {
          outcome = 'unchanged';
          ratio = 0;
        } else if (!sameRendering) {
          const prevRaw = await this.readRaw(prev.files.default.path);
          ratio = prevRaw ? compare(prevRaw, nextRaw, { pixelThreshold: o.pixelThreshold, ignore: c.ignoreRects }).ratio : 1;
        } else {
          const prevRaw = await this.readRaw(prev.files.default.path);
          if (prevRaw) {
            ratio = compare(prevRaw, nextRaw, { pixelThreshold: o.pixelThreshold, ignore: c.ignoreRects }).ratio;
            if (ratio <= o.threshold) outcome = 'unchanged';
          }
        }
      }
    }

    const writeAll = outcome !== 'unchanged';
    const files: ScreenRecord['files'] = writeAll || !prev ? ({} as ScreenRecord['files']) : { ...prev.files };

    if (writeAll) {
      if (prev) {
        // The step may have moved (renumbered) — drop files of the previous layout first.
        for (const f of Object.values(prev.files)) if (f) this.removeFile(f.path);
        for (const s of prev.sections) {
          this.removeFile(s.file.path);
          this.removeFile(s.thumb?.path);
          this.removeFile(s.svg?.path);
        }
      }
      files.default = await this.writeImage(variantPath(key, o.defaultLocale, 'default'), c.images.default);
      files.thumb = await this.writeThumb(variantPath(key, o.defaultLocale, 'thumb'), c.images.default, o);
      if (c.images.full) files.full = await this.writeImage(variantPath(key, o.defaultLocale, 'full'), c.images.full);
      if (c.images.clear) files.clear = await this.writeImage(variantPath(key, o.defaultLocale, 'clear'), c.images.clear);
      if (c.images.cards) files.cards = await this.writeImage(variantPath(key, o.defaultLocale, 'cards'), c.images.cards);
      for (const [variant, twin] of SVG_TWINS) {
        const svg = c.images.svg?.[variant];
        if (svg) files[twin] = this.writeSvg(variantPath(key, o.defaultLocale, twin), svg);
      }
    } else {
      // Unchanged screen, but variants enabled later (or files deleted by hand) are filled in.
      const fill = async (variant: 'full' | 'clear' | 'cards') => {
        const buf = c.images[variant];
        const existing = files[variant];
        if (buf && (!existing || !fs.existsSync(this.abs(existing.path)))) {
          files[variant] = await this.writeImage(variantPath(key, o.defaultLocale, variant), buf);
        }
      };
      await fill('full');
      await fill('clear');
      await fill('cards');
      // Same for vectors — but an existing SVG is not rewritten while the pixels stay the same (no git churn).
      for (const [variant, twin] of SVG_TWINS) {
        const svg = c.images.svg?.[variant];
        const existing = files[twin];
        if (svg && (!existing || !fs.existsSync(this.abs(existing.path)))) files[twin] = this.writeSvg(variantPath(key, o.defaultLocale, twin), svg);
      }
      if (!fs.existsSync(this.abs(files.thumb.path))) files.thumb = await this.writeThumb(files.thumb.path, c.images.default, o);
    }

    // Sections: rewritten with the screen, or when their set changed.
    let sections: SectionRecord[] = prev?.sections ?? [];
    const sameSections =
      !writeAll &&
      prev &&
      prev.sections.length === c.images.sections.length &&
      prev.sections.every((s, i) => s.section === c.images.sections[i]?.id && fs.existsSync(this.abs(s.file.path)));
    if (!sameSections) {
      if (prev && !writeAll) for (const s of prev.sections) {
        this.removeFile(s.file.path);
        this.removeFile(s.thumb?.path);
        this.removeFile(s.svg?.path);
      }
      sections = [];
      for (const s of c.images.sections) {
        const file = await this.writeImage(sectionPath(key, o.defaultLocale, s.id), s.buffer);
        const thumb = await this.writeThumb(sectionPath(key, o.defaultLocale, s.id, 'thumb'), s.buffer, o);
        const svg = s.svg ? this.writeSvg(sectionPath(key, o.defaultLocale, s.id, 'svg'), s.svg) : undefined;
        sections.push({
          id: `${c.id}--${s.id}`,
          screenId: c.id,
          section: s.id,
          name: s.name,
          description: s.description,
          patterns: s.patterns,
          elements: s.elements,
          tags: s.tags,
          file,
          thumb,
          svg,
        });
      }
    } else {
      // Names/tags from YAML may have changed even if the pixels did not; vectors enabled later are filled in.
      sections = prev!.sections.map((s, i) => {
        const src = c.images.sections[i];
        const svg =
          s.svg && fs.existsSync(this.abs(s.svg.path)) ? s.svg : src.svg ? this.writeSvg(sectionPath(key, o.defaultLocale, src.id, 'svg'), src.svg) : s.svg;
        return { ...s, name: src.name, description: src.description, patterns: src.patterns, elements: src.elements, tags: src.tags, svg };
      });
    }

    const record: ScreenRecord = {
      ...(prev ?? {}),
      id: c.id,
      product: c.product,
      platform: c.platform,
      theme: c.theme,
      locale: c.locale,
      flow: c.flow,
      flowName: c.flowName,
      step: c.step,
      position: c.position,
      title: c.title,
      description: c.description ?? prev?.description,
      brief: c.brief,
      source: c.source,
      route: c.route,
      patterns: mergeTags(c.patterns, prev?.tagging ? prev.patterns : []),
      elements: mergeTags(c.elements, prev?.tagging ? prev.elements : []),
      tags: c.tags,
      keywords: prev?.keywords ?? [],
      text: c.text,
      files,
      sections,
      viewport: c.viewport,
      overflow: c.overflow,
      fullHeight: c.fullHeight,
      version: writeAll ? (prev?.version ?? 0) + 1 : (prev?.version ?? 1),
      hash: writeAll ? hash : (prev?.hash ?? hash),
      capturedAt: now,
      changedAt: writeAll ? now : (prev?.changedAt ?? now),
      status: c.anonymization.violations.length ? 'unsafe' : prev?.anonymization.audit?.flagged && !writeAll ? 'review' : 'ok',
      error: undefined,
      anonymization: {
        replacements: c.anonymization.replacements,
        images: c.anonymization.images,
        violations: c.anonymization.violations,
        substitutes: c.anonymization.substitutes,
        audit: writeAll ? undefined : prev?.anonymization.audit,
      },
      tagging: writeAll ? undefined : prev?.tagging,
      fingerprint: c.fingerprint ?? prev?.fingerprint,
    };
    if (writeAll) {
      // Tagging is tied to pixels: a new version needs a fresh pass (scrn tag).
      record.quality = undefined;
      record.suggestedUse = undefined;
      if (prev?.tagging && prev.tagging.source !== 'heuristics') record.description = c.description;
    }

    this.upsert(record);
    return { outcome, ratio, record };
  }

  private upsert(record: ScreenRecord) {
    const i = this.index.screens.findIndex((s) => s.id === record.id);
    if (i >= 0) this.index.screens[i] = record;
    else this.index.screens.push(record);
  }

  update(id: string, patch: Partial<ScreenRecord>): ScreenRecord | undefined {
    const rec = this.get(id);
    if (!rec) return undefined;
    Object.assign(rec, patch);
    return rec;
  }

  markFailed(id: string, error: string) {
    const rec = this.get(id);
    if (rec) {
      rec.status = 'failed';
      rec.error = error;
    }
  }

  /**
   * Screens whose catalog step disappeared (only for products fully covered by the run).
   * Discovered screens are judged only where discovery actually ran in this run.
   */
  markOrphans(alive: Set<string>, coveredProducts: Set<string>, discoveredProducts: Set<string>): string[] {
    const orphaned: string[] = [];
    for (const s of this.index.screens) {
      if (!coveredProducts.has(s.product) || alive.has(s.id)) continue;
      if (isAutoFlow(s.flow) && !discoveredProducts.has(s.product)) continue;
      if (s.status !== 'orphaned') {
        s.status = 'orphaned';
        orphaned.push(s.id);
      }
    }
    return orphaned;
  }

  /** Drop a screen with all its files (duplicates, not orphans — those wait for --prune). */
  remove(id: string): boolean {
    const i = this.index.screens.findIndex((s) => s.id === id);
    if (i < 0) return false;
    const s = this.index.screens[i];
    for (const f of Object.values(s.files)) if (f) this.removeFile(f.path);
    for (const sec of s.sections) {
      this.removeFile(sec.file.path);
      this.removeFile(sec.thumb?.path);
      this.removeFile(sec.svg?.path);
    }
    this.index.screens.splice(i, 1);
    return true;
  }

  prune(): string[] {
    const removed: string[] = [];
    this.index.screens = this.index.screens.filter((s) => {
      if (s.status !== 'orphaned') return true;
      for (const f of Object.values(s.files)) if (f) this.removeFile(f.path);
      for (const sec of s.sections) {
        this.removeFile(sec.file.path);
        this.removeFile(sec.thumb?.path);
        this.removeFile(sec.svg?.path);
      }
      removed.push(s.id);
      return false;
    });
    return removed;
  }

  /** Flow records are derived from the catalog + what is actually in the library. */
  rebuildFlows(products: Product[]) {
    const flows: FlowRecord[] = [];
    const defaults = new Map(products.map((p) => [p.id, { theme: p.themes[0]?.id ?? 'default', locale: p.locales[0]?.id ?? 'en' }]));
    const groups = new Map<string, ScreenRecord[]>();
    for (const s of this.index.screens) {
      const d = defaults.get(s.product);
      if (s.status === 'orphaned' || (d && (s.theme !== d.theme || s.locale !== d.locale))) continue;
      const id = flowId(s.product, s.platform, s.flow);
      groups.set(id, [...(groups.get(id) ?? []), s]);
    }
    for (const [id, screens] of groups) {
      screens.sort((a, b) => a.position - b.position || a.step.localeCompare(b.step));
      const first = screens[0];
      const product = products.find((p) => p.id === first.product);
      const flow = product?.flows.find((f) => f.id === first.flow);
      flows.push({
        id,
        product: first.product,
        platform: first.platform,
        flow: first.flow,
        name: flow?.name ?? first.flowName,
        description: flow?.description ?? (isAutoFlow(first.flow) ? 'Найдено обходом навигации: страницы раздела, вкладки, панели и карточки.' : undefined),
        brief: flow?.brief,
        actions: flow?.actions ?? (isAutoFlow(first.flow) ? ['Navigating'] : []),
        tags: flow?.tags ?? (isAutoFlow(first.flow) ? ['auto'] : []),
        steps: screens.map((s) => s.id),
      });
    }
    this.index.flows = flows.sort((a, b) => a.id.localeCompare(b.id));
    this.index.products = products.map((p) => ({ id: p.id, name: p.name, description: p.description, platforms: p.platforms }));
  }

  addRun(run: RunRecord) {
    this.index.runs = [run, ...this.index.runs].slice(0, MAX_RUNS);
  }

  save() {
    this.index.updatedAt = new Date().toISOString();
    this.index.screens.sort((a, b) => a.id.localeCompare(b.id));
    fs.mkdirSync(this.root, { recursive: true });
    const file = path.join(this.root, INDEX_FILE);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.index, null, 2)}\n`);
    fs.renameSync(tmp, file);
  }
}

function mergeTags(primary: string[], extra: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...primary, ...extra]) {
    const k = t.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}
