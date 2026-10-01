import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { findCachedChromium } from '../src/capture/browser.js';
import { saveSession } from '../src/capture/session.js';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Fresh copy of the test workspace + the real dictionary/taxonomy/assets. */
export function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrn-ws-'));
  fs.cpSync(path.join(ROOT, 'test/fixtures/workspace'), dir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'catalog/anonymize.yaml'), path.join(dir, 'catalog/anonymize.yaml'));
  fs.copyFileSync(path.join(ROOT, 'catalog/taxonomy.yaml'), path.join(dir, 'catalog/taxonomy.yaml'));
  fs.cpSync(path.join(ROOT, 'assets'), path.join(dir, 'assets'), { recursive: true });
  return dir;
}

export function chromiumPath(): string | undefined {
  return process.env.SCRN_CHROMIUM_PATH || findCachedChromium();
}

/** What a human does with `scrn auth mock`: log in through the form, persist the session. */
export async function login(root: string, baseUrl: string): Promise<string> {
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseUrl}/login`);
    await page.fill('input[name=user]', 'tester');
    await page.fill('input[name=password]', 'secret');
    await page.click('button');
    await page.waitForURL(/dashboard/);
    return await saveSession(context, page, { authDir: path.join(root, '.auth'), profile: 'mock', environment: 'stage', baseUrl });
  } finally {
    await browser.close();
  }
}
