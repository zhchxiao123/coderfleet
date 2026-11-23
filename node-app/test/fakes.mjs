// Fake CLIs used by the tests and the UI preview.

export const fakeAgy = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const [command] = process.argv.slice(2);
if (command === '--version') { console.log('1.5.15'); process.exit(0); }
if (command === 'models') { console.log('flash\\tGemini Flash'); process.exit(0); }
if (command !== 'acp') process.exit(2);
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
let sessionId = ''; let model = 'base'; let promptId; let resumed = '';
const chunk = text => send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
const options = { configOptions: [{ type: 'select', category: 'mode', id: 'mode', currentValue: 'auto' }, { type: 'select', category: 'model', id: 'model', currentValue: 'base' }] };
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result } = JSON.parse(line);
  if (method === 'initialize') send({ id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } } });
  else if (method === 'session/new') { sessionId = 'native-1'; send({ id, result: { sessionId, ...options } }); }
  else if (method === 'session/resume') { sessionId = resumed = params.sessionId; send({ id, result: options }); }
  else if (method === 'session/set_config_option') { if (params.configId === 'model') model = params.value; send({ id, result: {} }); }
  else if (method === 'session/prompt') {
    promptId = id;
    const text = params.prompt[0].text;
    if (text === 'approve') {
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write file', status: 'pending' } } });
      send({ id: 'ask', method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 't1', title: 'Write file', rawInput: { path: 'a.txt' } }, options: [{ kind: 'allow_once', optionId: 'yes' }, { kind: 'reject_once', optionId: 'no' }] } });
    } else if (text === 'slow') chunk('working');
    else { chunk('echo:' + text + ':' + model + (resumed ? ':resumed=' + resumed : '')); send({ id, result: { stopReason: 'end_turn' } }); }
  } else if (id === 'ask') {
    const allowed = result.outcome.optionId === 'yes';
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: allowed ? 'completed' : 'failed' } } });
    chunk(allowed ? 'written' : 'refused');
    send({ id: promptId, result: { stopReason: 'end_turn' } });
  } else if (method === 'session/cancel') send({ id: promptId, result: { stopReason: 'cancelled' } });
  else if (method === 'session/close') send({ id, result: {} });
}
`;


export const fakeClaude = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('2.1.330 (Claude Code)'); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const resume = argv.find(value => value.startsWith('--resume='))?.slice(9) ?? (argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : '');
const model = argv.find(value => value.startsWith('--model='))?.slice(8) ?? '';
const sessionId = resume || 'claude-session-1';
const waiting = new Map();
let sequence = 0;
const ask = (tool, input) => new Promise(resolve => {
  const id = 'req-' + (++sequence);
  waiting.set(id, resolve);
  send({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: 'tool-' + sequence } });
});
const say = text => {
  send({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  send({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text }] } });
};
const finish = (subtype = 'success', result = 'ok') => send({ type: 'result', subtype, is_error: subtype !== 'success', result, session_id: sessionId });
let interrupt;
const DEMO = [
  '## 服务启动流程',
  '',
  '入口在 \`src/server.ts\`，启动时依次做三件事：',
  '',
  '1. 读取 \`config.json\`，校验端口和令牌；',
  '2. 载入会话和任务记录到内存；',
  '3. 监听 **127.0.0.1**，所有请求都要带令牌。',
  '',
  '\`\`\`ts',
  'const server = await serve(configPath);',
  "console.log('listening on', server.address());",
  '\`\`\`',
  '',
  '| 步骤 | 位置 |',
  '| --- | --- |',
  '| 读取配置 | \`readConfig\` |',
  '| 启动服务 | \`serve\` |',
  '',
  '> 端口目前写死在配置里，要改成读环境变量吗？',
].join('\\n');
createInterface({ input: process.stdin }).on('line', line => void handle(JSON.parse(line)));
async function handle(message) {
  if (message.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    if (message.request.subtype === 'interrupt') interrupt?.();
    return;
  }
  if (message.type === 'control_response') { waiting.get(message.response.request_id)?.(message.response.response); return; }
  if (message.type !== 'user') return;
  send({ type: 'system', subtype: 'init', session_id: sessionId, model });
  const prompt = message.message.content;
  if (prompt === 'tool') {
    const decision = await ask('Bash', { command: 'ls' });
    send({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } }] } });
    send({ type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'x', is_error: decision.behavior !== 'allow' }] } });
    say(decision.behavior === 'allow' ? 'ran' : 'denied:' + decision.message);
    finish();
  } else if (prompt === 'ask') {
    const decision = await ask('AskUserQuestion', { questions: [{ question: 'Pick one?', header: 'Choice', multiSelect: false, options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }] }] });
    say('answer:' + JSON.stringify(decision.updatedInput.answers));
    finish();
  } else if (prompt.startsWith('请')) {
    send({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'src/server.ts' } }] } });
    send({ type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: '…' }] } });
    send({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id: 'r2', name: 'Grep', input: { pattern: 'listen' } }] } });
    send({ type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'r2', content: '…' }] } });
    if (prompt.includes('检查')) {
      const tool = (id, name, input) => send({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id, name, input }] } });
      const done = (id, error) => send({ type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: id, content: '…', is_error: error }] } });
      tool('c1', 'Bash', { command: 'npm test' }); done('c1', true);
      tool('c2', 'Read', { file_path: '/workspace/test/server.test.ts' }); done('c2', false);
      say('有一个测试失败，我先修复再重新构建。');
      tool('c3', 'Bash', { command: 'npm run build' });
      await new Promise(resolve => { interrupt = resolve; });
      finish('error_during_execution', '');
      return;
    }
    if (prompt.includes('修改')) {
      send({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id: 'tool-' + (sequence + 1), name: 'Edit', input: { file_path: '/workspace/src/server.ts' } }] } });
      const decision = await ask('Edit', { file_path: '/workspace/src/server.ts', old_string: 'server.listen(8080)', new_string: 'server.listen(Number(process.env.PORT ?? 8080))' });
      say(decision.behavior === 'allow' ? '已修改端口配置。' : '好的，没有修改。');
      finish();
      return;
    }
    say(DEMO);
    finish();
  } else if (prompt === 'slow') {
    say('working');
    await new Promise(resolve => { interrupt = resolve; });
    finish('error_during_execution', '');
  } else {
    say('echo:' + prompt + ':' + model + (resume ? ':resumed=' + resume : ''));
    finish();
  }
}
`;


