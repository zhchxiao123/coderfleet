// Renders the main screens with Playwright for visual review.
//   PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers node scripts/screenshots.mjs <out-dir> [light|dark]
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { startPreview } from './preview.mjs';

const out = process.argv[2] || '/tmp/coderfleet-shots';
const scheme = process.argv[3] || 'light';
mkdirSync(out, { recursive: true });
const require = createRequire(join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'noop.js'));
const { chromium } = require('playwright');
const preview = await startPreview(5199);
const executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, colorScheme: scheme, deviceScaleFactor: 2 });
  const errors = globalThis.pageErrors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const shot = async name => { await page.waitForTimeout(500); await page.screenshot({ path: join(out, scheme + '-' + name + '.png') }); };
  await page.goto(preview.url);
  await page.waitForSelector('.sidebar:not([hidden])');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('.conv-item');
  // The latest conversation opens first: its build is still running after a failed test.
  await page.waitForSelector('.tool-running');
  await shot('chat-tools');
  await page.click('.conv-item:has-text("请帮我梳理")');
  await page.waitForSelector('.approval');
  await shot('chat-approval');
  await page.evaluate(() => { document.querySelector('.transcript').scrollTop = 0; });
  await shot('chat-markdown');
  await page.hover('.project-group-head >> nth=0');
  await page.click('.project-group-head .add >> nth=0');
  await shot('chat-new');
  await page.fill('.composer textarea', 'slow');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.running-status');
  await page.waitForTimeout(700);
  await shot('chat-running');
  await page.click('.send.stop');
  await page.waitForSelector('.turn-note');
  await page.click('.nav-item:has-text("项目")');
  await page.waitForSelector('.row');
  await shot('projects');
  await page.click('.page-head button:has-text("新建项目")');
  await shot('projects-new');
  await page.keyboard.press('Escape');
  await page.click('.nav-item:has-text("账号")');
  await page.waitForSelector('.row');
  await shot('accounts');
  await page.click('.page-head button:has-text("添加账号")');
  await shot('accounts-new');
  await page.keyboard.press('Escape');
  await page.click('.nav-item:has-text("设置")');
  await page.waitForSelector('text=代理与容器');
  await shot('settings');
  await page.click('button:has-text("通过 SSH 添加")');
  await page.fill('dialog input >> nth=0', '构建服务器');
  await page.fill('dialog input >> nth=1', 'dev@10.0.8.21');
  await shot('ssh-add');
  await page.click('button:has-text("连接并安装")');
  await page.waitForSelector('button:has-text("开始使用")', { timeout: 15000 });
  await shot('ssh-installed');
  await page.click('button:has-text("开始使用")');
  await page.click('.nav-item:has-text("项目")');
  await page.click('button[title="终端"] >> nth=0');
  await page.waitForSelector('.xterm-rows');
  await page.waitForTimeout(800);
  await page.click('.terminal-host');
  await page.keyboard.type('echo hello from the container\n', { delay: 15 });
  await page.waitForTimeout(800);
  await shot('terminal');
  console.log(errors.length ? 'Page errors:\n' + errors.join('\n') : 'No page errors');
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  await page?.screenshot({ path: join(out, scheme + '-error.png') });
  console.error(error.message.split('\n')[0]);
  console.error('Page errors:\n' + (globalThis.pageErrors || []).join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  await preview.close();
  process.exit(process.exitCode ?? 0);
}
