import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anonymizerInitScript, domConfig, fitLogo, logoOnDark, pipelineConfig } from '../src/capture/anonymize.js';
import { loadWorkspace } from '../src/config/load.js';
import { ProductSchema } from '../src/config/schema.js';
import { chromiumPath } from './helpers.js';

const root = path.resolve(import.meta.dirname, '..');
const ws = loadWorkspace({ root });
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: chromiumPath() });
});
afterAll(async () => {
  await browser?.close();
});

const product = ProductSchema.parse({
  id: 't',
  name: 'T',
  environments: { stage: { baseUrl: 'https://example.com' } },
  anonymize: {
    rules: [
      { selector: '.user-name', kind: 'person' },
      { selector: "[class*='plate' i]", kind: 'chars' },
      { selector: "[class*='phone' i]", kind: 'digits' },
    ],
    images: [{ selector: 'img.org-logo', with: 'logo' }],
  },
});

const PAGE = `<!doctype html><html><body style="margin:0;font-family:Arial">
<aside style="background:#0f172a;color:#fff;width:240px;padding:12px">
  <nav>
    <button aria-expanded="true">Planning</button>
    <div class="grid overflow-hidden transition-[grid-template-rows]">
      <a href="/a">Inspections &amp; schedule</a>
      <a href="/b">Violations 2024</a>
    </div>
    <div class="user-name">Alexander Shcheblykin</div>
  </nav>
  <img class="org-logo" id="dark-logo" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='32'/%3E" style="height:28px">
</aside>
<main>
  <h1 class="page-template">Route 66 checklist</h1>
  <table><tr><td class="plate">ABC 1234</td><td class="plate-label">Plate</td><td class="icon-phone">Call</td></tr></table>
  <div class="template-list">${'Weekly inspection. '.repeat(12)}</div>
  <header style="background:#fff"><img class="org-logo" id="light-logo" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='32'/%3E" style="height:28px"></header>
</main></body></html>`;

/** Init scripts run on navigation only — serve the page from a fake origin. */
async function open(page: import('playwright').Page) {
  await page.route('https://test.local/**', (route) => route.fulfill({ body: PAGE, contentType: 'text/html' }));
  await page.goto('https://test.local/');
  await page.evaluate(() => (window as unknown as { __scrnAnon: { apply(): void } }).__scrnAnon.apply());
}

describe('DOM anonymizer', () => {
  it('replaces sensitive values only: section names, headings and labels stay readable', async () => {
    const page = await browser.newPage();
    await page.addInitScript(anonymizerInitScript(pipelineConfig(ws.dictionary), await domConfig(root, product)));
    await open(page);
    const text = await page.evaluate(() => document.body.innerText);
    // navigation inside a container whose class matches the broad selector
    expect(text).toContain('Inspections & schedule');
    expect(text).toContain('Violations 2024');
    // the signed-in user inside the nav is still replaced
    expect(text).not.toContain('Shcheblykin');
    // a heading matched by accident is not a plate, a label without digits is not a plate, an icon class is not a phone
    expect(text).toContain('Route 66 checklist');
    expect(text).toContain('Weekly inspection');
    expect(text).toContain('Plate');
    expect(text).toContain('Call');
    // the real plate is scrambled, format kept
    const plate = await page.locator('td.plate').innerText();
    expect(plate).toMatch(/^[A-Z]{3} \d{4}$/);
    expect(plate).not.toBe('ABC 1234');
    await page.close();
  });

  it('puts the Axion mark on client logos: white on dark backgrounds, keeping the original box', async () => {
    const page = await browser.newPage();
    const cfg = await domConfig(root, product);
    await page.addInitScript(anonymizerInitScript(pipelineConfig(ws.dictionary), cfg));
    await open(page);
    const dark = await page.locator('#dark-logo').evaluate((el) => ({ src: (el as HTMLImageElement).src, w: el.getBoundingClientRect().width }));
    const light = await page.locator('#light-logo').getAttribute('src');
    expect(dark.src).toBe(cfg.logoOnDarkDataUri);
    expect(light).toBe(cfg.logoDataUri);
    expect(Math.round(dark.w)).toBe(105); // 120×32 at height 28 — unchanged by the swap
    const onLight = Buffer.from(cfg.logoDataUri.split(',')[1], 'base64').toString();
    const onDark = Buffer.from(cfg.logoOnDarkDataUri.split(',')[1], 'base64').toString();
    expect(onLight).toContain('fill="black"');
    expect(onDark).toContain('fill="#FFFFFF"');
    await page.close();
  });

  it('crops the logo to the mark and whitens only monochrome black marks', async () => {
    const fitted = await fitLogo('<svg width="140" height="140" viewBox="0 0 140 140" xmlns="http://www.w3.org/2000/svg"><rect x="20" y="40" width="100" height="60" fill="black"/></svg>');
    const vb = /viewBox="([^"]+)"/.exec(fitted)![1].split(' ').map(Number);
    expect(vb[0]).toBeGreaterThan(10);
    expect(vb[0]).toBeLessThan(20);
    expect(vb[2]).toBeLessThan(115);
    expect(logoOnDark('<svg><path fill="#3B5BDB"/></svg>')).toBe('<svg><path fill="#3B5BDB"/></svg>');
    expect(logoOnDark('<svg><path fill="black"/></svg>')).toBe('<svg><path fill="#FFFFFF"/></svg>');
  });
});
