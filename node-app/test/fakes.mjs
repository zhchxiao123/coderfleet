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
// Forking (--fork-session) continues the resumed history under --session-id.
const flag = name => argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1) ?? (argv.includes(name) ? argv[argv.indexOf(name) + 1] : '');
const forked = argv.includes('--fork-session') ? flag('--session-id') : '';
let sessionId = forked || resume || 'claude-session-1';
const waiting = new Map();
let sequence = 0;
const ask = (tool, input) => new Promise(resolve => {
  const id = 'req-' + (++sequence);
  waiting.set(id, resolve);
  send({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: 'tool-' + sequence } });
});
const say = text => {
  // Like the SDK: every assistant message starts with message_start.
  send({ type: 'stream_event', session_id: sessionId, event: { type: 'message_start', message: { role: 'assistant' } } });
  send({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  send({ type: 'assistant', session_id: sessionId, uuid: text === 'fork-source' ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : crypto.randomUUID(),
    message: { role: 'assistant', content: [{ type: 'text', text }] } });
};
const finish = (subtype = 'success', result = 'ok') => send({ type: 'result', subtype, is_error: subtype !== 'success', result, session_id: sessionId });
let interrupt;
// Newer CLIs fold messages sent mid-turn into the running turn and report each
// message's progress as command_lifecycle events; no run of their own follows.
let folding;
const lifecycle = (uuid, state) => send({ type: 'command_lifecycle', command_uuid: uuid, state, uuid: crypto.randomUUID(), session_id: sessionId });
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
  '',
  '整理好的说明在这里：',
  '<!-- CF_SEND: README.md -->',
].join('\\n');
createInterface({ input: process.stdin }).on('line', line => void handle(JSON.parse(line)));
async function handle(message) {
  if (message.type === 'control_request') {
    // The initialize answer lists the account's models, as \`/model\` shows them.
    const models = [
      { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks' },
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work' },
      { value: 'claude-fable-5-2', resolvedModel: 'claude-fable-5-2', displayName: 'Fable 5.2', description: 'For your toughest challenges' },
      { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5', description: 'Fastest for quick answers' },
    ];
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
      response: message.request.subtype === 'initialize' ? { models } : {} } });
    if (message.request.subtype === 'interrupt') interrupt?.();
    return;
  }
  if (message.type === 'control_response') { waiting.get(message.response.request_id)?.(message.response.response); return; }
  if (message.type !== 'user') return;
  const prompt = message.message.content;
  if (folding) { lifecycle(message.uuid, 'queued'); folding.push(message); return; }
  if (prompt === 'forkme' && !resume) sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  send({ type: 'system', subtype: 'init', session_id: sessionId, model });
  const mode = argv.find(value => value.startsWith('--permission-mode='))?.slice(18) ?? (argv.includes('--permission-mode') ? argv[argv.indexOf('--permission-mode') + 1] : '');
  if (Array.isArray(prompt)) {
    // Text plus base64 image blocks.
    const text = prompt.filter(block => block.type === 'text').map(block => block.text).join('');
    const images = prompt.filter(block => block.type === 'image' || block.type === 'document').map(block => block.source.media_type + ':' + block.source.data.length);
    say('images:' + images.join(',') + ':' + text);
    finish();
  } else if (prompt === 'subagent') {
    // An Agent call whose own steps carry its ID (parent_tool_use_id).
    send({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id: 'agent-1', name: 'Agent', input: { description: 'Review platform deployment-tag diff', subagent_type: 'general-purpose' } }] } });
    const steps = ['git status --short && git diff', 'cat src/test/MicrovmDeploymentTagTest.java', 'git grep -n AliyunMicrovmClient', 'sed -n 1,80p platform-web/src/main/Application.java', "git grep -n 'ownerKey' -- '*.java'", 'grep -n application-aliyun-microvm README.md', 'mvn -q -pl platform-provider-aliyun-agent-sandbox test'];
    for (const [index, command] of steps.entries()) {
      send({ type: 'stream_event', parent_tool_use_id: 'agent-1', session_id: sessionId, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sub-agent note ' } } });
      send({ type: 'assistant', parent_tool_use_id: 'agent-1', session_id: sessionId, message: { content: [{ type: 'tool_use', id: 's' + index, name: 'Bash', input: { command } }] } });
      send({ type: 'user', parent_tool_use_id: 'agent-1', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 's' + index, content: 'ok', is_error: index === 6 }] } });
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    send({ type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'agent-1', content: 'Review done: one failing test.' }] } });
    say('审查完成：有一个测试没通过，其他改动没有问题。');
    finish();
  } else if (prompt === 'readimg') {
    // Read of a picture: the tool result is an image block.
    send({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id: 'img-1', name: 'Read', input: { file_path: '/workspace/shot.png' } }] } });
    send({ type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'img-1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: process.env.FAKE_READ_IMAGE || 'iVBORw0KGgo=' } }] }] } });
    say('looked');
    finish();
  } else if (prompt === 'background' || prompt === 'background-short') {
    // A command left running in the background: the CLI does not exit while it runs, even with its input closed.
    const task = { task_id: 'bg-1', task_type: 'local_bash', description: 'Reinstall dependencies' };
    send({ type: 'system', subtype: 'background_tasks_changed', tasks: [task], session_id: sessionId });
    say('started');
    finish();
    if (prompt === 'background') setInterval(() => undefined, 1000);
    else setTimeout(() => {
      // It finished: the model is told and answers in a run of its own.
      send({ type: 'system', subtype: 'background_tasks_changed', tasks: [], session_id: sessionId });
      say('installed');
      finish();
    }, 1000);
  } else if (prompt === 'forkme') {
    say('fork-source');
    finish();
  } else if (prompt === 'mode') {
    say('mode:' + mode);
    finish();
  } else if (prompt === 'long') {
    say('working');
    await new Promise(resolve => setTimeout(resolve, 1500));
    say(' long-done');
    finish();
  } else if (prompt === 'tool') {
    const decision = await ask('Bash', { command: 'ls' });
    send({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } }] } });
    send({ type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'x', is_error: decision.behavior !== 'allow' }] } });
    say(decision.behavior === 'allow' ? 'ran' : 'denied:' + decision.message);
    finish();
  } else if (prompt === 'ask') {
    const decision = await ask('AskUserQuestion', { questions: [{ question: 'Pick one?', header: 'Choice', multiSelect: false, options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }] }] });
    say('answer:' + JSON.stringify(decision.updatedInput.answers));
    finish();
  } else if (prompt.startsWith('请核对')) {
    // A job's reviewer (做完为止): every criterion it was given holds.
    const items = prompt.split('\\n').filter(line => line.startsWith('- [')).map(line => line.slice(6).split(' —— ')[0]);
    send({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id: 'v1', name: 'Bash', input: { command: 'git diff --stat && npm test' } }] } });
    send({ type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'v1', content: '…' }] } });
    say(['逐条看了改动，也自己跑了一遍测试。', '', '\`\`\`标准', ...items.map(item => '- [x] ' + item + ' —— 看了改动并重跑，属实'), '\`\`\`', '', '没有发现必须改的问题。', '', '结论：通过'].join('\\n'));
    finish();
  } else if (prompt.includes('做完的标准')) {
    // A job's author that cannot decide one of its criteria.
    say(['测试写好了，有一条要你来定。', '', '\`\`\`标准', '- [x] 启动流程有一条集成测试，从读配置跑到监听端口 —— \`npm test\` 14 项全过',
      '- [x] 测试不占用固定端口 —— 用端口 0，由系统分配', '- [?] 配置文件缺失时的行为 —— 现在是直接报错退出；要不要改成用默认配置启动？', '\`\`\`'].join('\\n'));
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
      // A long command: rows must stay inside the chat column.
      tool('c4', 'Bash', { command: 'export GIT_DIR=/workspace/.git/worktrees/node-electron-worktree GIT_WORK_TREE=$PWD && git add node-app/ui node-app/test && git commit -q -m "feat: a very long commit message that keeps going and going"' }); done('c4', false);
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
  } else if (prompt === 'fold') {
    lifecycle(message.uuid, 'queued');
    lifecycle(message.uuid, 'started');
    folding = [];
    say('working');
    await new Promise(resolve => setTimeout(resolve, 1500));
    const folded = folding;
    folding = undefined;
    for (const item of folded) lifecycle(item.uuid, 'started');
    for (const item of folded) lifecycle(item.uuid, 'completed');
    say(' folded:' + folded.map(item => item.message.content).join(','));
    finish();
    lifecycle(message.uuid, 'completed');
  } else if (prompt === 'stubborn') {
    // Ignores interrupts and the end of its input.
    say('working');
    setInterval(() => undefined, 1000);
  } else if (prompt === 'slow') {
    say('working');
    await new Promise(resolve => { interrupt = resolve; });
    finish('error_during_execution', '');
  } else {
    say('echo:' + prompt + ':' + model + (resume ? ':resumed=' + resume : '') + (forked ? ':forked=' + forked + '@' + flag('--resume-session-at') : ''));
    finish();
  }
}
`;


export const fakeCodex = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'debug' && args[1] === 'models') {
  // Like the real catalog: hidden rows, out of order, and far larger than a default exec buffer.
  const row = (slug, display_name, visibility, priority) => ({ slug, display_name, description: display_name + ' model', visibility, priority, base_instructions: 'x'.repeat(600000) });
  // Written synchronously: exiting right after an asynchronous write would cut a catalog this large.
  require('node:fs').writeSync(1, JSON.stringify({ models: [row('gpt-review', 'Review', 'hide', 1), row('gpt-b', 'GPT B', 'list', 3), row('gpt-a', 'GPT A', 'list', 2)] }) + '\\n');
  process.exit(0);
}
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
  if (prompt.startsWith('我收下')) {
    // The user accepted a job: where the changes go is the agent's call, and here it asks first.
    send({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: '还没有合并。这个分支是从 main 分出来的，但 main 之后有了新的提交，另外还有一个 release 分支。合并到哪个？' } });
    send({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    return;
  }
  if (prompt.startsWith('合并到')) {
    const { execFileSync } = await import('node:child_process');
    const cwd = args[args.indexOf('--cd') + 1];
    const git = (directory, ...rest) => execFileSync('git', ['-C', directory, '-c', 'user.name=Fake', '-c', 'user.email=fake@example.com', ...rest], { encoding: 'utf8' }).trim();
    const branch = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
    git(cwd, 'add', '-A');
    if (git(cwd, 'status', '--porcelain')) git(cwd, 'commit', '-q', '-m', 'job');
    const root = cwd.split('/.coderfleet-work/')[0];
    send({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'git -C ' + root + ' merge ' + branch, aggregated_output: git(root, 'merge', '--no-edit', branch), exit_code: 0, status: 'completed' } });
    send({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: '合并进了 ' + git(root, 'rev-parse', '--abbrev-ref', 'HEAD') + '，没有冲突。' } });
    send({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    return;
  }
  if (prompt.includes('做完的标准') && !prompt.startsWith('请核对')) {
    // A job's author (做完为止): lists what done means, with its evidence.
    send({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'npm test', aggregated_output: 'pass 12', exit_code: 0, status: 'completed' } });
    send({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: ['改好了。', '', '\`\`\`标准',
      '- [x] 端口从环境变量 PORT 读取 —— 新增 \`src/port.ts\`，\`PORT=9000\` 启动后监听 9000',
      '- [x] 没设或不是正整数时用 8765 —— 补了 3 条测试，\`npm test\` 12 项全过',
      '- [x] README 写明怎么改端口 —— 加了一行说明', '\`\`\`'].join('\\n') } });
    send({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    return;
  }
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

// A Codex for both sides of a job, working in the directory it was started for.
// As the author it does what the last line of its prompt says and answers with a line of JSON
// about how it was started, then its criteria: `write <file> <text>` (met), `stall` (never
// met), `ask` (the user has to decide), `fail`, anything else (no criteria). Told that it
// listed none it lists one, met; handed a review it writes "good" to state.txt.
// Told that the user accepted, or to \`merge\`, it commits what it has and merges its branch:
// into \`side\` when the repository has such a branch, else into what the project has checked
// out; when that does not merge it leaves everything as it was and asks.
// As the reviewer it wants changes while state.txt exists and does not say "good".
export const jobCodex = `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
const cwd = args[args.indexOf('--cd') + 1];
const sandbox = args[args.indexOf('--sandbox') + 1];
const resumed = args.includes('resume') ? args[args.indexOf('resume') + 1] : '';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const git = (directory, ...rest) => execFileSync('git', ['-C', directory, ...rest], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const merge = () => {
  const root = dirname(dirname(cwd));
  const branch = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  git(cwd, 'add', '-A');
  if (git(cwd, 'status', '--porcelain')) git(cwd, 'commit', '-q', '-m', 'job');
  if (git(root, 'branch', '--list', 'side')) { git(root, 'fetch', '-q', '.', branch + ':side'); return '合并进了 side。'; }
  try { git(root, 'merge', '-q', '--no-edit', branch); return '合并进了 ' + git(root, 'rev-parse', '--abbrev-ref', 'HEAD') + '。'; }
  catch { git(root, 'merge', '--abort'); return '和那边现在的内容有冲突，没有合并。要合并到哪个分支？'; }
};
const block = (...lines) => ['\`\`\`标准', ...lines, '\`\`\`'].join('\\n');
let prompt = '';
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  prompt = prompt.trim();
  const reviewing = prompt.startsWith('请核对');
  send({ type: 'thread.started', thread_id: reviewing ? 'review-thread' : resumed || 'author-thread' });
  send({ type: 'turn.started' });
  const [verb, file, ...rest] = prompt.split('\\n').at(-1).split(' ');
  let text;
  if (reviewing) {
    const state = join(cwd, 'state.txt');
    const bad = existsSync(state) && !readFileSync(state, 'utf8').includes('good');
    text = sandbox + ' ' + (bad ? block('- [ ] 写好了 —— state.txt 第 1 行应该是 good') + '\\n结论：要改' : block('- [x] 写好了 —— 看过了') + '\\n结论：通过');
  } else {
    if (verb === 'fail') { send({ type: 'turn.failed', error: { message: 'quota exceeded' } }); process.exit(1); }
    if (verb === 'slow') { process.on('SIGINT', () => process.exit(130)); setInterval(() => undefined, 1000); return; }
    let criteria = '';
    if (prompt.startsWith('我收下') || verb === 'merge') criteria = merge();
    else if (prompt.includes('核对了你的改动')) { writeFileSync(join(cwd, 'state.txt'), 'good\\n'); criteria = block('- [x] 写好了 —— 改成 good 了'); }
    else if (prompt.includes('没有列出')) criteria = block('- [x] 写好了 —— 补上了');
    else if (prompt.includes('还没有做到') || verb === 'stall') criteria = block('- [x] 开了头 —— 有文件了', '- [ ] 没做到');
    else if (verb === 'ask') criteria = block('- [?] 用哪个端口 —— 8080 还是 8765？');
    else if (verb === 'write') { writeFileSync(join(cwd, file), rest.join(' ') + '\\n'); criteria = block('- [x] 写好了 —— ' + file + ' 里是 ' + rest.join(' ')); }
    text = JSON.stringify({ cwd, sandbox, resumed, preamble: prompt.includes('独立的工作目录'), continued: prompt.includes('从现在起'), ...(prompt.includes('已经删除') ? { moved: true } : {}) }) + '\\n' + criteria;
  }
  send({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text } });
  send({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
});
`;
