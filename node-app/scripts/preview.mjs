// Development preview: runs a backend against a fake Docker with sample
// accounts, projects and conversations, and serves the renderer in a normal
// browser with an HTTP transport in place of Electron's preload.
//   node scripts/preview.mjs [port]
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { fakeAgy, fakeClaude, fakeCodex } from '../test/fakes.mjs';
import { environment, lastTurn, until } from '../test/helpers.mjs';

const ui = fileURLToPath(new URL('../ui/', import.meta.url));

/** Starts the demo backend and UI server; resolves to { url, close }. */
export async function startPreview(port = 5173) {
const env = await environment({
  bins: { agy: fakeAgy, claude: fakeClaude, codex: fakeCodex },
  containers: {},
});
await env.post('workspace/init');
await env.post('accounts', { name: 'claude-work', type: 'claude' });
await env.post('accounts', { name: 'codex-team', type: 'codex' });
await env.post('accounts', { name: 'google-agy', type: 'antigravity' });
await env.post('accounts', { name: 'claude-api', type: 'claude', auth: 'env', env: { ANTHROPIC_API_KEY: 'sk-demo' } });
const started = [];
for (const [name, account, start] of [['coderfleet', 'claude-work', true], ['reminis-app', 'codex-team', true], ['agy-lab', 'google-agy', false]]) {
  const result = await env.post('projects', { name, account, path: env.project, start });
  if (result.body.operation) started.push(result.body.operation.id);
}
for (const id of started) await until(() => env.get('operations/' + id), value => value.body.status !== 'running', 'start');

const say = async (projectId, prompts) => {
  const conversation = (await env.post('conversations', { projectId })).body.id;
  for (const prompt of prompts) {
    await env.post('conversations/' + conversation + '/turns', { prompt });
    await until(() => lastTurn(env, conversation), turn => turn.status !== 'starting' && turn.status !== 'running' || turn.permission
      || turn.tools.some(tool => tool.status === 'running'), 'turn ' + prompt);
  }
  return conversation;
};
await say('reminis-app', ['修一下登录页的样式']);
await say('coderfleet', ['hello']);
await say('coderfleet', ['请帮我梳理一下服务启动流程', '请修改端口为读取环境变量']);
await say('coderfleet', ['请运行检查并修复']);

const token = 'synthetic-node-test-token-0000000';
const backendPort = JSON.parse(await readFile(join(env.root, 'config.json'), 'utf8')).port;
const transport = `
window.coderFleet = {
  platform: 'darwin',
  list: async () => [{ id: 'local', name: '本机', kind: 'local', url: 'http://127.0.0.1:${backendPort}' }],
  connect: async () => ({}),
  setupLocal: async () => 'local', addRemote: async () => 'local', remove: async () => [],
  pickDirectory: null,
  request: async (_id, method, path, body) => {
    const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status);
    return data;
  },
};`;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
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
  close: async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await env.close(); },
};
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  const preview = await startPreview(Number(process.argv[2] || 5173));
  console.log('Preview on ' + preview.url);
  process.on('SIGINT', async () => { await preview.close(); process.exit(0); });
  await sleep(2 ** 31 - 1);
}
