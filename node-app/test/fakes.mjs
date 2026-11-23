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
  const resume = args[1] === 'resume' ? args[2] : '';
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

