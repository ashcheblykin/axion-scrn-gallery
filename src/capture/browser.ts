import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, devices, type Browser, type BrowserContextOptions } from 'playwright';
import type { Config, LocaleSpec, PlatformSpec, Product, Theme } from '../config/schema.js';

export interface LaunchOptions {
  headed?: boolean;
  slowMo?: number;
}

function browserCacheDirs(): string[] {
  const dirs = [process.env.PLAYWRIGHT_BROWSERS_PATH].filter(Boolean) as string[];
  const home = os.homedir();
  if (process.platform === 'darwin') dirs.push(path.join(home, 'Library', 'Caches', 'ms-playwright'));
  else if (process.platform === 'win32') dirs.push(path.join(home, 'AppData', 'Local', 'ms-playwright'));
  else dirs.push(path.join(home, '.cache', 'ms-playwright'));
  return dirs;
}

/** Newest Chromium already present in a Playwright cache — used when the pinned revision is missing. */
export function findCachedChromium(): string | undefined {
  const candidates: { rev: number; exe: string }[] = [];
  for (const dir of browserCacheDirs()) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const m = /^chromium-(\d+)$/.exec(entry);
      if (!m) continue;
      const base = path.join(dir, entry);
      const exes = [
        path.join(base, 'chrome-linux', 'chrome'),
        path.join(base, 'chrome-linux64', 'chrome'),
        path.join(base, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        path.join(base, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        path.join(base, 'chrome-win', 'chrome.exe'),
      ];
      const exe = exes.find((e) => fs.existsSync(e));
      if (exe) candidates.push({ rev: Number(m[1]), exe });
    }
  }
  candidates.sort((a, b) => b.rev - a.rev);
  return candidates[0]?.exe;
}

export async function launchBrowser(config: Config, opts: LaunchOptions = {}): Promise<Browser> {
  const explicit = process.env.SCRN_CHROMIUM_PATH || config.browser.executablePath;
  const base = {
    headless: !opts.headed,
    slowMo: opts.slowMo,
    args: ['--font-render-hinting=none', '--disable-lcd-text', ...config.browser.args],
  };
  if (explicit) return chromium.launch({ ...base, executablePath: explicit });
  try {
    return await chromium.launch(base);
  } catch (err) {
    const fallback = findCachedChromium();
    if (fallback && /Executable doesn't exist|browserType\.launch/i.test(String(err))) {
      return chromium.launch({ ...base, executablePath: fallback });
    }
    throw new Error(`Не удалось запустить Chromium. Установи браузер: npx playwright install chromium\n${String(err)}`);
  }
}

export interface ResolvedPlatform {
  name: string;
  width: number;
  height: number;
  scale: number;
  options: BrowserContextOptions;
}

export function resolvePlatform(config: Config, name: string): ResolvedPlatform {
  const spec: PlatformSpec | undefined = config.platforms[name];
  if (!spec) throw new Error(`Платформа "${name}" не описана в scrn.config.yaml → platforms`);
  const device = spec.device ? devices[spec.device] : undefined;
  if (spec.device && !device) throw new Error(`Неизвестное устройство Playwright: "${spec.device}"`);
  const width = spec.width ?? device?.viewport.width ?? 1440;
  const height = spec.height ?? device?.viewport.height ?? 900;
  const scale = spec.scale ?? device?.deviceScaleFactor ?? 2;
  const options: BrowserContextOptions = {
    ...(device ? { userAgent: device.userAgent, isMobile: device.isMobile, hasTouch: device.hasTouch } : {}),
    viewport: { width, height },
    screen: { width, height },
    deviceScaleFactor: scale,
  };
  if (spec.isMobile !== undefined) options.isMobile = spec.isMobile;
  if (spec.hasTouch !== undefined) options.hasTouch = spec.hasTouch;
  if (spec.userAgent) options.userAgent = spec.userAgent;
  return { name, width, height, scale, options };
}

export function contextOptions(args: {
  config: Config;
  product: Product;
  platform: ResolvedPlatform;
  theme: Theme;
  locale: LocaleSpec;
  storageState?: BrowserContextOptions['storageState'];
}): BrowserContextOptions {
  const { config, product, platform, theme, locale, storageState } = args;
  const opts: BrowserContextOptions = {
    ...platform.options,
    timezoneId: config.timezone,
    locale: locale.locale ?? 'en-US',
    colorScheme: theme.colorScheme ?? 'light',
    reducedMotion: 'reduce',
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block',
    storageState,
  };
  if (product.auth.httpCredentials?.username) opts.httpCredentials = product.auth.httpCredentials;
  if (Object.keys(product.auth.headers).length) opts.extraHTTPHeaders = product.auth.headers;
  return opts;
}
