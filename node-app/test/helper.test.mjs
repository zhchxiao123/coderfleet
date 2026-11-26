import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { generateCompose } from '../dist/compose.js';
import { environment, lastTurn, port, until } from './helpers.mjs';
import { fakeClaude } from './fakes.mjs';

// The service runs in this process: the command line must not block it.
const cli = async (...args) => (await promisify(execFile)(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8' })).stdout;

// Claude Code with one more prompt: "machine <program> <args…>" calls the helper's
// run_command the way the CLI would, with the MCP server it was started with, and
// answers with what came back. It leaves that configuration in mcp.json.
const NEWLINE = 'String.fromCharCode(10)';
const machineClaude = fakeClaude.replace("  } else if (prompt === 'forkme') {", `  } else if (typeof prompt === 'string' && prompt.startsWith('machine ')) {
    const machine = (JSON.parse(flag('--mcp-config') || '{}').mcpServers ?? {}).machine;
    const leaked = ['CODERFLEET_HELPER_URL', 'CODERFLEET_HELPER_TOKEN'].filter(name => name in process.env).length;
    if (!machine) { say('no-machine:' + leaked); finish(); return; }
    const { writeFileSync } = await import('node:fs');
    writeFileSync('mcp.json', JSON.stringify(machine));
    const args = { argv: prompt.slice(8).split(' ') };
    const allowed = await ask('mcp__machine__run_command', args);
    const response = await fetch(machine.url, {
      method: 'POST', headers: { ...machine.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_command', arguments: args } }),
    });
    const raw = await response.text();
    const line = raw.split(${NEWLINE}).find(value => value.startsWith('data: '));
    const result = JSON.parse(line ? line.slice(6) : raw).result;
    say([allowed.behavior, leaked, response.status, result.content[0].text].join('|'));
    finish();
  } else if (prompt === 'forkme') {`);
assert.notEqual(machineClaude, fakeClaude);

test('the relay forwards one more port to the machine helper', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'coderfleet-helper-compose-')));
  try {
    const workspace = join(root, 'ws'); const project = join(root, 'p');
    mkdirSync(workspace); mkdirSync(project);
    writeFileSync(join(workspace, 'config.conf'), 'HELPER_PORT=9911\n');
    writeFileSync(join(workspace, 'accounts.conf'), 'NAME=claude-a TYPE=claude PROXY=relay\n');
    writeFileSync(join(workspace, 'projects.conf'), `NAME=app ACCOUNT=claude-a PATH=${project}\n`);
    const { gost } = await generateCompose(workspace, 'docker');
    const bridge = gost.services.find(service => service.name === 'helper-bridge');
    assert.equal(bridge.addr, ':8767');
    assert.equal(bridge.handler.type, 'tcp');
    assert.deepEqual(bridge.forwarder.nodes.map(node => node.addr), ['host.docker.internal:9911']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a project with machine access runs commands through the helper', { timeout: 180_000 }, async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'coderfleet-helper-test-')));
  const home = join(base, 'home'); const programs = join(base, 'bin');
  mkdirSync(home, { mode: 0o700 }); mkdirSync(programs);
  for (const [name, script] of Object.entries({
    say: 'echo "$@"', here: 'pwd', careful: 'echo careful "$@"', linger: '/bin/sleep 300 & echo $! > "$1"; wait',
  })) { writeFileSync(join(programs, name), '#!/bin/sh\n' + script + '\n'); chmodSync(join(programs, name), 0o755); }
  // Where programs are looked for is the one thing only the file's owner sets.
  writeFileSync(join(home, 'policy.json'), JSON.stringify({ path: [programs], rules: [], unlisted: 'deny', gui_tools: [] }));
  process.env.CODERFLEET_HELPER_HOME = home;
  const env = await environment({
    accounts: 'NAME=claude-a TYPE=claude\nNAME=claude-direct TYPE=claude PROXY=off\n',
    projects: project => `NAME=app ACCOUNT=claude-a PATH=${project}\nNAME=direct ACCOUNT=claude-direct PATH=${project}\n`,
    containers: { 'claude-app': 'running', 'claude-direct': 'running' },
    bins: { claude: machineClaude, nc: '#!/bin/sh\nexit 0\n' },
  });
  const helperPort = await port();
  // The tests have no relay: the "relay's" address is this machine and the forward is the helper's own port.
  writeFileSync(join(env.workspace, 'config.conf'), `RELAY_IP=127.0.0.1\nHELPER_PORT=${helperPort}\nHELPER_BRIDGE_RELAY_PORT=${helperPort}\n`);
  const ask = async (conversation, prompt) => {
    const sent = await env.post('conversations/' + conversation + '/turns', { prompt });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
  };
  const done = (conversation, label) => until(() => lastTurn(env, conversation), value => !['starting', 'running'].includes(value.status) && !value.permission, label);
  const alive = pid => { try { return readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ').pop()[0] !== 'Z'; } catch { return false; } };
  try {
    // Not installed; nothing answers.
    let status = (await env.get('helper')).body;
    assert.deepEqual([status.installed, status.running, status.home], ['', false, home]);
    assert.match(status.bundled, /^\d+\.\d+\.\d+$/);
    assert.equal((await env.post('helper/start')).status, 400, 'starting what is not installed');

    // Only the main token manages the helper.
    await env.put('mobile', { addresses: [{ url: 'https://cf.example.com' }] });
    const phone = new URL((await env.post('devices', { name: 'iPhone', backendName: '本机' })).body.link).searchParams.get('token');
    for (const [method, path] of [['GET', 'helper'], ['POST', 'helper/install'], ['POST', 'helper/stop'], ['GET', 'helper/policy'], ['POST', 'helper/policy'], ['GET', 'helper/audit'], ['PUT', 'projects/app/helper']])
      assert.equal((await env.as(phone, method, path, {})).status, 403, method + ' ' + path);

    // Install: the shipped program is copied into the helper's directory and started.
    status = (await env.post('helper/install')).body;
    assert.deepEqual([status.installed, status.running, status.version, status.compatible, status.upgrade, status.port],
      [status.bundled, true, status.bundled, true, false, helperPort]);
    assert.equal(status.url, 'http://127.0.0.1:' + helperPort + '/mcp');
    assert.equal(status.relay, 'stopped', 'no relay container');
    assert.ok(existsSync(join(home, 'bin', 'main.js')));
    assert.match(await cli('helper', 'status', '--config', join(env.root, 'config.json')), /机器助手 {2}在运行/);

    // Rules.
    assert.equal((await env.post('helper/policy', { set: { program: 'say', action: 'allow' } })).status, 200);
    assert.equal((await env.post('helper/policy', { set: { program: 'careful', action: 'confirm' } })).status, 200);
    assert.equal((await env.post('helper/policy', { set: { program: 'here', action: 'allow' } })).status, 200);
    assert.equal((await env.post('helper/policy', { set: { program: 'linger', action: 'allow' } })).status, 200);
    assert.deepEqual((await env.get('helper/policy')).body.policy.rules.map(rule => rule.program + ':' + rule.action), ['say:allow', 'careful:confirm', 'here:allow', 'linger:allow']);
    // The rest of the rules file is set the same way: what unlisted commands get, and where programs are looked up.
    assert.equal((await env.post('helper/policy', { unlisted: 'confirm' })).body.policy.unlisted, 'confirm');
    assert.equal((await env.post('helper/policy', { unlisted: 'deny' })).body.policy.unlisted, 'deny');
    assert.equal((await env.post('helper/policy', { path: ['relative'] })).status, 400);
    assert.deepEqual((await env.post('helper/policy', { path: [programs] })).body.policy.path, [programs]);

    // Off by default: the task gets no connection.
    const conversation = (await env.post('conversations', { projectId: 'app' })).body.id;
    assert.equal((await env.get('projects')).body.find(item => item.id === 'app').helper, 'off');
    await ask(conversation, 'machine say hi');
    assert.equal((await done(conversation, 'turn without access')).answer, 'no-machine:0');

    // The project's switch, from the UI's route and from the command line.
    assert.equal((await env.put('projects/app/helper', { access: 'gui' })).status, 400, 'not built yet');
    assert.equal((await env.put('projects/app/helper', { access: 'everything' })).status, 400);
    assert.deepEqual((await env.put('projects/app/helper', { access: 'command' })).body, { helper: 'command' });
    assert.match(readFileSync(join(env.workspace, 'projects.conf'), 'utf8'), /NAME=app .*HELPER_ACCESS=command/);
    assert.equal((await env.get('projects')).body.find(item => item.id === 'app').helper, 'command');
    assert.match(await cli('helper', 'access', 'direct', 'command', '--config', join(env.root, 'config.json')), /direct {2}command/);

    // An allowed command: runs in the project directory, without an approval card; the
    // connection is not left in the agent's environment.
    await ask(conversation, 'machine say hello there');
    let turn = await done(conversation, 'allowed command');
    assert.equal(turn.status, 'done', turn.error);
    let [behavior, leaked, http, result] = turn.answer.split('|');
    assert.deepEqual([behavior, leaked, http], ['allow', '0', '200']);
    assert.deepEqual([JSON.parse(result).ran, JSON.parse(result).exit_code, JSON.parse(result).stdout], [true, 0, 'hello there\n']);

    await ask(conversation, 'machine here');
    assert.equal(JSON.parse((await done(conversation, 'where it runs')).answer.split('|')[3]).stdout, env.project + '\n');

    // The turn is over: its token no longer works.
    const machine = JSON.parse(readFileSync(join(env.project, 'mcp.json'), 'utf8'));
    assert.equal(machine.url, 'http://127.0.0.1:' + helperPort + '/mcp');
    const replay = () => fetch(machine.url, {
      method: 'POST', headers: { ...machine.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_command', arguments: { argv: ['say', 'again'] } } }),
    });
    assert.equal((await until(replay, response => response.status === 401, 'revoked token')).status, 401);

    // What the rules do not list is refused, with no card.
    await ask(conversation, 'machine rm -rf x');
    turn = await done(conversation, 'refused command');
    assert.deepEqual([JSON.parse(turn.answer.split('|')[3]).ran, JSON.parse(turn.answer.split('|')[3]).verdict], [false, 'deny']);

    // A command the rules want confirmed shows as the turn's approval card; across a service restart.
    await ask(conversation, 'machine careful one');
    turn = await until(() => lastTurn(env, conversation), value => value.permission, 'confirmation card');
    assert.match(turn.permission.id, /^helper-/);
    assert.equal(turn.permission.title, '要在这台机器上运行命令');
    assert.match(turn.permission.questions[0].question, /careful one/);
    assert.deepEqual(turn.permission.questions[0].options.map(option => option.label), ['允许这一次', '这个任务里同样的命令都允许', '拒绝']);
    assert.equal((await env.get('helper')).body.pending, 1);
    await env.restart();
    // The card is rebuilt from what the helper still holds.
    turn = await until(() => lastTurn(env, conversation), value => value.permission, 'card after restart');
    assert.equal((await env.post('turns/' + turn.id + '/permission', { id: 'helper-nope', answers: {} })).status, 409);
    const allowedOnce = await env.post('turns/' + turn.id + '/permission', { id: turn.permission.id, answers: { [turn.permission.questions[0].question]: '允许这一次' } });
    assert.deepEqual([allowedOnce.status, allowedOnce.body.decision], [200, "allow"], JSON.stringify(allowedOnce.body));
    turn = await done(conversation, 'confirmed command');
    assert.equal(JSON.parse(turn.answer.split('|')[3]).stdout, 'careful one\n');
    assert.equal(turn.permission, undefined);

    // Refused by the person; an answer that is none of the options is a refusal too.
    for (const answer of ['拒绝', '随便']) {
      await ask(conversation, 'machine careful two');
      turn = await until(() => lastTurn(env, conversation), value => value.permission, 'second card');
      const refused = await env.post('turns/' + turn.id + '/permission', { id: turn.permission.id, answers: { q: answer } });
      assert.equal(refused.body.decision, 'deny');
      turn = await done(conversation, 'refused by the person');
      assert.deepEqual([JSON.parse(turn.answer.split('|')[3]).ran, JSON.parse(turn.answer.split('|')[3]).stdout], [false, undefined]);
    }

    // Stop: the turn's command on the machine dies with it, and the card of a stopped turn goes away.
    const pidFile = join(env.project, 'linger.pid');
    await ask(conversation, 'machine linger ' + pidFile);
    const pid = Number((await until(async () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim(), Boolean, 'the long command')));
    assert.ok(alive(pid));
    turn = await lastTurn(env, conversation);
    assert.equal((await env.get('helper')).body.tasks, 1);
    await env.post('turns/' + turn.id + '/cancel');
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'cancelled', 'stopped turn', 500);
    await until(async () => alive(pid), value => !value, 'the command to die');
    assert.equal((await until(async () => (await env.get('helper')).body.tasks, value => value === 0, 'no task left')), 0);

    await ask(conversation, 'machine careful three');
    turn = await until(() => lastTurn(env, conversation), value => value.permission, 'card before stop');
    await env.post('turns/' + turn.id + '/cancel');
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'cancelled' && !value.permission, 'card gone after stop', 500);
    assert.equal((await until(async () => (await env.get('helper')).body.pending, value => value === 0, 'nothing pending')), 0);

    // An account that does not go through the relay gets no connection, even with access on.
    const direct = (await env.post('conversations', { projectId: 'direct' })).body.id;
    await ask(direct, 'machine say hi');
    assert.equal((await done(direct, 'direct turn')).answer, 'no-machine:0');

    // The helper's own record: one line per call.
    const records = (await env.get('helper/audit?n=50')).body.records.filter(item => item.tool === 'run_command');
    assert.deepEqual(records.map(item => item.args.argv.join(' ')).sort(),
      ['careful one', 'careful three', 'careful two', 'careful two', 'linger ' + pidFile, 'here', 'rm -rf x', 'say hello there'].sort());

    // Access off again: tasks started afterwards have nothing.
    assert.deepEqual((await env.put('projects/app/helper', { access: 'off' })).body, { helper: 'off' });
    assert.doesNotMatch(readFileSync(join(env.workspace, 'projects.conf'), 'utf8'), /NAME=app .*HELPER_ACCESS/);
    await ask(conversation, 'machine say hi');
    assert.equal((await done(conversation, 'turn after access off')).answer, 'no-machine:0');

    // Stopped helper: a project with access still runs, without the tools.
    await env.put('projects/app/helper', { access: 'command' });
    status = (await env.post('helper/stop')).body;
    assert.deepEqual([status.running, status.installed], [false, status.bundled]);
    await ask(conversation, 'machine say hi');
    assert.equal((await done(conversation, 'turn without a helper')).answer, 'no-machine:0');
    assert.equal((await env.get('helper/policy')).status, 400);
    status = (await env.post('helper/start')).body;
    assert.equal(status.running, true);
    status = (await env.post('helper/upgrade')).body;
    assert.deepEqual([status.running, status.upgrade], [true, false]);
  } finally {
    await env.post('helper/stop').catch(() => undefined);
    try { process.kill(JSON.parse(readFileSync(join(home, 'run.json'), 'utf8')).pid, 'SIGKILL'); } catch { /* already gone */ }
    delete process.env.CODERFLEET_HELPER_HOME;
    await env.close();
    rmSync(base, { recursive: true, force: true });
  }
});
