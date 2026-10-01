import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, BrowserContextOptions, Page } from 'playwright';
import type { Product } from '../config/schema.js';

/**
 * SSO/2FA sessions are captured once by a human (`scrn auth <product>`) and reused by the engine:
 * cookies + localStorage + IndexedDB (Playwright storageState) + sessionStorage (restored by an init script).
 */

export type StorageState = Exclude<BrowserContextOptions['storageState'], string | undefined>;

export interface SessionFile {
  profile: string;
  environment: string;
  baseUrl: string;
  savedAt: string;
  storageState: StorageState;
  sessionStorage: Record<string, Record<string, string>>;
}

export const DEFAULT_LOGIN_URL_RE = /(login|signin|sign-in|sso|oauth|openid|keycloak|realms\/|auth\/)/i;

export function authProfile(product: Product): string {
  return product.auth.profile ?? product.id;
}

export function sessionPath(authDir: string, profile: string, env: string): string {
  return path.join(authDir, `${profile}-${env}.json`);
}

export function loadSession(authDir: string, profile: string, env: string): SessionFile | undefined {
  const file = sessionPath(authDir, profile, env);
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as SessionFile;
  } catch {
    return undefined;
  }
}

export async function saveSession(
  context: BrowserContext,
  page: Page,
  meta: { authDir: string; profile: string; environment: string; baseUrl: string },
): Promise<string> {
  const storageState = (await context.storageState({ indexedDB: true })) as StorageState;
  const sessionStorage: Record<string, Record<string, string>> = {};
  for (const p of context.pages()) {
    try {
      const { origin, items } = await p.evaluate(() => {
        const data: Record<string, string> = {};
        for (let i = 0; i < window.sessionStorage.length; i++) {
          const k = window.sessionStorage.key(i);
          if (k && k !== '__scrn_restored') data[k] = window.sessionStorage.getItem(k) ?? '';
        }
        return { origin: location.origin, items: data };
      });
      if (Object.keys(items).length) sessionStorage[origin] = { ...(sessionStorage[origin] ?? {}), ...items };
    } catch {
      // page navigated away while saving
    }
  }
  void page;
  const file: SessionFile = {
    profile: meta.profile,
    environment: meta.environment,
    baseUrl: meta.baseUrl,
    savedAt: new Date().toISOString(),
    storageState,
    sessionStorage,
  };
  fs.mkdirSync(meta.authDir, { recursive: true, mode: 0o700 });
  const target = sessionPath(meta.authDir, meta.profile, meta.environment);
  fs.writeFileSync(target, JSON.stringify(file, null, 2), { mode: 0o600 });
  return target;
}

/** Init script that restores sessionStorage once per tab, before the app boots. */
export function sessionStorageInitScript(session: SessionFile | undefined): string | undefined {
  if (!session || !Object.keys(session.sessionStorage ?? {}).length) return undefined;
  return `(() => {
    const all = ${JSON.stringify(session.sessionStorage)};
    try {
      const data = all[location.origin];
      if (!data || sessionStorage.getItem('__scrn_restored')) return;
      for (const [k, v] of Object.entries(data)) sessionStorage.setItem(k, v);
      sessionStorage.setItem('__scrn_restored', '1');
    } catch (e) {}
  })();`;
}

export async function isLoggedIn(page: Page, product: Product): Promise<boolean> {
  const rule = product.auth.loggedIn;
  const url = page.url();
  if (rule.urlMatches && !new RegExp(rule.urlMatches, 'i').test(url)) return false;
  const notRe = rule.urlNotMatches ? new RegExp(rule.urlNotMatches, 'i') : DEFAULT_LOGIN_URL_RE;
  if (notRe.test(new URL(url).pathname + new URL(url).search)) return false;
  if (rule.selector) {
    try {
      return await page.locator(rule.selector).first().isVisible();
    } catch {
      return false;
    }
  }
  // No selector configured: a password field or a "Sign in / Войти" button means we are not inside yet.
  const onLoginForm = await page
    .locator('input[type=password]')
    .first()
    .isVisible()
    .catch(() => false);
  if (onLoginForm) return false;
  const signInButton = await page
    .getByRole('button', { name: LOGIN_BUTTON_RE })
    .or(page.getByRole('link', { name: LOGIN_BUTTON_RE }))
    .first()
    .isVisible()
    .catch(() => false);
  return !signInButton;
}

/** Whole-label match: "Sign in", "Войти через SSO", "Continue with Microsoft" — but not "Login history". */
const LOGIN_BUTTON_RE = /^\s*(?:sign\s*in|log\s*in|login|войти|вход|تسجيل الدخول)(?:\s+(?:with|via|через|с помощью)\s+.+)?\s*$|^\s*continue with\s+\S+\s*$/i;

export function sessionAgeDays(session: SessionFile): number {
  return (Date.now() - Date.parse(session.savedAt)) / 86_400_000;
}
