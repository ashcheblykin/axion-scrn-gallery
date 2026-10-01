/**
 * Figma as a screen source (mobile Gen is ahead in Figma than in code).
 * REST API with a personal access token (FIGMA_TOKEN): render the frame to PNG at Retina scale and
 * pull its text layers so the privacy guard and full-text search work for design frames too.
 */

const API = 'https://api.figma.com/v1';

export interface FigmaFrame {
  buffer: Buffer;
  text: string;
  name: string;
}

export function normalizeNodeId(node: string): string {
  return node.replace('-', ':');
}

async function api<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, { headers: { 'X-Figma-Token': token } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Figma API ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

interface FigmaNode {
  name?: string;
  type?: string;
  characters?: string;
  visible?: boolean;
  children?: FigmaNode[];
}

function collectText(node: FigmaNode | undefined, out: string[]) {
  if (!node || node.visible === false) return;
  if (node.type === 'TEXT' && node.characters) out.push(node.characters);
  for (const c of node.children ?? []) collectText(c, out);
}

export async function exportFigmaFrame(source: { file: string; node: string; scale?: number }, defaultScale: number): Promise<FigmaFrame> {
  const token = process.env.FIGMA_TOKEN;
  if (!token) throw new Error('нужен FIGMA_TOKEN в .env (Figma → Settings → Security → Personal access tokens)');
  const id = normalizeNodeId(source.node);
  const scale = source.scale ?? defaultScale;

  const images = await api<{ err?: string; images: Record<string, string | null> }>(
    `${API}/images/${source.file}?ids=${encodeURIComponent(id)}&format=png&scale=${scale}`,
    token,
  );
  const url = images.images[id];
  if (!url) throw new Error(`Figma не отрендерила узел ${id}${images.err ? `: ${images.err}` : ''}`);
  const img = await fetch(url);
  if (!img.ok) throw new Error(`Figma image download ${img.status}`);
  const buffer = Buffer.from(await img.arrayBuffer());

  const nodes = await api<{ nodes: Record<string, { document: FigmaNode } | null> }>(
    `${API}/files/${source.file}/nodes?ids=${encodeURIComponent(id)}`,
    token,
  );
  const doc = nodes.nodes[id]?.document;
  const texts: string[] = [];
  collectText(doc, texts);
  return { buffer, text: texts.join('\n'), name: doc?.name ?? id };
}
