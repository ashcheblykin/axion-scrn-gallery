import type { Page } from 'playwright';
import { waitForNetworkIdle } from './actions.js';

export function stabilizeCss(hideScrollbars: boolean): string {
  return [
    `*, *::before, *::after {
      transition-duration: 0s !important; transition-delay: 0s !important;
      animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important;
      caret-color: transparent !important; scroll-behavior: auto !important;
    }`,
    hideScrollbars
      ? `*::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
         * { scrollbar-width: none !important; }`
      : '',
  ].join('\n');
}

export async function injectStyle(page: Page, id: string, css: string): Promise<void> {
  await page.evaluate(
    ({ id, css }) => {
      let el = document.getElementById(id) as HTMLStyleElement | null;
      if (!el) {
        el = document.createElement('style');
        el.id = id;
        (document.head ?? document.documentElement).appendChild(el);
      }
      el.textContent = css;
    },
    { id, css },
  );
}

export async function removeStyle(page: Page, id: string): Promise<void> {
  await page.evaluate((id) => document.getElementById(id)?.remove(), id).catch(() => undefined);
}

export function hideCss(selectors: string[]): string {
  return selectors.map((s) => `${s} { visibility: hidden !important; }`).join('\n');
}

export interface SettleOptions {
  networkIdleTimeoutMs: number;
  timeoutMs: number;
  settleMs: number;
  waitFor: string[];
  waitForHidden: string[];
  hide: string[];
  css?: string;
  hideScrollbars: boolean;
}

/** Bring the page to a still, fully loaded state before the shot. */
export async function settle(page: Page, o: SettleOptions): Promise<string[]> {
  const warnings: string[] = [];
  await page.waitForLoadState('domcontentloaded');
  await waitForNetworkIdle(page, o.networkIdleTimeoutMs);
  await injectStyle(page, 'scrn-stabilize', [stabilizeCss(o.hideScrollbars), hideCss(o.hide), o.css ?? ''].join('\n'));

  for (const sel of o.waitFor) {
    await page.locator(sel).first().waitFor({ state: 'visible', timeout: o.timeoutMs });
  }
  for (const sel of o.waitForHidden) {
    try {
      // Only wait for loaders that are actually on the page.
      if (await page.locator(sel).count()) {
        await page.locator(sel).first().waitFor({ state: 'hidden', timeout: o.timeoutMs });
      }
    } catch {
      warnings.push(`лоадер не исчез: ${sel}`);
    }
  }

  await page.evaluate(async () => {
    await (document as Document & { fonts?: FontFaceSet }).fonts?.ready;
    const imgs = Array.from(document.images).filter((img) => !img.complete);
    await Promise.race([
      Promise.all(
        imgs.map(
          (img) =>
            new Promise((r) => {
              img.addEventListener('load', r, { once: true });
              img.addEventListener('error', r, { once: true });
            }),
        ),
      ),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
  });
  await page.waitForTimeout(o.settleMs);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
  return warnings;
}
