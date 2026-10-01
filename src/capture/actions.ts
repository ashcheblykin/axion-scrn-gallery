import type { Locator, Page } from 'playwright';
import type { Action } from '../config/schema.js';

export interface ActionContext {
  baseUrl: string;
  vars: Record<string, string | number>;
  timeoutMs: number;
  navigationTimeoutMs: number;
  networkIdleTimeoutMs: number;
}

/** `{org}` → vars.org; relative paths resolve against the environment baseUrl. */
export function resolveUrl(baseUrl: string, url: string, vars: Record<string, string | number>): string {
  const filled = url.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
  if (/^https?:\/\//i.test(filled)) return filled;
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(filled.replace(/^\//, ''), base).toString();
}

type TargetArg = string | { selector: string; nth?: number; force?: boolean; timeout?: number };

function target(page: Page, t: TargetArg): { locator: Locator; force?: boolean; timeout?: number } {
  if (typeof t === 'string') return { locator: page.locator(t).first() };
  const base = page.locator(t.selector);
  return { locator: t.nth !== undefined ? base.nth(t.nth) : base.first(), force: t.force, timeout: t.timeout };
}

export async function waitForNetworkIdle(page: Page, timeout: number): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {
    // Long-polling / websockets keep the network busy — settle on what we have.
  });
}

export async function runAction(page: Page, action: Action, ctx: ActionContext): Promise<void> {
  const timeout = ctx.timeoutMs;
  switch (action.kind) {
    case 'goto':
      await page.goto(resolveUrl(ctx.baseUrl, action.arg, ctx.vars), {
        waitUntil: 'domcontentloaded',
        timeout: ctx.navigationTimeoutMs,
      });
      await waitForNetworkIdle(page, ctx.networkIdleTimeoutMs);
      return;
    case 'click':
    case 'dblclick':
    case 'hover': {
      const t = target(page, action.arg);
      const opts = { timeout: t.timeout ?? timeout, force: t.force };
      if (action.kind === 'click') await t.locator.click(opts);
      else if (action.kind === 'dblclick') await t.locator.dblclick(opts);
      else await t.locator.hover(opts);
      await waitForNetworkIdle(page, Math.min(ctx.networkIdleTimeoutMs, 4000));
      return;
    }
    case 'fill':
      await page.locator(action.arg.selector).first().fill(action.arg.value, { timeout });
      return;
    case 'type':
      await page.locator(action.arg.selector).first().pressSequentially(action.arg.text, { delay: action.arg.delay ?? 20, timeout });
      return;
    case 'press':
      if (typeof action.arg === 'string') await page.keyboard.press(action.arg);
      else if (action.arg.selector) await page.locator(action.arg.selector).first().press(action.arg.key, { timeout });
      else await page.keyboard.press(action.arg.key);
      return;
    case 'select':
      await page.locator(action.arg.selector).first().selectOption(action.arg.value, { timeout });
      return;
    case 'check':
      await page.locator(action.arg).first().check({ timeout });
      return;
    case 'uncheck':
      await page.locator(action.arg).first().uncheck({ timeout });
      return;
    case 'scroll': {
      const { selector, to, by } = action.arg;
      await page.evaluate(
        ({ selector, to, by }) => {
          const el = selector ? document.querySelector(selector) : document.scrollingElement;
          if (!el) throw new Error(`scroll: не найден ${selector}`);
          if (typeof by === 'number') el.scrollTop += by;
          else if (to === 'top') el.scrollTop = 0;
          else if (to === 'bottom') el.scrollTop = el.scrollHeight;
          else if (typeof to === 'number') el.scrollTop = to;
        },
        { selector, to, by },
      );
      await page.waitForTimeout(250);
      return;
    }
    case 'scrollIntoView':
      await page.locator(action.arg).first().scrollIntoViewIfNeeded({ timeout });
      return;
    case 'wait':
      await page.waitForTimeout(action.arg);
      return;
    case 'waitFor': {
      const a = typeof action.arg === 'string' ? { selector: action.arg } : action.arg;
      await page.locator(a.selector).first().waitFor({ state: a.state ?? 'visible', timeout: a.timeout ?? timeout });
      return;
    }
    case 'waitForUrl':
      await page.waitForURL(new RegExp(action.arg), { timeout: ctx.navigationTimeoutMs });
      return;
    case 'waitForNetworkIdle':
      await waitForNetworkIdle(page, action.arg === true ? ctx.networkIdleTimeoutMs : action.arg);
      return;
    case 'evaluate':
      await page.evaluate(action.arg);
      return;
    case 'setViewport': {
      const vp = page.viewportSize() ?? { width: 1440, height: 900 };
      await page.setViewportSize({ width: action.arg.width ?? vp.width, height: action.arg.height ?? vp.height });
      return;
    }
    case 'localStorage':
      await page.evaluate((items) => {
        for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
      }, action.arg);
      return;
    case 'reload':
      await page.reload({ waitUntil: 'domcontentloaded', timeout: ctx.navigationTimeoutMs });
      await waitForNetworkIdle(page, ctx.networkIdleTimeoutMs);
      return;
    case 'emulate':
      await page.emulateMedia({
        colorScheme: action.arg.colorScheme ?? null,
        reducedMotion: action.arg.reducedMotion ?? null,
      });
      return;
    case 'mouse':
      await page.mouse.move(action.arg.x, action.arg.y);
      if (action.arg.click) await page.mouse.click(action.arg.x, action.arg.y);
      return;
  }
}

export async function runActions(page: Page, actions: Action[], ctx: ActionContext): Promise<void> {
  for (const [i, action] of actions.entries()) {
    try {
      await runAction(page, action, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      throw new Error(`действие #${i + 1} (${action.kind}): ${msg}`);
    }
  }
}
