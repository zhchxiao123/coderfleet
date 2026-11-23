import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ControlMailbox } from '../dist/control.js';
import { serve } from '../dist/server.js';

// Fake Docker CLI: `docker exec` runs the command on this machine with the
// container's /workspace mapped to the project directory, so the real worker,
// control mailbox and host follower run end to end.
const fakeDocker = `#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const [command, ...args] = process.argv.slice(2);
const state = process.env.FAKE_STATE;
const running = () => !existsSync(state + '/stopped');
if (command === 'inspect') {
  const format = args[1];
  if (!running()) { console.log('false'); process.exit(0); }
  console.log(format.includes('Networks') ? 'true ' + process.env.FAKE_NETWORK + ' ' : 'true');
  process.exit(0);
}
if (command === 'network') { console.log(args.at(-1) === 'relay-net' ? 'true' : 'false'); process.exit(0); }
if (command !== 'exec' || !running()) { console.error('unexpected docker call ' + command); process.exit(1); }
let detached = false; const env = { ...process.env, PATH: process.env.FAKE_BIN + ':' + process.env.PATH };
let index = 0;
for (; index < args.length; index += 1) {
  const value = args[index];
  if (value === '-d') detached = true;
  else if (value === '-it') continue;
  else if (value === '--workdir') index += 1;
  else if (value === '--env') { const [k, ...v] = args[++index].split('='); env[k] = v.join('='); }
  else break;
}
const argv = args.slice(index + 1).map(value => value.replaceAll('/workspace', process.env.FAKE_PROJECT));
if (detached) {
  // The task specification holds container paths; map them like the argv.
  const spec = /--spec '([^']+)'/.exec(argv.join(' '))?.[1];
  if (spec) writeFileSync(spec, readFileSync(spec, 'utf8').replaceAll('/workspace', process.env.FAKE_PROJECT));
  spawn(argv[0], argv.slice(1), { env, cwd: process.env.FAKE_PROJECT, detached: true, stdio: 'ignore' }).unref();
  process.exit(0);
}
const result = spawnSync(argv[0], argv.slice(1), { env, cwd: process.env.FAKE_PROJECT, stdio: 'inherit' });
process.exit(result.status ?? 1);
`;

