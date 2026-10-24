import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.ts';

const directory = await mkdtemp(join(tmpdir(), 'repropack-demo-browser-'));
const screenshots = fileURLToPath(new URL('../artifacts/demo-browser/', import.meta.url)); await mkdir(screenshots, { recursive: true });
const app = await createApp(directory, { demoMode: true }); let browser;
try {
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); const origin = `http://127.0.0.1:${app.server.address().port}`;
  try { browser = await chromium.launch({ headless: true }); }
  catch (error) { if (process.platform !== 'win32') throw error; browser = await chromium.launch({ headless: true, channel: 'msedge' }); }
  const first = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); const page = await first.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); await page.goto(origin);
  await page.getByRole('heading', { name: 'Try ReproPack', exact: true }).waitFor();
  await page.screenshot({ path: join(screenshots, 'welcome-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: /Open my demo/ }).click();
  await page.getByRole('button', { name: /Reduce scenario/ }).waitFor();
  assert.equal(await page.locator('.source-editor').count(), 0); assert.equal(await page.getByRole('button', { name: 'Account & team' }).count(), 0);
  assert.equal(await page.getByRole('combobox', { name: 'Application', exact: true }).locator('option').count(), 1);
  await page.getByRole('button', { name: /Reduce scenario/ }).click(); await page.getByText('Exact failure preserved in fresh replays.').waitFor({ timeout: 30_000 });
  const runs = await (await page.request.get(`${origin}/api/runs`)).json(); assert.equal(runs.length, 1); assert.equal(runs[0].reducedSteps, 5);
  await page.getByRole('button', { name: 'Check demo fix' }).click(); await page.getByText('Built-in demo fix: expected success observed in 3 fresh trials.').waitFor();
  const download = page.waitForEvent('download'); await page.getByRole('link', { name: /Export capsule/ }).click(); await (await download).saveAs(join(screenshots, 'demo-capsule.json'));
  assert.equal(JSON.parse(await readFile(join(screenshots, 'demo-capsule.json'), 'utf8')).steps.length, 5);
  await page.screenshot({ path: join(screenshots, 'reduced-desktop.png'), fullPage: true });
  const second = await browser.newContext({ viewport: { width: 390, height: 844 } }), other = await second.newPage(); other.on('pageerror', error => errors.push(error.message));
  await other.goto(origin + '/#invite=' + 'a'.repeat(64)); await other.getByRole('button', { name: 'TR', exact: true }).click();
  await other.getByRole('heading', { name: 'ReproPack’i dene', exact: true }).waitFor(); assert.ok(await other.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await other.screenshot({ path: join(screenshots, 'welcome-mobile-tr.png'), fullPage: true });
  await other.getByRole('button', { name: /Demomu aç/ }).click(); await other.getByRole('button', { name: /Senaryoyu küçült/ }).waitFor();
  assert.deepEqual(await (await other.request.get(`${origin}/api/runs`)).json(), []); assert.equal((await other.request.get(`${origin}/api/runs/${runs[0].id}/report`)).status(), 404);
  await page.getByRole('button', { name: 'TR', exact: true }).click(); await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.screenshot({ path: join(screenshots, 'reduced-mobile-tr.png'), fullPage: true });
  await page.getByRole('button', { name: /Demoyu bitir/ }).click(); await page.getByRole('heading', { name: 'ReproPack’i dene', exact: true }).waitFor();
  assert.equal((await page.request.get(`${origin}/api/runs`)).status(), 401); assert.equal((await other.request.get(`${origin}/api/runs`)).status(), 200);
  assert.deepEqual(errors, []); console.log('Demo browser gate passed: no signup, isolated visitors, real 16 → 5 reduction/fix/export, ended session, EN/TR 390px layouts.');
} finally { await browser?.close(); await app.dispose(); await rm(directory, { recursive: true, force: true }); }
