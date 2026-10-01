import fs from 'node:fs';
import path from 'node:path';
import { humanFileName } from '../core/naming.js';
import type { LibraryIndex, ScreenRecord, SectionRecord } from '../core/types.js';
import { composeCards, composeFramed, layeredSvg } from '../process/compose.js';
import { isLfsPointer, type Library } from './store.js';

export const EXPORT_VARIANTS = ['default', 'full', 'clear', 'cards', 'framed', 'layers'] as const;
export type ExportVariant = (typeof EXPORT_VARIANTS)[number];

export interface ExportRequest {
  /** Screen ids or section ids (`<screenId>--<section>`). */
  ids: string[];
  variant: ExportVariant;
  /** framed: transparent | white | black | gradient | blur | #hex | image path */
  background?: string;
  /** CSS px (multiplied by the screen scale). */
  padding?: number;
  radius?: number;
  shadow?: boolean;
  width?: number;
  outDir: string;
}

export interface ExportedFile {
  id: string;
  file: string;
  variant: string;
}

function readImage(library: Library, rel: string): Buffer {
  const file = library.abs(rel);
  if (!fs.existsSync(file)) throw new Error(`нет файла ${rel} — пересними экран (scrn capture)`);
  if (isLfsPointer(file)) throw new Error(`${rel} — это LFS-указатель, выполни: git lfs pull`);
  return fs.readFileSync(file);
}

function resolve(index: LibraryIndex, id: string): { screen: ScreenRecord; section?: SectionRecord } {
  const screen = index.screens.find((s) => s.id === id);
  if (screen) return { screen };
  for (const s of index.screens) {
    const section = s.sections.find((x) => x.id === id);
    if (section) return { screen: s, section };
  }
  throw new Error(`экран или секция не найдены: ${id}`);
}

export async function exportScreens(library: Library, req: ExportRequest): Promise<ExportedFile[]> {
  fs.mkdirSync(req.outDir, { recursive: true });
  const productNames = new Map(library.index.products.map((p) => [p.id, p.name]));
  const out: ExportedFile[] = [];

  for (const id of req.ids) {
    const { screen, section } = resolve(library.index, id);
    const scale = screen.viewport.scale;
    const name = (variant: string, ext = 'png') =>
      humanFileName({
        productName: productNames.get(screen.product) ?? screen.product,
        flowName: screen.flowName,
        position: screen.position,
        title: section ? `${screen.title} — ${section.name}` : screen.title,
        platform: screen.platform,
        theme: screen.theme,
        locale: screen.locale,
        variant,
        ext,
      });
    const write = (data: Buffer, variant: string, ext = 'png') => {
      const file = path.join(req.outDir, name(variant, ext));
      fs.writeFileSync(file, data);
      out.push({ id, file, variant });
    };

    const framed = (buf: Buffer) =>
      composeFramed(buf, {
        background: req.background ?? 'gradient',
        padding: Math.round((req.padding ?? 64) * scale),
        radius: Math.round((req.radius ?? 20) * scale),
        shadow: req.shadow ?? true,
        width: req.width,
      });

    if (section) {
      const buf = readImage(library, section.file.path);
      // Sections already carry their own rounded shape and shadow inside a transparent margin.
      if (req.variant === 'framed') {
        write(
          await composeFramed(buf, {
            background: req.background ?? 'gradient',
            padding: Math.round((req.padding ?? 48) * scale),
            radius: 0,
            shadow: false,
            width: req.width,
          }),
          'framed',
        );
      } else write(buf, 'section');
      continue;
    }

    switch (req.variant) {
      case 'default':
      case 'full':
      case 'clear': {
        const f = screen.files[req.variant] ?? (req.variant === 'full' ? screen.files.default : undefined);
        if (!f) throw new Error(`${id}: варианта ${req.variant} нет (включи variants.${req.variant} и пересними)`);
        write(readImage(library, f.path), req.variant);
        break;
      }
      case 'cards': {
        const f = screen.files.cards ?? screen.files.clear;
        if (!f) throw new Error(`${id}: нет прозрачных вариантов — включи variants.cards в scrn.config.yaml`);
        write(await composeCards(readImage(library, f.path), Math.round((req.padding ?? 0) * scale)), 'cards');
        break;
      }
      case 'framed':
        write(await framed(readImage(library, screen.files.default.path)), 'framed');
        break;
      case 'layers': {
        const layers = [{ id: 'screen', png: readImage(library, screen.files.default.path) }];
        if (screen.files.clear) layers.push({ id: 'content-no-background', png: readImage(library, screen.files.clear.path) });
        write(await layeredSvg(layers, scale), 'layers', 'svg');
        break;
      }
    }
  }
  return out;
}
