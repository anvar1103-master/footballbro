/**
 * Visual smoke test: starts the game in headless Chromium and saves screenshots.
 * Usage: npm run shots -- [url=http://localhost:5173/] [outDir=screenshots]
 * Needs a running dev/preview server. Query params: ?watch (AI vs AI), ?autostart, &size=5|7|11
 */
import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://localhost:5173/';
const out = process.argv[3] ?? 'screenshots';
const shots = (process.env.SHOTS ?? 'menu,match').split(',');

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
if (shots.includes('menu')) {
  await page.goto(url);
  await page.waitForSelector('.menu', { timeout: 60000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/menu.png` });
}
if (shots.includes('match')) {
  await page.goto(url + (url.includes('?') ? '&' : '?') + 'watch&lq&size=' + (process.env.SIZE ?? '11'));
  await page.waitForSelector('.scoreboard', { timeout: 60000 });
  for (const t of [3, 9, 18]) {
    await page.waitForTimeout(t * 1000 - (t === 3 ? 0 : t === 9 ? 3000 : 9000));
    await page.screenshot({ path: `${out}/match-${t}s.png` });
  }
}
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console errors');
await browser.close();
