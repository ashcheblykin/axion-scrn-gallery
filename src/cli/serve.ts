import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { EXPORT_FORMATS, EXPORT_VARIANTS, renderExport, SVG_MODES, type RenderOptions } from '../library/export.js';
import { INDEX_FILE, Library } from '../library/store.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
};

/** RFC 6266: ASCII fallback + UTF-8 name (Cyrillic flow names, "·"). */
export function contentDisposition(name: string, inline = false): string {
  const ascii = name.replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function oneOf<T extends string>(v: string | null, list: readonly T[]): T | undefined {
  return v && (list as readonly string[]).includes(v) ? (v as T) : undefined;
}

const numberParam = (v: string | null) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** /api/export?id=…&variant=…&format=png|svg&svg=vector|raster&scale=2&bg=blur&padding=64&radius=20&shadow=1&width=1600 */
export function exportOptions(q: URLSearchParams): RenderOptions {
  return {
    variant: oneOf(q.get('variant'), EXPORT_VARIANTS) ?? 'default',
    format: oneOf(q.get('format'), EXPORT_FORMATS),
    svgMode: oneOf(q.get('svg'), SVG_MODES),
    scale: numberParam(q.get('scale')),
    background: q.get('bg') ?? undefined,
    padding: numberParam(q.get('padding')),
    radius: numberParam(q.get('radius')),
    shadow: q.has('shadow') ? q.get('shadow') !== '0' && q.get('shadow') !== 'false' : undefined,
    width: numberParam(q.get('width')),
  };
}

/**
 * Local gallery server: static library files plus an export API, so the gallery can hand out any scale,
 * SVG (vector or raster) and slide backgrounds — things a file:// page cannot compute.
 */
export function serveLibrary(dir: string, port: number, host = '127.0.0.1'): Promise<http.Server> {
  const root = path.resolve(dir);
  let cached: { mtime: number; library: Library } | undefined;
  const library = () => {
    const f = path.join(root, INDEX_FILE);
    const mtime = fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0;
    if (!cached || cached.mtime !== mtime) cached = { mtime, library: Library.open(root) };
    return cached.library;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/api/ping') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, export: true }));
        return;
      }
      if (url.pathname === '/api/export') {
        const id = url.searchParams.get('id');
        if (!id) throw Object.assign(new Error('нужен id'), { status: 400 });
        const r = await renderExport(library(), id, exportOptions(url.searchParams));
        res.writeHead(200, {
          'content-type': r.mime,
          'content-length': r.data.length,
          'content-disposition': contentDisposition(r.name, url.searchParams.get('inline') === '1'),
          'cache-control': 'no-store',
          'x-scrn-size': `${r.width}x${r.height}`,
          ...(r.notes.length ? { 'x-scrn-notes': encodeURIComponent(r.notes.join(' · ')) } : {}),
        });
        res.end(r.data);
        return;
      }
      const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const file = path.resolve(root, `.${rel}`);
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 422;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

/** The first free port from `port` on (another `scrn serve` may already hold 4567). */
export async function serveOnFreePort(dir: string, port: number, attempts = 10): Promise<{ server: http.Server; url: string }> {
  for (let i = 0; i < attempts; i++) {
    try {
      const server = await serveLibrary(dir, port + i);
      const { port: actual } = server.address() as AddressInfo;
      return { server, url: `http://127.0.0.1:${actual}` };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error(`порты ${port}–${port + attempts - 1} заняты`);
}