export const fakeCodex = `#!/usr/bin/env node
const args = process.argv.slice(2);
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let prompt = '';
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', async () => {
  prompt = prompt.trim();
  const resume = args.includes('resume') ? args[args.indexOf('resume') + 1] : '';
  send({ type: 'thread.started', thread_id: resume || 'thread-1' });
  send({ type: 'turn.started' });
  if (prompt === 'slow') {
    send({ type: 'item.completed', item: { id: 'm0', type: 'agent_message', text: 'working' } });
    process.on('SIGINT', () => process.exit(130));
    setInterval(() => undefined, 1000);
    return;
  }
  if (prompt === 'fail') { send({ type: 'turn.failed', error: { message: 'quota exceeded' } }); process.exit(1); }
  send({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls', status: 'in_progress' } });
  send({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls', aggregated_output: 'a.txt', exit_code: 0, status: 'completed' } });
  send({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'echo:' + prompt + ':' + args.join(' ') } });
  send({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
});
`;


// Generic ACP agent for Kimi (`kimi acp`) and Grok (`grok --no-auto-update agent stdio`).
// It exposes a model selector through `models` (session/set_model) and no modes.
export const fakeAcpAgent = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
const name = process.argv[1].split('/').pop();
let sessionId = ''; let model = 'base'; let promptId; let resumed = '';
const chunk = text => send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result } = JSON.parse(line);
  if (method === 'initialize') send({ id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } } });
  else if (method === 'session/new') { sessionId = name + '-session'; send({ id, result: { sessionId, models: { currentModelId: 'base', availableModels: [] } } }); }
  else if (method === 'session/resume') { sessionId = resumed = params.sessionId; send({ id, result: { models: { currentModelId: 'base' } } }); }
  else if (method === 'session/set_model') { model = params.modelId; send({ id, result: {} }); }
  else if (method === 'session/prompt') {
    promptId = id;
    if (params.prompt[0].text === 'approve') {
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'k1', title: 'Shell', rawInput: { command: 'make' }, status: 'pending' } } });
      send({ id: 'ask', method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'k1', title: 'Shell', rawInput: { command: 'make' } }, options: [{ kind: 'allow_once', optionId: 'y' }, { kind: 'reject_once', optionId: 'n' }] } });
    } else { chunk(name + ':' + params.prompt[0].text + ':' + model + (resumed ? ':resumed=' + resumed : '')); send({ id, result: { stopReason: 'end_turn' } }); }
  } else if (id === 'ask') {
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'k1', status: result.outcome.optionId === 'y' ? 'completed' : 'failed' } } });
    chunk(result.outcome.optionId === 'y' ? 'built' : 'skipped');
    send({ id: promptId, result: { stopReason: 'end_turn' } });
  }
}
`;

// Fake Hermes CLI: stream-json when \`chat --help\` lists --format, plain text otherwise (FAKE_HERMES_PLAIN=1).
export const fakeHermes = `#!/usr/bin/env node
const args = process.argv.slice(2);
const plain = process.env.FAKE_HERMES_PLAIN === '1';
if (args.includes('--help')) { console.log(plain ? 'usage: hermes chat -q QUERY' : 'usage: hermes chat -q QUERY [--format stream-json]'); process.exit(0); }
const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : '';
const query = args[args.indexOf('-q') + 1];
const session = resume || 'hermes-session';
if (plain) { console.log('echo:' + query + (resume ? ':resumed=' + resume : '')); console.error('Session: ' + session); process.exit(0); }
const send = value => console.log(JSON.stringify({ timestamp: Date.now(), ...value }));
send({ type: 'system', subtype: 'init', model: 'm', session_id: session });
if (query === 'tools') {
  send({ type: 'tool_use', name: 'terminal', input: { command: 'ls' } });
  send({ type: 'tool_result', name: 'terminal', output: 'a', is_error: false });
  send({ type: 'tool_use', name: 'terminal', input: { command: 'false' } });
  send({ type: 'tool_result', name: 'terminal', output: '', is_error: true });
}
if (query === 'fail') { send({ type: 'result', session_id: session, exit_code: 1, error: 'provider quota exceeded' }); process.exit(1); }
send({ type: 'text', text: 'echo:' + query });
send({ type: 'text', text: resume ? ':resumed=' + resume : '' });
send({ type: 'result', session_id: session, exit_code: 0, text: 'echo:' + query });
`;

// Fake Pi SDK module (loaded through CODERFLEET_PI_SDK).
export const fakePiSdk = `
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const store = process.env.FAKE_PI_STORE;
export const SessionManager = {
  create: cwd => ({ id: 'pi-' + Date.now().toString(36), cwd }),
  open: path => ({ id: path.split('/').pop(), resumed: true }),
  list: async () => existsSync(store) ? readdirSync(store).map(id => ({ id, path: join(store, id) })) : [],
};
export async function createAgentSession({ sessionManager }) {
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, sessionManager.id), '');
  const listeners = new Set();
  let aborted; const messages = [];
  const fire = event => { for (const listener of listeners) listener(event); };
  return { session: {
    sessionId: sessionManager.id, messages,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async prompt(text) {
      if (text === 'slow') {
        fire({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'working' } });
        await new Promise(resolve => { aborted = resolve; });
        messages.push({ role: 'assistant', stopReason: 'aborted' });
        return;
      }
      fire({ type: 'tool_execution_start', toolCallId: 'p1', toolName: 'bash', args: { command: 'ls' } });
      fire({ type: 'tool_execution_end', toolCallId: 'p1', toolName: 'bash', result: { content: [{ type: 'text', text: 'a' }] }, isError: false });
      fire({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'echo:' + text } });
      fire({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: sessionManager.resumed ? ':resumed=' + sessionManager.id : '' } });
      messages.push(text === 'fail' ? { role: 'assistant', stopReason: 'error', errorMessage: 'no API key' } : { role: 'assistant', stopReason: 'stop' });
    },
    async abort() { aborted?.(); },
    dispose() {},
  } };
}
`;

// Fake \`opencode serve\`: the HTTP routes and event stream the OpenCode SDK client uses.
export const fakeOpencode = `#!/usr/bin/env node
import { createServer } from 'node:http';
const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.slice(7));
const sessions = new Set(['existing']);
const clients = new Set();
const waiting = new Map();
const publish = event => { for (const client of clients) client.write('data: ' + JSON.stringify(event) + '\\n\\n'); };
const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
const body = async request => { const chunks = []; for await (const chunk of request) chunks.push(chunk); return chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}; };
createServer(async (request, response) => {
  const path = new URL(request.url, 'http://x').pathname;
  if (path === '/event') { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('data: {"type":"server.connected","properties":{}}\\n\\n'); clients.add(response); return; }
  if (request.method === 'POST' && path === '/session') { const id = 'ses_' + sessions.size; sessions.add(id); return json(response, 200, { id }); }
  let match = /^\\/session\\/([^/]+)$/.exec(path);
  // Sessions persist across server processes, as OpenCode stores them on disk.
  if (match && request.method === 'GET') return match[1].startsWith('ses_') ? json(response, 200, { id: match[1] }) : json(response, 404, { name: 'NotFoundError' });
  match = /^\\/session\\/([^/]+)\\/permissions\\/([^/]+)$/.exec(path);
  if (match) { const reply = (await body(request)).response; waiting.get(match[2])?.(reply); publish({ type: 'permission.replied', properties: { sessionID: match[1], requestID: match[2], reply } }); return json(response, 200, true); }
  match = /^\\/session\\/([^/]+)\\/abort$/.exec(path);
  if (match) { waiting.get('abort')?.(); return json(response, 200, true); }
  match = /^\\/session\\/([^/]+)\\/message$/.exec(path);
  if (!match) return json(response, 404, {});
  const sessionID = match[1];
  const input = await body(request);
  const text = input.parts[0].text;
  const model = input.model ? input.model.providerID + '/' + input.model.modelID : 'default';
  publish({ type: 'message.part.updated', properties: { part: { id: 'u1', sessionID, messageID: 'mu', type: 'text', text } } });
  publish({ type: 'message.updated', properties: { info: { id: 'ma', sessionID, role: 'assistant' } } });
  if (text === 'approve') {
    publish({ type: 'message.part.updated', properties: { part: { id: 't1', sessionID, messageID: 'ma', type: 'tool', callID: 'call1', tool: 'bash', state: { status: 'pending', input: {} } } } });
    publish({ type: 'message.part.updated', properties: { part: { id: 't1', sessionID, messageID: 'ma', type: 'tool', callID: 'call1', tool: 'bash', state: { status: 'running', input: { command: 'make' } } } } });
    publish({ type: 'permission.asked', properties: { id: 'per1', sessionID, permission: 'bash', patterns: ['make'], metadata: {}, tool: { messageID: 'ma', callID: 'call1' } } });
    const reply = await new Promise(resolve => waiting.set('per1', resolve));
    const ok = reply === 'once';
    publish({ type: 'message.part.updated', properties: { part: { id: 't1', sessionID, messageID: 'ma', type: 'tool', callID: 'call1', tool: 'bash', state: ok ? { status: 'completed', input: { command: 'make' }, output: 'ok' } : { status: 'error', input: { command: 'make' }, error: 'rejected' } } } });
  }
  if (text === 'slow') {
    publish({ type: 'message.part.updated', properties: { part: { id: 'x1', sessionID, messageID: 'ma', type: 'text', text: '' } } });
    publish({ type: 'message.part.delta', properties: { sessionID, messageID: 'ma', partID: 'x1', field: 'text', delta: 'working' } });
    await new Promise(resolve => waiting.set('abort', resolve));
    return json(response, 200, { info: { id: 'ma', role: 'assistant', error: { name: 'MessageAbortedError', data: { message: 'aborted' } } }, parts: [] });
  }
  const answer = 'opencode:' + text + ':' + model + ':' + sessionID;
  publish({ type: 'message.part.updated', properties: { part: { id: 'x2', sessionID, messageID: 'ma', type: 'text', text: '' } } });
  publish({ type: 'message.part.delta', properties: { sessionID, messageID: 'ma', partID: 'x2', field: 'text', delta: answer.slice(0, 9) } });
  await new Promise(resolve => setTimeout(resolve, 50));
  // The final part carries the rest; the worker must add only what the deltas missed.
  json(response, 200, { info: { id: 'ma', role: 'assistant' }, parts: [{ id: 'x2', type: 'text', text: answer }] });
}).listen(port, '127.0.0.1', () => console.log('opencode server listening on http://127.0.0.1:' + port));
`;
