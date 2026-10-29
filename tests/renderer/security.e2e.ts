import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mockIpc } from './mockIpc';
import { tagsOf } from '../support/tags';

// The preview server sends the production CSP from tauri.conf.json (vite.config.ts), so these
// run under the policy the packaged app enforces.

// Exactly what real ExifTool returns for tests/fixtures/hostile.xmp (asserted in
// src-tauri/tests/read_metadata.rs): decoded markup, as a plain string.
const HOSTILE_TITLE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
const HOSTILE_DESCRIPTION = '"><svg onload="window.__pwned=3"></svg>';

/** Records CSP violations from the very first script on, before the app loads. */
const watchCsp = (page: Page) =>
  page.addInitScript(() => {
    const seen: string[] = [];
    Object.assign(window, { __cspViolations: seen });
    document.addEventListener('securitypolicyviolation', (event) =>
      seen.push(`${event.violatedDirective} ${event.blockedURI}`),
    );
  });
const violations = (page: Page) =>
  page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);

/** Uses every UI area once: reads, drawers, both dialogs, theme. */
async function exerciseUi(page: Page) {
  await page.goto('/');
  const add = page.getByRole('button', { name: 'Add files…' });
  await add.click();
  await add.click();
  await page.getByRole('button', { name: /Actions/ }).click();
  await page.getByRole('button', { name: /Log/ }).click();
  await page.getByRole('combobox', { name: 'Theme' }).selectOption('dark');
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toContainText('/usr/bin/exiftool');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Shortcuts' }).click();
  await page.keyboard.press('Escape');
}

// @req SEC-001
test('normal use makes no request outside the app itself (offline by design)', async ({
  page,
  baseURL,
}) => {
  const outside: string[] = [];
  // Anything not served by the app is recorded and refused, as if the machine were offline.
  await page.route(
    (url) => url.origin !== new URL(baseURL ?? '').origin,
    (route) => {
      outside.push(route.request().url());
      return route.abort();
    },
  );
  await mockIpc(page);
  await exerciseUi(page);
  expect(outside).toEqual([]);
});

// @req SEC-001, SEC-003
test('the app runs under the production CSP without a single violation', async ({ page }) => {
  await watchCsp(page);
  await mockIpc(page);
  await exerciseUi(page);
  expect(await violations(page)).toEqual([]);
});

// @req SEC-003
test('hostile metadata renders as text and never runs', async ({ page }) => {
  await watchCsp(page);
  await mockIpc(page, [
    {
      error: null,
      warnings: [],
      sourceFile: '/home/user/<b>evil</b>/hostile.xmp',
      tags: tagsOf({ 'XMP-dc:Title': HOSTILE_TITLE, 'XMP-dc:Description': HOSTILE_DESCRIPTION }),
    },
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Add files…' }).click();
  await page.getByRole('button', { name: /Log/ }).click();

  const metadata = page.getByRole('region', { name: 'Metadata' });
  await expect(metadata).toContainText(HOSTILE_TITLE);
  await expect(metadata).toContainText(HOSTILE_DESCRIPTION);
  // No element was created from the metadata anywhere on the page, and nothing executed.
  expect(await page.locator('main img, #root img, #root script, #root svg, #root b').count()).toBe(
    0,
  );
  expect(
    await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
  ).toBeUndefined();
  expect(await violations(page)).toEqual([]);
});

// @req SEC-003
test('the CSP itself blocks injected inline script (defense in depth)', async ({ page }) => {
  await watchCsp(page);
  await mockIpc(page);
  await page.goto('/');
  await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__pwned = 4';
    document.body.append(script);
  });
  await expect.poll(() => violations(page)).toContainEqual(expect.stringMatching(/^script-src/));
  expect(
    await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
  ).toBeUndefined();
});
