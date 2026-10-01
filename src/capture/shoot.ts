import type { Page } from 'playwright';
import type { Section } from '../config/schema.js';
import { injectStyle, removeStyle } from './stabilize.js';

const SHOT = { type: 'png', animations: 'disabled', caret: 'hide', scale: 'device' } as const;

export async function shootViewport(page: Page): Promise<Buffer> {
  return page.screenshot({ ...SHOT });
}

/** How tall the viewport must be to show everything, given the inner scroll container marked by inspectPage. */
async function neededHeight(page: Page): Promise<number> {
  return page.evaluate(() => {
    const doc = document.scrollingElement ?? document.documentElement;
    const sc = document.querySelector('[data-scrn-scroll]') as HTMLElement | null;
    const extra = sc ? Math.max(0, sc.scrollHeight - sc.clientHeight) : 0;
    return Math.ceil(Math.max(doc.scrollHeight, window.innerHeight + extra));
  });
}

/**
 * Grow the viewport until the inner scroll container fits its content, run `fn`, then restore.
 * Growing the viewport (instead of rewriting overflow CSS) keeps 100vh/flex layouts intact.
 */
export async function withExpandedViewport<T>(page: Page, maxHeight: number, fn: (height: number) => Promise<T>): Promise<T> {
  const original = page.viewportSize();
  if (!original) return fn(0);
  const scroll = await page.evaluate(() => {
    const sc = document.querySelector('[data-scrn-scroll]') as HTMLElement | null;
    const s = { win: window.scrollY, inner: sc?.scrollTop ?? 0 };
    if (sc) sc.scrollTop = 0;
    window.scrollTo(0, 0);
    return s;
  });
  let height = original.height;
  for (let i = 0; i < 4; i++) {
    const need = Math.min(maxHeight, await neededHeight(page));
    if (need <= height + 1) break;
    height = need;
    await page.setViewportSize({ width: original.width, height });
    await page.waitForTimeout(350);
  }
  try {
    return await fn(height);
  } finally {
    await page.setViewportSize(original);
    await page.evaluate((s) => {
      const sc = document.querySelector('[data-scrn-scroll]') as HTMLElement | null;
      if (sc) sc.scrollTop = s.inner;
      window.scrollTo(0, s.win);
    }, scroll);
    await page.waitForTimeout(200);
  }
}

export async function shootFull(page: Page, maxHeight: number): Promise<{ buffer: Buffer; height: number }> {
  return withExpandedViewport(page, maxHeight, async (height) => ({
    buffer: await page.screenshot({ ...SHOT, fullPage: true }),
    height,
  }));
}

function clearCss(backdrop: string[], chrome: string[] = []): string {
  const bg = backdrop.length
    ? `${backdrop.join(', ')} { background: transparent !important; background-color: transparent !important; background-image: none !important; box-shadow: none !important; }`
    : '';
  const hidden = chrome.length ? `${chrome.join(', ')} { visibility: hidden !important; }` : '';
  return `${bg}\n${hidden}`;
}

/** App background removed — cards and panels keep their own fills. */
export async function shootClear(page: Page, backdrop: string[]): Promise<Buffer> {
  await injectStyle(page, 'scrn-clear', clearCss(backdrop));
  try {
    return await page.screenshot({ ...SHOT, omitBackground: true });
  } finally {
    await removeStyle(page, 'scrn-clear');
  }
}

/** Background and app chrome (sidebar, top bar) removed: only the content cards stay. */
export async function shootCards(page: Page, backdrop: string[], chrome: string[]): Promise<Buffer> {
  await injectStyle(page, 'scrn-clear', clearCss(backdrop, chrome));
  try {
    return await page.screenshot({ ...SHOT, omitBackground: true });
  } finally {
    await removeStyle(page, 'scrn-clear');
  }
}

const ISOLATE_CSS = (fill?: string) => `
html, body { background: transparent !important; background-image: none !important; }
body * { visibility: hidden !important; }
[data-scrn-isolate], [data-scrn-isolate] * { visibility: visible !important; }
${fill ? `[data-scrn-isolate] { background-color: ${fill} !important; }` : ''}
`;

export interface SectionShot {
  buffer: Buffer;
  /** Border radius of the element in device px (for optional masking). */
  radius: number;
  padding: number;
}

/**
 * An isolated element ("плашка"): everything else on the page is hidden, the background is transparent,
 * the element keeps its own rounded corners and shadow (captured inside the transparent padding).
 */
export async function shootSection(page: Page, section: Section, opts: { maxHeight: number; timeoutMs: number; scale: number }): Promise<SectionShot> {
  const base = page.locator(section.selector);
  const locator = section.nth !== undefined ? base.nth(section.nth) : base.first();
  await locator.waitFor({ state: 'visible', timeout: opts.timeoutMs });

  const run = async (): Promise<SectionShot> => {
    await locator.scrollIntoViewIfNeeded({ timeout: opts.timeoutMs });
    const radiusCss = await locator.evaluate((el) => {
      el.setAttribute('data-scrn-isolate', '1');
      return parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    });
    await injectStyle(page, 'scrn-isolate', ISOLATE_CSS(section.fill));
    try {
      const box = await locator.boundingBox();
      if (!box) throw new Error(`section ${section.id}: элемент не отрисован`);
      const vp = page.viewportSize() ?? { width: 1440, height: 900 };
      const pad = section.padding;
      const x = Math.max(0, box.x - pad);
      const y = Math.max(0, box.y - pad);
      const clip = {
        x,
        y,
        width: Math.min(vp.width, box.x + box.width + pad) - x,
        height: Math.min(vp.height, box.y + box.height + pad) - y,
      };
      const buffer = await page.screenshot({ ...SHOT, omitBackground: true, clip });
      return { buffer, radius: (section.radius ?? radiusCss) * opts.scale, padding: pad * opts.scale };
    } finally {
      await removeStyle(page, 'scrn-isolate');
      await locator.evaluate((el) => el.removeAttribute('data-scrn-isolate')).catch(() => undefined);
    }
  };

  const box = await locator.boundingBox();
  const vp = page.viewportSize();
  const fits = box && vp && box.height + section.padding * 2 <= vp.height;
  return fits ? run() : withExpandedViewport(page, opts.maxHeight, run);
}
