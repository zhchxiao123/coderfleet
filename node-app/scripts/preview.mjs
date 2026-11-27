// Development preview: runs a backend against a fake Docker with sample
// accounts, projects and conversations, and serves the renderer in a normal
// browser with an HTTP transport in place of Electron's preload.
//   node scripts/preview.mjs [port] [--lead]
// --lead: 领航 is started, with a scripted stand-in for the system model.
import { readFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { fakeAgy, fakeClaude, fakeCodex } from '../test/fakes.mjs';
import { environment, lastTurn, systemModel, until } from '../test/helpers.mjs';

const ui = fileURLToPath(new URL('../ui/', import.meta.url));

/** Starts the demo backend and UI server; resolves to { url, close }. */
export async function startPreview(port = 5173, { lead = false } = {}) {
const env = await environment({
  bins: { agy: fakeAgy, claude: fakeClaude, codex: fakeCodex },
  containers: {},
});
await env.post('workspace/init');
// A few project files for the 文件 panel.
{
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(env.project, 'src'), { recursive: true });
  mkdirSync(join(env.project, 'docs'), { recursive: true });
  writeFileSync(join(env.project, 'README.md'), '# coderfleet\n\n把多个 AI 编程账号放进各自的容器里，一起用它们的额度。\n\n- `src/server.ts`：后端入口\n- `docs/`：说明文档\n');
  writeFileSync(join(env.project, 'package.json'), JSON.stringify({ name: 'coderfleet', version: '0.1.0', scripts: { test: 'node --test' } }, null, 2) + '\n');
  writeFileSync(join(env.project, 'src', 'server.ts'), 'export async function serve(configPath: string) {\n  const config = readConfig(configPath);\n  return listen(config.port, config.host);\n}\n');
}
await env.post('accounts', { name: 'claude-work', type: 'claude' });
await env.post('accounts', { name: 'codex-team', type: 'codex' });
await env.post('accounts', { name: 'google-agy', type: 'antigravity' });
await env.post('accounts', { name: 'claude-api', type: 'claude', auth: 'env', env: { ANTHROPIC_API_KEY: 'sk-demo' } });
const started = [];
// coderfleet holds two accounts: its conversations are each with one of them.
for (const [name, accounts, start] of [['coderfleet', ['claude-work', 'codex-team'], true], ['reminis-app', ['codex-team'], true], ['agy-lab', ['google-agy'], false]]) {
  const result = await env.post('projects', { name, accounts, path: env.project, start });
  if (result.body.operation) started.push(result.body.operation.id);
}
for (const id of started) await until(() => env.get('operations/' + id), value => value.body.status !== 'running', 'start');
// The fake Docker is asked whether an added account's directory is in the container.
{
  const { readFileSync, writeFileSync } = await import('node:fs');
  const dirs = ['/workspace', '/home/byclaw/.claude', '/home/byclaw/.codex'];
  writeFileSync(join(env.root, 'mounts.json'), JSON.stringify(Object.fromEntries(Object.keys(JSON.parse(readFileSync(join(env.root, 'containers.json'), 'utf8'))).map(name => [name, dirs]))));
}
// Sample subscription usage, read through the fake container like the real probe.
const soon = hours => new Date(Date.now() + hours * 3600_000).toISOString();
process.env.FAKE_USAGE = '{"plan": "max"}\n' + JSON.stringify({ status: 200, body: JSON.stringify({
  five_hour: { utilization: 82, resets_at: soon(2.4) }, seven_day: { utilization: 37, resets_at: soon(90) } }) });
process.env.FAKE_USAGE_CODEX = JSON.stringify({ status: 200, body: JSON.stringify({ plan_type: 'pro', rate_limit: {
  primary_window: { used_percent: 12, reset_at: Math.round(Date.now() / 1000) + 9000 }, secondary_window: { used_percent: 64, reset_at: Math.round(Date.now() / 1000) + 300000 } } }) });
for (const name of ['claude-work', 'codex-team']) await env.post('accounts/' + name + '/usage');

// 领航 with a scripted system model: it looks before approving, hands a job's merge and any choice to the user.
let model;
if (lead) {
  model = await systemModel((prompt, results, body) => {
    const names = body.tools.map(tool => tool.name);
    const event = prompt.split('## 现在要你处理的事\n')[1] ?? '';
    return names.includes('approve') ? (results ? [['approve', { reason: '只是跑检查，没有删除也没有推送' }]] : [['run_command', { command: 'git status --short | head -5; ls' }]])
      : names.includes('accept_job') ? [['ask_user', { question: '做完了，复审也过了，要不要收下并合并？', lean: '改动不大，我看可以收下；合并是大事，这次先问你。' }]]
      : names.includes('start_work') ? '现在这样：\n\n- **请运行检查并修复**（coderfleet）：在做，刚才要跑检查，我批了\n- **给启动流程补上集成测试**：有一条标准拿不准，卡片在上面\n- **端口改成读环境变量**：做完了，等你点头合并\n\n别的都停着，不需要你。'
      : names.includes('ask_user') ? [['ask_user', { question: '它有一条标准拿不准，要你定', lean: /测试/.test(event) ? '我倾向先只测启动成功这一条。' : '' }]]
      : '我看一下。';
  }, { pace: 60 });
  appendFileSync(join(env.workspace, 'config.conf'), 'SYSTEM_LLM_API_KEY=sk-demo\nSYSTEM_LLM_MODEL=demo-model\nSYSTEM_LLM_BASE_URL=http://127.0.0.1:' + model.port + '\n');
  await env.put('lead/settings', { enabled: true });
}

const say = async (projectId, prompts, account) => {
  const conversation = (await env.post('conversations', { projectId, account })).body.id;
  for (const prompt of prompts) {
    const sent = await env.post('conversations/' + conversation + '/turns', { prompt });
    if (sent.status !== 200) throw new Error(prompt + ': ' + sent.body.error);
    await until(() => lastTurn(env, conversation), turn => turn.status !== 'starting' && turn.status !== 'running' || turn.permission
      || turn.tools.some(tool => tool.status === 'running'), 'turn ' + prompt);
  }
  return conversation;
};
await say('reminis-app', ['修一下登录页的样式']);
await say('coderfleet', ['hello'], 'codex-team');
await say('coderfleet', ['请帮我梳理一下服务启动流程', '请修改端口为读取环境变量']);
// A job (做完为止) waiting for review: the project becomes a git repository, the job's first
// turn runs in its own worktree, the other account checks it, and a few edits there stand in
// for the agent's work.
{
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const git = (...args) => execFileSync('git', ['-C', env.project, '-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', ...args]);
  git('init', '-q', '-b', 'main');
  git('add', 'README.md', 'package.json', 'src');
  git('commit', '-q', '-m', 'initial');
  // One whose agent has a question about a criterion: it waits for the user.
  const stuck = (await env.post('conversations', { projectId: 'coderfleet', account: 'claude-work' })).body.id;
  await env.post('conversations/' + stuck + '/turns', { prompt: '给启动流程补上集成测试', job: true });
  await until(() => env.get('conversations/' + stuck + '/job'), value => value.body.job?.state === 'waiting', 'stuck job');
  const conversation = (await env.post('conversations', { projectId: 'reminis-app' })).body.id;
  await env.post('conversations/' + conversation + '/turns', { prompt: '端口改成读环境变量 PORT，默认 8765', job: true });
  const job = (await until(() => env.get('conversations/' + conversation + '/job'), value => value.body.job?.state === 'review', 'job')).body.job;
  const work = join(env.project, '.coderfleet-work', job.id);
  writeFileSync(join(work, 'src', 'port.ts'), 'export function port(): number {\n  const value = Number(process.env.PORT);\n  return Number.isInteger(value) && value > 0 ? value : 8765;\n}\n');
  writeFileSync(join(work, 'src', 'server.ts'), "import { port } from './port.js';\n\nexport async function serve(configPath: string) {\n  const config = readConfig(configPath);\n  return listen(port(), config.host);\n}\n");
  writeFileSync(join(work, 'README.md'), '# coderfleet\n\n把多个 AI 编程账号放进各自的容器里，一起用它们的额度。\n\n- `src/server.ts`：后端入口\n- `docs/`：说明文档\n- 端口：环境变量 `PORT`，默认 8765\n');
}
// 定时: one that has run (its conversation carries the clock), a weekly job, and one turned off.
{
  const daily = (await env.post('schedules', { projectId: 'coderfleet', prompt: '看看昨天的提交有没有问题，有就列出来', rule: { kind: 'daily', time: '09:00' } })).body;
  const run = (await env.post('schedules/' + daily.id + '/run')).body;
  await until(() => lastTurn(env, run.conversationId), turn => turn.status === 'done', 'scheduled run');
  await env.post('schedules', { projectId: 'reminis-app', prompt: '升级依赖，测试都过了再交给我', rule: { kind: 'weekly', days: [1], time: '10:00' }, job: true });
  const off = (await env.post('schedules', { projectId: 'coderfleet', prompt: '跑一遍测试，失败了告诉我原因', rule: { kind: 'every', hours: 6 } })).body;
  await env.put('schedules/' + off.id, { enabled: false });
}
await say('coderfleet', ['请运行检查并修复'], 'claude-work');

if (lead) {
  // One approval for it to settle: it looks first, then lets it through.
  const conversation = (await env.post('conversations', { projectId: 'coderfleet', account: 'claude-work', name: '跑一遍检查' })).body.id;
  await env.post('conversations/' + conversation + '/turns', { prompt: 'tool' });
  await until(() => env.get('lead'), value => value.body.items.length >= 3 && value.body.working === null, 'lead demo');
  await env.post('lead/messages', { text: '现在都在忙什么' });
  await until(() => env.get('lead'), value => value.body.items.at(-1)?.type === 'lead' && value.body.working === null, 'lead answer');
}

const token = 'synthetic-node-test-token-0000000';
const backendPort = JSON.parse(await readFile(join(env.root, 'config.json'), 'utf8')).port;
const transport = `
window.coderFleet = {
  platform: 'darwin',
  list: async () => [
    { id: 'local', name: '本机', kind: 'local', url: 'http://127.0.0.1:${backendPort}' },
    { id: 'build', name: '构建服务器', kind: 'ssh', url: 'ssh://dev@10.0.8.21', host: 'dev@10.0.8.21', version: '0.0.9' },
  ],
  connect: async () => ({}), setLan: async () => ({}), restartLocal: async () => ({}),
  setupLocal: async () => 'local', addRemote: async () => 'local', remove: async () => [],
  pickDirectory: null, pickFile: null,
  bundle: async () => ({ version: '0.1.0', app: '0.1.0' }),
  addSsh: async () => { window.__jobStart = Date.now(); return 'job'; },
  reinstallSsh: async () => { window.__jobStart = Date.now(); return 'job'; },
  job: async () => {
    const lines = ['连接 dev@10.0.8.21…', '系统：Linux x86_64，Docker 27.3.1', '上传后端安装包…', '安装 CoderFleet 后端 0.1.0 到 /home/dev/.coderfleet-backend',
      'Docker 27.3.1', '配置：/home/dev/.coderfleet-backend/config.json', '服务已启动（systemd-user）', '后端 0.1.0 已运行（systemd-user），远端端口 8877', '建立 SSH 隧道…', '完成。'];
    const shown = Math.min(lines.length, Math.floor((Date.now() - window.__jobStart) / 350) + 1);
    return { status: shown === lines.length ? 'succeeded' : 'running', log: lines.slice(0, shown).join('\\n') + '\\n', result: { id: 'build' } };
  },
  request: async (_id, method, path, body) => {
    const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status);
    return data;
  },
};`;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname.startsWith('/v1/')) {
    try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const upstream = await fetch('http://127.0.0.1:' + backendPort + url.pathname + url.search, {
      method: request.method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    response.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch { if (!response.headersSent) response.writeHead(502); response.end(); }
    return;
  }
  if (url.pathname === '/dev-transport.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(transport); return; }
  const file = normalize(join(ui, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(ui)) { response.writeHead(404); response.end(); return; }
  try {
    let content = await readFile(file);
    // The App's renderer has no network access; the preview transport fetches from this server.
    if (file.endsWith('index.html')) content = Buffer.from(String(content).replace("default-src 'none';", "default-src 'none'; connect-src 'self';")
      .replace('<script src="vendor/xterm.js"', '<script src="/dev-transport.js"></script>\n  <script src="vendor/xterm.js"'));
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    response.end(content);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
return {
  url: 'http://127.0.0.1:' + port + '/', env,
  close: async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await env.close(); model?.close(); },
};
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  const preview = await startPreview(Number(process.argv.slice(2).find(value => /^\d+$/.test(value)) || 5173), { lead: process.argv.includes('--lead') });
  console.log('Preview on ' + preview.url);
  process.on('SIGINT', async () => { await preview.close(); process.exit(0); });
  await sleep(2 ** 31 - 1);
}
