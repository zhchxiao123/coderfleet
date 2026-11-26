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
  // 项目 / 账号 / 通用 are tabs of the settings screen, opened from the rail.
  const openTab = async tab => {
    if (!(await page.$('.settings-tab'))) await page.click('.rail-btn[title^="设置"]');
    await page.click('.settings-tab:has-text("' + tab + '")');
  };
  const shot = async name => { await page.waitForTimeout(500); await page.screenshot({ path: join(out, scheme + '-' + name + '.png') }); };
  await page.goto(preview.url);
  await page.waitForSelector('.sidebar:not([hidden])');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('.conv-item');
  // The latest conversation opens first: its build is still running after a failed test.
  await page.waitForSelector('.tool-running');
  await shot('chat-tools');
  // Expand a finished tool call to show its input and output.
  await page.click('.tool-toggle.tool-completed >> nth=0').catch(async () => {
    await page.click('.flow > button.flow-row >> nth=0');
    await page.click('.tool-toggle >> nth=0');
  });
  await page.waitForSelector('.tool-panel .label');
  await shot('chat-tool-open');
  // Neither the sidebar nor the transcript may scroll sideways.
  const overflow = await page.evaluate(() => {
    const found = ['.sidebar-scroll', '.transcript'].map(selector => {
      const node = document.querySelector(selector);
      return node && node.scrollWidth > node.clientWidth + 1 ? selector + ' ' + node.scrollWidth + '>' + node.clientWidth : null;
    });
    // Nothing in the transcript may stick out of the chat column (clipped overflow hides it from scrollWidth).
    const column = document.querySelector('.transcript-inner')?.getBoundingClientRect();
    for (const node of document.querySelectorAll('.turn *')) {
      const rect = node.getBoundingClientRect();
      if (column && rect.width && rect.right > column.right + 1) { found.push('sticks out: ' + node.className + ' ' + Math.round(rect.right) + '>' + Math.round(column.right)); break; }
    }
    return found.filter(Boolean);
  });
  if (overflow.length) errors.push('horizontal overflow: ' + overflow.join(', '));
  await page.click('.conv-item:has-text("请帮我梳理")');
  await page.waitForSelector('.approval');
  await shot('chat-approval');
  await page.evaluate(() => { document.querySelector('.transcript').scrollTop = 0; });
  await shot('chat-markdown');
  await page.locator('.send-card').first().scrollIntoViewIfNeeded();
  await shot('send-card');
  await page.click('.files-toggle');
  await page.waitForSelector('.file-row:has-text("README.md")');
  await shot('files');
  await page.click('.file-row:has-text("README.md")');
  await page.waitForSelector('.file-markdown');
  await shot('file-preview');
  await page.keyboard.press('Escape');
  await page.click('.files-panel button[title="关闭"]');
  // Conversation actions: ⋯ on hover, archive, then the 已归档 section.
  await page.hover('.conv-item:has-text("修一下登录页") >> nth=0');
  await page.click('.conv-item:has-text("修一下登录页") >> nth=0 >> .conv-actions');
  await page.waitForSelector('.menu');
  await shot('conv-menu');
  await page.click('.menu button:has-text("归档")');
  await page.click('.recent-head:has-text("已归档")');
  await page.waitForSelector('.recent-group:has-text("已归档") .conv-item:has-text("修一下登录页")');
  await shot('archived');
  await page.hover('.project-group-head:not(.recent-head) >> nth=0');
  await page.click('.project-group-head .add:not(.group-more) >> nth=0');
  await shot('chat-new');
  await page.fill('.composer textarea', 'slow');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.running-status');
  await page.waitForTimeout(700);
  await shot('chat-running');
  await page.click('.sidebar-toggle');
  await shot('chat-sidebar-hidden');
  await page.click('.sidebar-toggle');
  await page.click('.send.stop');
  await page.waitForSelector('.turn-note');
  // A job waiting for review: the card over the top-right corner, then accepting it.
  await page.click('.conv-item:has-text("端口改成读环境变量")');
  // In a window this narrow the card is folded into the top bar's button and opens from there.
  await page.waitForSelector('.job-button:has-text("待验收")');
  await shot('job-folded');
  await page.click('.job-button');
  await page.waitForSelector('.job-card .job-actions');
  await page.click('.job-row');
  await shot('job-review');
  // Accepting hands the merge to the agent: it asks where to when it cannot tell, the answer
  // goes in the conversation, and the job closes once the branch is seen to be merged.
  await page.click('.job-actions .btn.primary');
  await page.waitForSelector('.job-divider:has-text("你收下了")');
  await page.waitForSelector('.job-button:has-text("等你")');
  if (!(await page.isVisible('.job-card'))) await page.click('.job-button');
  await page.waitForSelector('.job-ask:has-text("还没有合并")');
  await shot('job-accept-ask');
  await page.fill('.composer textarea', '合并到 main');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.job-divider:has-text("已收下")');
  await shot('job-accepted');
  // The job is closed, the conversation is not: the next message is an ordinary one, and
  // 做完为止 can be switched on again for the next job.
  await page.waitForSelector('.composer .job-toggle:not([hidden])');
  await page.fill('.composer textarea', '顺便看一下 README 要不要更新');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.job-divider:has-text("已收下") ~ .turn, .job-divider:has-text("已收下") ~ *:has-text("README")');
  await page.waitForTimeout(1500);
  await shot('job-continued');
  // A criterion only the user can decide: the job waits, the question is in the card.
  await page.click('.conv-item:has-text("给启动流程补上集成测试")');
  await page.waitForSelector('.job-button:has-text("等你")');
  await page.click('.job-button');
  await page.waitForSelector('.job-card .criterion.ask');
  await shot('job-question');
  // 做完为止 can also be turned on in a conversation that is already going.
  await page.click('.conv-item:has-text("hello")');
  await page.waitForSelector('.job-toggle:not([disabled])');
  await page.click('.job-toggle');
  await shot('job-toggle-midway');
  await page.click('.job-toggle');
  await page.click('.conv-item:has-text("给启动流程补上集成测试")');
  // A wide window has room for the card beside the conversation: it stays open there.
  await page.setViewportSize({ width: 1780, height: 900 });
  await page.waitForSelector('.job-card:not([hidden])');
  await shot('job-wide');
  await page.setViewportSize({ width: 1280, height: 820 });
  // 定时: the page from the rail, the new sheet, and a conversation the clock opened.
  await page.click('.rail-btn[title="定时"]');
  await page.waitForSelector('.schedule-row .switch');
  await shot('schedules');
  await page.click('.schedule-row .icon-btn >> nth=0');
  await page.waitForSelector('.menu');
  await shot('schedules-menu');
  await page.click('.menu button:has-text("历次运行")');
  await page.waitForSelector('.run-row');
  await shot('schedules-history');
  await page.keyboard.press('Escape');
  await page.click('.page-head button:has-text("新建定时")');
  await page.click('.segmented button:has-text("每周")');
  await page.waitForSelector('.sheet-next:has-text("下次")');
  await shot('schedules-new');
  await page.keyboard.press('Escape');
  await page.click('.schedule-row .run-link >> nth=0');
  await page.waitForSelector('.job-divider:has-text("定时")');
  await shot('schedules-conversation');
  await page.click('.rail-btn[title="定时"]');
  await page.waitForSelector('.schedule-row .switch');
  await page.click('.sidebar-toggle');
  await shot('schedules-sidebar-hidden');
  await page.click('.sidebar-toggle');
  await openTab('项目', '项目');
  await page.waitForSelector('.row');
  await shot('projects');
  await page.click('.page-head button:has-text("新建项目")');
  await shot('projects-new');
  await page.keyboard.press('Escape');
  await openTab('账号', '账号');
  await page.waitForSelector('.row');
  await shot('accounts');
  await page.click('.page-head button:has-text("添加账号")');
  await shot('accounts-new');
  await page.keyboard.press('Escape');
  await openTab('通用', '设置');
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
  await openTab('项目', '项目');
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