// Fake Antigravity CLI speaking ACP over stdio.
const fakeAgy = `#!/usr/bin/env node
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

async function port() {
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const { port: value } = server.address();
  await new Promise(done => server.close(done));
  return value;
}

async function until(operation, matches, label) {
  for (let index = 0; index < 200; index += 1) {
    const result = await operation();
    if (matches(result)) return result;
    await sleep(50);
  }
  throw new Error('Timed out waiting for ' + label);
}

test('Antigravity turns run in the persistent project container and survive a service restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coderfleet-node-test-'));
  const workspace = join(root, 'workspace');
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  const token = 'synthetic-node-test-token-0000000';
  let server;
  try {
    await mkdir(workspace); await mkdir(project); await mkdir(bin); await mkdir(join(root, 'state'));
    await writeFile(join(workspace, 'accounts.conf'), 'NAME=google-a TYPE=antigravity\nNAME=codex-a TYPE=codex\n');
    await writeFile(join(workspace, 'projects.conf'), `NAME=agy ACCOUNT=google-a PATH=${project}\nNAME=other ACCOUNT=codex-a PATH=${project}\n`);
    await writeFile(join(bin, 'docker'), fakeDocker); await chmod(join(bin, 'docker'), 0o755);
    await writeFile(join(bin, 'agy'), fakeAgy); await chmod(join(bin, 'agy'), 0o755);
    Object.assign(process.env, { FAKE_STATE: root, FAKE_BIN: bin, FAKE_PROJECT: project, FAKE_NETWORK: 'relay-net' });
    const servicePort = await port();
    const config = join(root, 'config.json');
    await writeFile(config, JSON.stringify({ token, port: servicePort, dockerPath: join(bin, 'docker'), workspace: 'workspace', stateDirectory: 'state' }));
    const base = 'http://127.0.0.1:' + servicePort + '/v1/';
    const call = async (path, options = {}) => {
      const response = await fetch(base + path, { ...options, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
      return { status: response.status, body: await response.json() };
    };
    const post = (path, value) => call(path, { method: 'POST', body: JSON.stringify(value) });
    const last = async conversation => (await call('conversations/' + conversation + '/turns')).body.at(-1);
    server = await serve(config);

    assert.deepEqual((await call('projects')).body, [{ id: 'agy', name: 'agy' }]);
    assert.deepEqual((await call('projects/agy/models')).body, [{ id: 'flash', label: 'Gemini Flash' }]);
    const conversation = (await post('conversations', { projectId: 'agy', name: 'Pilot' })).body.id;

    // First turn: new native session with the selected model.
    assert.equal((await post('conversations/' + conversation + '/turns', { prompt: 'hello', model: 'flash' })).status, 202);
    let turn = await until(() => last(conversation), value => value.status === 'done', 'first turn');
    assert.equal(turn.answer, 'echo:hello:flash');
    assert.equal(turn.sessionId, 'native-1');
    assert.equal(turn.controlToken, undefined);
    const files = await readdir(join(project, '.coderfleet-tasks'));
    assert.ok(files.some(name => /^acp-worker-[0-9a-f]{16}\.mjs$/.test(name)));
    assert.ok(files.includes(turn.id + '.sdk.json') && files.includes(turn.id + '.exit'));

    // Second turn resumes the saved native session.
    await post('conversations/' + conversation + '/turns', { prompt: 'again', model: '' });
    turn = await until(() => last(conversation), value => value.status === 'done', 'resumed turn');
    assert.equal(turn.answer, 'echo:again:base:resumed=native-1');

    // Approval survives a service restart while the worker keeps running in the container.
    await post('conversations/' + conversation + '/turns', { prompt: 'approve', model: '' });
    turn = await until(() => last(conversation), value => value.permission, 'permission');
    assert.equal(turn.permission.title, 'Write file');
    assert.equal(turn.tools[0].status, 'running');
    await new Promise(done => server.close(done));
    server = await serve(config);
    assert.equal((await post('turns/' + turn.id + '/permission', { id: 'wrong', decision: 'allow' })).status, 409);
    assert.equal((await post('turns/' + turn.id + '/permission', { id: turn.permission.id, decision: 'allow' })).status, 202);
    turn = await until(() => last(conversation), value => value.status === 'done', 'approved turn');
    assert.equal(turn.answer, 'written');
    assert.equal(turn.tools[0].status, 'completed');
    assert.equal(turn.permission, undefined);

    // Deny.
    await post('conversations/' + conversation + '/turns', { prompt: 'approve', model: '' });
    turn = await until(() => last(conversation), value => value.permission, 'second permission');
    await post('turns/' + turn.id + '/permission', { id: turn.permission.id, decision: 'deny' });
    turn = await until(() => last(conversation), value => value.status === 'done', 'denied turn');
    assert.equal(turn.answer, 'refused');
    assert.equal(turn.tools[0].status, 'failed');

    // Cancel a running turn, then continue the conversation.
    await post('conversations/' + conversation + '/turns', { prompt: 'slow', model: '' });
    turn = await until(() => last(conversation), value => value.answer === 'working', 'slow turn');
    assert.equal((await post('conversations/' + conversation + '/turns', { prompt: 'overlap', model: '' })).status, 409);
    assert.equal((await post('turns/' + turn.id + '/cancel', {})).status, 202);
    turn = await until(() => last(conversation), value => value.status === 'cancelled', 'cancelled turn');
    assert.equal(turn.interrupted, true);
    await post('conversations/' + conversation + '/turns', { prompt: 'after', model: '' });
    turn = await until(() => last(conversation), value => value.status === 'done', 'turn after cancel');
    assert.match(turn.answer, /^echo:after:base:resumed=native-1$/);

    // A stopped container is reported before anything is dispatched.
    await writeFile(join(root, 'stopped'), '');
    const refused = await post('conversations/' + conversation + '/turns', { prompt: 'late', model: '' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /not running/);
  } finally {
    if (server) await new Promise(done => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});

test('a relay account refuses a container attached to a non-internal network', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coderfleet-node-test-'));
  let server;
  try {
    const project = join(root, 'project'); const bin = join(root, 'bin');
    await mkdir(join(root, 'workspace')); await mkdir(project); await mkdir(bin);
    await writeFile(join(root, 'workspace', 'accounts.conf'), 'NAME=google-a TYPE=antigravity\n');
    await writeFile(join(root, 'workspace', 'projects.conf'), `NAME=agy ACCOUNT=google-a PATH=${project}\n`);
    await writeFile(join(bin, 'docker'), fakeDocker); await chmod(join(bin, 'docker'), 0o755);
    Object.assign(process.env, { FAKE_STATE: root, FAKE_BIN: bin, FAKE_PROJECT: project, FAKE_NETWORK: 'bridge' });
    const servicePort = await port();
    const token = 'synthetic-node-test-token-0000000';
    await writeFile(join(root, 'config.json'), JSON.stringify({ token, port: servicePort, dockerPath: join(bin, 'docker'), workspace: 'workspace', stateDirectory: 'state' }));
    server = await serve(join(root, 'config.json'));
    const headers = { Authorization: 'Bearer ' + token };
    const created = await (await fetch('http://127.0.0.1:' + servicePort + '/v1/conversations', { method: 'POST', headers, body: JSON.stringify({ projectId: 'agy' }) })).json();
    const response = await fetch('http://127.0.0.1:' + servicePort + '/v1/conversations/' + created.id + '/turns', { method: 'POST', headers, body: JSON.stringify({ prompt: 'hello' }) });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /non-internal network bridge/);
    assert.deepEqual(await readdir(project), []);
  } finally {
    if (server) await new Promise(done => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});

test('the control mailbox is interchangeable with the Python implementation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coderfleet-control-test-'));
  try {
    const token = 'a'.repeat(64);
    const directory = join(root, 'task.control');
    const node = new ControlMailbox(directory, 'task-1', token);
    node.publish('accepting');
    const script = resolve(fileURLToPath(new URL('../../coderfleet/data/scripts/coderfleet_sdk_control.py', import.meta.url)));
    const python = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('control', sys.argv[1]); module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
box = module.ControlMailbox(__import__('pathlib').Path(sys.argv[2]), 'task-1', sys.argv[3])
box.submit('from-python', 'approval', {'tool_call_id': 'x', 'decision': 'allow'})
print(json.dumps(box.reply('from-node')))
`;
    node.acknowledge('from-node', { ok: true });
    const output = execFileSync('python3', ['-I', '-c', python, script, directory, token], { encoding: 'utf8' });
    assert.equal(JSON.parse(output).status, 'accepted');
    const [command] = node.pending();
    assert.equal(command.id, 'from-python');
    assert.deepEqual(command.payload, { tool_call_id: 'x', decision: 'allow' });
    assert.equal(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).generation, node.generation);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
