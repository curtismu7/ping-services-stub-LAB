// E2E: start the server in mock mode, drive the real page with Playwright:
// toggle Mock/Real buttons, Exercise buttons fill the result pane.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const server = spawn('node', ['server/src/index.js'], {
  env: { ...process.env, SERVICE_MODE: 'mock', STANDALONE_ENV: '/nonexistent/.env', PORT: '6399' },
  stdio: 'inherit',
});
await new Promise((r) => setTimeout(r, 1500));
let fails = 0;
try {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:6399/');
  await page.waitForSelector('tr[data-p="pingfederate"] button');
  await page.waitForTimeout(300);
  const rows = await page.locator('table#services tbody tr').count();
  if (rows !== 6) { console.error(`FAIL: expected 6 service rows, got ${rows}`); fails++; }
  await page.locator('tr[data-p="pingfederate"] button', { hasText: 'Exercise' }).click();
  await page.waitForFunction(() => document.getElementById('result').innerText.includes('pingfederate'), null, { timeout: 10000 });
  const result = await page.locator('#result').innerText();
  if (!/pingfederate/.test(result)) { console.error('FAIL: exercise result not rendered'); fails++; }
  // real-btn is disabled (no settings) — assert it, don't click
  if (!(await page.locator('#real-btn').isDisabled())) { console.error('FAIL: real-btn should be disabled without settings'); fails++; }
  await page.locator('#reset-btn').click();
  await page.waitForTimeout(1500);
  const afterReset = await page.locator('table#services tbody tr td:nth-child(3)').first().innerText();
  if (!/UP/.test(afterReset)) { console.error('FAIL: services not refreshed after Reset'); fails++; }
  console.log(fails ? `e2e: ${fails} failure(s)` : 'e2e: all checks passed');
  await browser.close();
  process.exit(fails ? 1 : 0);
} finally {
  server.kill();
}
