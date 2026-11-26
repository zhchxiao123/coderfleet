import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaultPolicy } from '../src/policy.ts';
import { signToken } from '../src/token.ts';
import { PROTOCOL, VERSION } from '../src/version.ts';
import { alive, boot, until } from './support.mjs';

const allow = program => ({ program, action: 'allow' });
const pidIn = file => until(() => existsSync(file) && Number(readFileSync(file, 'utf8')), 'the pid file ' + file);

test('MCP: initialize, the tool list, notifications, and GET is not offered', async t => {
  const h = await boot(t);
  const hello = await h.post(h.token(), { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  assert.equal(hello.status, 200);
  assert.equal(hello.body.result.serverInfo.name, 'machine');
  assert.equal(hello.body.result.protocolVersion, '2025-06-18');
  assert.equal((await h.post(h.token(), { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const list = await h.post(h.token(), { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.body.result.tools.map(tool => tool.name), ['machine_info', 'run_command', 'list_serial_ports', 'read_serial']);
  assert.equal((await fetch(h.url + '/mcp', { headers: { authorization: 'Bearer ' + h.token() } })).status, 405);
  assert.equal((await h.post(h.token(), { jsonrpc: '2.0', id: 3, method: 'resources/list' })).body.error.code, -32601);
});

test('tokens: missing, wrongly signed, expired and revoked ones get 401', async t => {
  const h = await boot(t, { rules: [allow('say')] });
  const message = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  assert.equal((await h.post('', message)).status, 401);
  assert.equal((await h.post('garbage', message)).status, 401);
  const forged = signToken(Buffer.alloc(32, 7), { task: 'x', label: 'x', access: 'command', root: h.root, exp: Math.floor(Date.now() / 1000) + 3600 });
  assert.equal((await h.post(forged, message)).status, 401);
  const good = h.token();
  const [head, payload, signature] = good.split('.');
  const widened = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), root: '/' })).toString('base64url');
  assert.equal((await h.post([head, widened, signature].join('.'), message)).status, 401, 'a changed grant keeps no valid signature');
  assert.equal((await h.post(h.token('old', { exp: Math.floor(Date.now() / 1000) - 1 }), message)).status, 401);
  assert.equal((await h.post(good, message)).status, 200);
  assert.equal((await h.control('POST', 'revoke', { task: 'task-a' })).status, 200);
  assert.equal((await h.post(good, message)).status, 401);
  assert.equal((await h.call(good, 'run_command', { argv: ['say', 'hi'] })).status, 401);
  assert.equal((await h.control('POST', 'token', { task: 'task-a', access: 'command', root: h.root })).status, 409, 'no new token for a revoked task');
});

test('the management port opens only to the master secret', async t => {
  const h = await boot(t);
  for (const path of ['status', 'pending', 'policy', 'audit']) {
    assert.equal((await h.control('GET', path, undefined, '')).status, 401, path + ' without anything');
    assert.equal((await h.control('GET', path, undefined, h.token())).status, 401, path + ' with a task token');
    assert.equal((await h.control('GET', path, undefined, 'ab'.repeat(32))).status, 401, path + ' with a wrong secret');
  }
  assert.equal((await h.control('POST', 'revoke', { task: 'task-a' }, h.token())).status, 401);
  const status = await h.control('GET', 'status');
  assert.equal(status.status, 200);
  assert.equal(status.version, VERSION);
  assert.equal(status.protocol, PROTOCOL);
});

test('the management port signs tokens that the MCP side accepts', async t => {
  const h = await boot(t, { rules: [allow('say')] });
  const made = await h.control('POST', 'token', { task: 'turn-1', label: 'reminis', access: 'command', root: h.root });
  assert.equal(made.status, 200);
  assert.ok(made.exp > Date.now() / 1000 + 23 * 3600);
  const result = await h.call(made.token, 'run_command', { argv: ['say', 'hello'] });
  assert.equal(result.stdout, 'hello\n');
  assert.equal((await h.control('POST', 'token', { task: 't', access: 'command', root: join(h.base, 'nowhere') })).status, 400);
  assert.equal((await h.control('POST', 'token', { task: 't', access: 'root', root: h.root })).status, 400);
});

test('machine_info tells what the task may do', async t => {
  const h = await boot(t, { rules: [allow('say'), { program: 'esptool', args_any: ['write-flash'], action: 'confirm' }] });
  const info = await h.call(h.token(), 'machine_info');
  assert.equal(info.access, 'command');
  assert.equal(info.system, 'Linux');
  assert.deepEqual(info.programs, { allow: ['say'], confirm: ['esptool [write-flash]'], deny: [], anything_else: 'deny' });
  assert.equal(info.gui.available, false);
});

test('a screen tool is refused for a command-level task, and is not offered at all in this version', async t => {
  const h = await boot(t, { guiTools: ['get_window_state'] });
  const refused = await h.call(h.token(), 'get_window_state', {});
  assert.equal(refused.failed, true);
  assert.match(refused.error, /no screen access/);
  const unsupported = await h.call(h.token('g', { access: 'gui' }), 'get_window_state', {});
  assert.equal(unsupported.failed, true);
  assert.match(unsupported.error, /not part of this version/);
});

test('an allowed command runs and returns its output; a failing one returns its exit code', async t => {
  const h = await boot(t, { rules: [allow('say'), allow('fail')] });
  const ok = await h.call(h.token(), 'run_command', { argv: ['say', 'a b', '*', '$HOME', '|', 'x'] });
  assert.deepEqual({ ran: ok.ran, verdict: ok.verdict, rule: ok.rule, exit_code: ok.exit_code }, { ran: true, verdict: 'allow', rule: 'say', exit_code: 0 });
  assert.equal(ok.stdout, 'a b * $HOME | x\n', 'no shell touches the arguments');
  assert.match(ok.raw, /^: waiting\n\n/, 'the answer is an event stream that starts before the command ends');
  const bad = await h.call(h.token(), 'run_command', { argv: ['fail'] });
  assert.deepEqual({ ran: bad.ran, exit_code: bad.exit_code, stderr: bad.stderr }, { ran: true, exit_code: 7, stderr: 'broken\n' });
});

test('what the rules do not list is refused; so are paths and programs that are not installed', async t => {
  const h = await boot(t, { rules: [allow('say'), allow('ghost')], marks: ['other'] });
  const unlisted = await h.call(h.token(), 'run_command', { argv: ['other'] });
  assert.deepEqual({ ran: unlisted.ran, verdict: unlisted.verdict, rule: unlisted.rule }, { ran: false, verdict: 'deny', rule: 'not-listed' });
  assert.equal((await h.call(h.token(), 'run_command', { argv: [join(h.bin, 'say'), 'x'] })).rule, 'program-not-a-bare-name');
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['../bin/say'] })).rule, 'program-not-a-bare-name');
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['ghost'] })).rule, 'not-installed');
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['ls'] })).rule, 'not-listed', 'programs outside the listed directories are not found by name either');
  assert.equal(existsSync(join(h.root, 'EXECUTED')), false);
});

test('built-in refusals hold even when the rules file allows them', async t => {
  const names = ['sudo', 'su', 'espefuse', 'espefuse.py', 'esptool', 'tool'];
  const h = await boot(t, { rules: names.map(allow), marks: names });
  const cases = [
    [['sudo', 'tool'], 'builtin:sudo'],
    [['su', '-c', 'tool'], 'builtin:su'],
    [['espefuse', '--port', '/dev/x', 'burn-efuse', 'FLASH_CRYPT_CNT'], 'builtin:efuse'],
    [['espefuse.py', 'burn_key', 'BLOCK_KEY0', 'k.bin'], 'builtin:efuse'],
    [['espefuse', 'write-protect-efuse', 'DIS_ICACHE'], 'builtin:efuse'],
    [['espefuse', 'read_protect_efuse', 'BLOCK_KEY0'], 'builtin:efuse'],
    [['espefuse', 'burn-key', '--do-not-confirm'], 'builtin:efuse'],
    [['tool', '--do-not-confirm'], 'builtin:do-not-confirm'],
    [['esptool', '--force', 'write-flash', '0x0', 'a.bin'], 'builtin:force-write'],
    [['esptool', 'erase_flash', '--force'], 'builtin:force-write'],
    [['tool', join(h.home, 'secret')], 'builtin:helper-directory'],
    [['tool', '--input=' + join(h.home, 'policy.json')], 'builtin:helper-directory'],
    [['tool', '../home/secret'], 'builtin:helper-directory'],
  ];
  for (const [argv, rule] of cases) {
    const result = await h.call(h.token(), 'run_command', { argv });
    assert.deepEqual({ ran: result.ran, verdict: result.verdict, rule: result.rule }, { ran: false, verdict: 'deny', rule }, argv.join(' '));
  }
  symlinkSync(h.home, join(h.root, 'shortcut'));
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['tool', 'shortcut/secret'] })).rule, 'builtin:helper-directory', 'through a symlink');
  assert.equal(existsSync(join(h.root, 'EXECUTED')), false, 'none of them ran');
  // The same programs do run when the arguments are harmless, so the refusals above are not the rules' doing.
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['espefuse', 'summary'] })).ran, true);
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['esptool', 'flash-id'] })).ran, true);
});

test('a program that lives in the helper directory is refused, also through a link in the program path', async t => {
  const h = await boot(t, { rules: [allow('inner')] });
  writeFileSync(join(h.home, 'inner'), '#!/bin/sh\necho ran >> EXECUTED\n', { mode: 0o755 });
  symlinkSync(join(h.home, 'inner'), join(h.bin, 'inner'));
  const result = await h.call(h.token(), 'run_command', { argv: ['inner'] });
  assert.deepEqual({ ran: result.ran, rule: result.rule }, { ran: false, rule: 'builtin:helper-directory' });
  assert.equal(existsSync(join(h.root, 'EXECUTED')), false);
});

test('order of the rules: deny, then confirm, then allow; no match is a refusal', async t => {
  const h = await boot(t, {
    rules: [
      allow('tool'),
      { program: 'tool', args_any: ['write-flash'], action: 'confirm' },
      { program: 'tool', args_any: ['erase-flash'], action: 'deny' },
      { program: 'tool', args_any: ['erase-flash'], action: 'confirm' },
      { program: 'narrow', args_any: ['read-mac'], action: 'allow' },
    ],
    marks: ['tool', 'narrow'],
    options: { confirmSeconds: 0.2 },
  });
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['tool', 'erase_flash'] })).verdict, 'deny');
  const asked = await h.call(h.token(), 'run_command', { argv: ['tool', 'write_flash', '0x0'] });
  assert.deepEqual({ verdict: asked.verdict, rule: asked.rule }, { verdict: 'deny-unconfirmed', rule: 'tool [write-flash]' }, 'confirm wins over the plain allow');
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['tool', 'flash-id'] })).verdict, 'allow');
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['narrow', 'read-mac'] })).verdict, 'allow');
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['narrow', 'write-flash'] })).rule, 'not-listed');
});

test('a rules file that cannot be read allows nothing, and says so', async t => {
  const h = await boot(t, { rules: [allow('say')] });
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['say', 'x'] })).ran, true);
  for (const content of ['{ not json', JSON.stringify({ path: ['relative'], rules: [] }), JSON.stringify({ path: [h.bin], rules: [{ program: 'say', action: 'yes' }] })]) {
    h.writePolicy(content);
    const result = await h.call(h.token(), 'run_command', { argv: ['say', 'x'] });
    assert.deepEqual({ ran: result.ran, verdict: result.verdict, rule: result.rule }, { ran: false, verdict: 'deny', rule: 'policy-invalid' });
  }
  assert.equal((await h.control('GET', 'status')).policy_valid, false);
  rmSync(join(h.home, 'policy.json'));
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['say', 'x'] })).rule, 'policy-invalid');
});

test('the default rules: everything runs, flash writes are confirmed', () => {
  const mac = defaultPolicy('darwin');
  assert.deepEqual(mac.path, ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin']);
  assert.equal(mac.unlisted, 'allow');
  assert.deepEqual(mac.gui_tools, ['get_window_state', 'get_desktop_state', 'zoom']);
  const linux = defaultPolicy('linux');
  assert.deepEqual(linux.path, ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin']);
  assert.equal(linux.unlisted, 'allow');
  assert.deepEqual(linux.rules.map(rule => [rule.program, rule.action]), [['esptool', 'confirm']]);
  assert.ok(linux.rules[0].args_any.includes('write-flash'));
});

test('with nothing switched off every installed command runs; the owner switches one off, or makes the rest ask', async t => {
  const h = await boot(t, { unlisted: 'allow', rules: [{ program: 'say', args_any: ['secret'], action: 'deny' }], options: { confirmSeconds: 0.2 } });
  const ran = await h.call(h.token(), 'run_command', { argv: ['say', 'hello'] });
  assert.deepEqual({ ran: ran.ran, verdict: ran.verdict, rule: ran.rule, stdout: ran.stdout }, { ran: true, verdict: 'allow', rule: 'unlisted', stdout: 'hello\n' });
  const off = await h.call(h.token(), 'run_command', { argv: ['say', 'secret'] });
  assert.deepEqual({ ran: off.ran, verdict: off.verdict, rule: off.rule }, { ran: false, verdict: 'deny', rule: 'say [secret]' });
  assert.match(off.message, /switched this command off/);
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['sudo', 'say', 'x'] })).rule, 'builtin:sudo', 'what is always refused stays refused');
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['nowhere'] })).rule, 'not-installed');
  assert.deepEqual((await h.call(h.token(), 'machine_info')).programs, { allow: [], confirm: [], deny: ['say [secret]'], anything_else: 'allow' });

  // A rules file from before the setting existed means the same as today's default.
  h.writePolicy({ path: [h.bin], rules: [], gui_tools: [] });
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['say', 'old'] })).rule, 'unlisted');

  const strict = await h.control('POST', 'policy', { unlisted: 'confirm' });
  assert.equal(strict.policy.unlisted, 'confirm');
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['say', 'x'] })).verdict, 'deny-unconfirmed', 'nobody answered, so it did not run');
  assert.equal((await h.control('POST', 'policy', { unlisted: 'sometimes' })).status, 400);
});

test('the owner sets where programs are looked up', async t => {
  const h = await boot(t, { unlisted: 'allow' });
  const other = join(h.base, 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'elsewhere'), '#!/bin/sh\necho found\n'); chmodSync(join(other, 'elsewhere'), 0o755);
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['elsewhere'] })).rule, 'not-installed');
  const changed = await h.control('POST', 'policy', { path: [h.bin, other, other] });
  assert.deepEqual(changed.policy.path, [h.bin, other]);
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['elsewhere'] })).stdout, 'found\n');
  assert.equal((await h.control('POST', 'policy', { path: ['bin'] })).status, 400, 'a relative directory is refused');
  assert.equal((await h.control('POST', 'policy', { path: [] })).status, 400);
});

test('the working directory cannot leave the project directory, by .. or by symlink', async t => {
  const h = await boot(t, { rules: [allow('mark'), allow('say')] });
  mkdirSync(join(h.root, 'ios'));
  mkdirSync(join(h.base, 'outside'));
  symlinkSync(join(h.base, 'outside'), join(h.root, 'escape'));
  symlinkSync(join(h.root, 'ios'), join(h.root, 'alias'));
  for (const cwd of ['..', '../outside', 'ios/../..', 'escape', '/', '/tmp', join(h.base, 'outside')]) {
    const result = await h.call(h.token(), 'run_command', { argv: ['mark'], cwd });
    assert.deepEqual({ ran: result.ran, verdict: result.verdict, rule: result.rule }, { ran: false, verdict: 'deny', rule: 'cwd-outside-root' }, cwd);
  }
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['mark'], cwd: 'missing' })).rule, 'cwd-not-found');
  assert.equal(existsSync(join(h.base, 'outside', 'EXECUTED')), false);
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['mark'], cwd: 'ios' })).ran, true);
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['mark'], cwd: 'alias' })).ran, true, 'a link that stays inside is fine');
  assert.equal(readFileSync(join(h.root, 'ios', 'EXECUTED'), 'utf8').split('\n').filter(Boolean).length, 2);
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['mark'], cwd: join(h.root, 'ios') })).ran, true, 'an absolute path inside is fine');
});

test('a command sees a fixed small environment, nothing of the helper\'s own', async t => {
  process.env.CFH_TEST_LEAK = 'leaked';
  process.env.ANTHROPIC_API_KEY_TEST = 'leaked';
  t.after(() => { delete process.env.CFH_TEST_LEAK; delete process.env.ANTHROPIC_API_KEY_TEST; });
  const h = await boot(t, { rules: [allow('env')] });
  const result = await h.call(h.token(), 'run_command', { argv: ['env'] });
  const seen = Object.fromEntries(result.stdout.trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  assert.deepEqual(Object.keys(seen).sort(), ['HOME', 'LANG', 'LOGNAME', 'PATH', 'TMPDIR', 'USER']);
  assert.equal(seen.PATH, h.bin);
  assert.doesNotMatch(result.stdout, /leaked/);
});

test('timeout kills the whole process group, grandchildren included', async t => {
  const h = await boot(t, { rules: [allow('linger')] });
  const started = Date.now();
  const result = await h.call(h.token(), 'run_command', { argv: ['linger', 'pid'], timeout_s: 1 });
  assert.equal(result.ran, true);
  assert.equal(result.timed_out, true);
  assert.ok(Date.now() - started < 4000);
  const pid = Number(readFileSync(join(h.root, 'pid'), 'utf8'));
  assert.ok(pid > 1);
  await until(() => !alive(pid), 'the grandchild to die', 2000);
});

test('what a program leaves running dies when the program exits', async t => {
  const h = await boot(t, { rules: [allow('orphan')] });
  const result = await h.call(h.token(), 'run_command', { argv: ['orphan', 'pid'] });
  assert.equal(result.exit_code, 0);
  await until(() => !alive(Number(readFileSync(join(h.root, 'pid'), 'utf8'))), 'the leftover process to die', 2000);
});

test('timeout_s and argv are checked', async t => {
  const h = await boot(t, { rules: [allow('say')] });
  for (const args of [{ argv: ['say'], timeout_s: 0 }, { argv: ['say'], timeout_s: 1801 }, { argv: ['say'], timeout_s: 1.5 }, { argv: [] }, { argv: 'say hi' }, { argv: ['say', 3] }, {}]) {
    const result = await h.call(h.token(), 'run_command', args);
    assert.equal(result.failed, true, JSON.stringify(args));
    assert.equal(result.ran, false);
  }
});

test('the full output goes to a log file in the project; the answer carries the last 200 lines', async t => {
  const h = await boot(t, { rules: [allow('many')] });
  const result = await h.call(h.token(), 'run_command', { argv: ['many'] });
  assert.equal(result.truncated, true);
  const tail = result.stdout.trim().split('\n');
  assert.equal(tail.length, 200);
  assert.equal(tail[0], 'line300');
  assert.equal(tail[199], 'line499');
  assert.match(result.log, /^\.coderfleet-tasks\/helper\/[a-z0-9-]+\.log$/);
  const full = readFileSync(join(h.root, result.log), 'utf8').trim().split('\n');
  assert.equal(full.length, 500);
  assert.equal(full[0], 'line0');
});

test('a log directory that leads out of the project stops the command', async t => {
  const h = await boot(t, { rules: [allow('mark')] });
  mkdirSync(join(h.base, 'elsewhere'));
  symlinkSync(join(h.base, 'elsewhere'), join(h.root, '.coderfleet-tasks'));
  const result = await h.call(h.token(), 'run_command', { argv: ['mark'] });
  assert.equal(result.failed, true);
  assert.equal(existsSync(join(h.root, 'EXECUTED')), false);
});

test('confirmation: waits, is visible on the management port, and runs when allowed', async t => {
  const h = await boot(t, { rules: [{ program: 'mark', action: 'confirm' }] });
  const first = await h.control('GET', 'pending');
  assert.deepEqual(first.pending, []);
  const poll = h.control('GET', 'pending?since=' + first.version + '&wait=10');
  const call = h.call(h.token('turn-9'), 'run_command', { argv: ['mark', 'one'] });
  const seen = await poll;
  assert.ok(seen.version > first.version, 'the long poll wakes when a request arrives');
  assert.equal(seen.pending.length, 1);
  const item = seen.pending[0];
  assert.deepEqual({ task: item.task, label: item.label, argv: item.argv, cwd: item.cwd }, { task: 'turn-9', label: 'demo', argv: ['mark', 'one'], cwd: h.root });
  assert.equal(existsSync(join(h.root, 'EXECUTED')), false, 'nothing runs while it waits');
  assert.equal((await h.control('POST', 'decide', { id: item.id, decision: 'maybe' })).status, 400);
  assert.equal((await h.control('POST', 'decide', { id: item.id, decision: 'allow' })).status, 200);
  const result = await call;
  assert.deepEqual({ ran: result.ran, verdict: result.verdict, confirmation: result.confirmation }, { ran: true, verdict: 'confirm', confirmation: 'allowed' });
  assert.equal(existsSync(join(h.root, 'EXECUTED')), true);
  assert.deepEqual((await h.control('GET', 'pending')).pending, []);
  assert.equal((await h.control('POST', 'decide', { id: item.id, decision: 'allow' })).status, 404, 'an answered request cannot be answered again');
});

test('confirmation: a refusal and nobody answering both end as deny-unconfirmed', async t => {
  const h = await boot(t, { rules: [{ program: 'mark', action: 'confirm' }], options: { confirmSeconds: 0.3 } });
  const call = h.call(h.token(), 'run_command', { argv: ['mark'] });
  const item = await h.waiting();
  await h.control('POST', 'decide', { id: item.id, decision: 'deny' });
  const refused = await call;
  assert.deepEqual({ ran: refused.ran, verdict: refused.verdict, confirmation: refused.confirmation }, { ran: false, verdict: 'deny-unconfirmed', confirmation: 'denied' });
  const started = Date.now();
  const ignored = await h.call(h.token(), 'run_command', { argv: ['mark'] });
  assert.deepEqual({ ran: ignored.ran, verdict: ignored.verdict, confirmation: ignored.confirmation }, { ran: false, verdict: 'deny-unconfirmed', confirmation: 'timeout' });
  assert.ok(Date.now() - started >= 250);
  assert.deepEqual((await h.control('GET', 'pending')).pending, []);
  assert.equal(existsSync(join(h.root, 'EXECUTED')), false);
});

test('"allow the same command for this task" stops the asking for that exact command only', async t => {
  const h = await boot(t, { rules: [{ program: 'mark', action: 'confirm' }], options: { confirmSeconds: 0.3 } });
  const call = h.call(h.token('task-a'), 'run_command', { argv: ['mark', 'flash', 'a.bin'] });
  await h.control('POST', 'decide', { id: (await h.waiting()).id, decision: 'allow-task' });
  assert.equal((await call).ran, true);
  const again = await h.call(h.token('task-a'), 'run_command', { argv: ['mark', 'flash', 'a.bin'] });
  assert.deepEqual({ ran: again.ran, confirmation: again.confirmation }, { ran: true, confirmation: 'allowed-for-task' });
  assert.equal((await h.call(h.token('task-a'), 'run_command', { argv: ['mark', 'flash', 'b.bin'] })).verdict, 'deny-unconfirmed', 'another argument asks again');
  assert.equal((await h.call(h.token('task-b'), 'run_command', { argv: ['mark', 'flash', 'a.bin'] })).verdict, 'deny-unconfirmed', 'another task asks again');
  assert.equal(readFileSync(join(h.root, 'EXECUTED'), 'utf8').split('\n').filter(Boolean).length, 2);
});

test('revoking a task kills that task\'s processes and its token; other tasks go on', async t => {
  const h = await boot(t, { rules: [allow('linger'), allow('say'), { program: 'mark', action: 'confirm' }] });
  const a = h.call(h.token('task-a'), 'run_command', { argv: ['linger', 'pid-a'], timeout_s: 60 });
  const b = h.call(h.token('task-b'), 'run_command', { argv: ['linger', 'pid-b'], timeout_s: 60 });
  const waitingA = h.call(h.token('task-a'), 'run_command', { argv: ['mark'] });
  const pidA = await pidIn(join(h.root, 'pid-a'));
  const pidB = await pidIn(join(h.root, 'pid-b'));
  await h.waiting();
  assert.equal((await h.control('GET', 'status')).tasks, 2);
  const revoked = await h.control('POST', 'revoke', { task: 'task-a' });
  assert.equal(revoked.stopped, 1);
  const ended = await a;
  assert.equal(ended.stopped, true);
  await until(() => !alive(pidA), 'task a\'s grandchild to die', 4000);
  const dropped = await waitingA;
  assert.deepEqual({ ran: dropped.ran, confirmation: dropped.confirmation }, { ran: false, confirmation: 'revoked' });
  assert.equal(alive(pidB), true, 'the other task\'s process is untouched');
  assert.equal((await h.call(h.token('task-a'), 'run_command', { argv: ['say', 'x'] })).status, 401);
  assert.equal((await h.call(h.token('task-b'), 'run_command', { argv: ['say', 'still here'] })).stdout, 'still here\n');
  assert.equal((await h.control('GET', 'status')).tasks, 1);
  await h.control('POST', 'revoke', { task: 'task-b' });
  await b;
  await until(() => !alive(pidB), 'task b\'s grandchild to die', 4000);
});

test('a caller that goes away takes its command with it', async t => {
  const h = await boot(t, { rules: [allow('linger')] });
  const gone = new AbortController();
  const call = h.call(h.token(), 'run_command', { argv: ['linger', 'pid'], timeout_s: 60 }, gone.signal).catch(error => error);
  const pid = await pidIn(join(h.root, 'pid'));
  gone.abort();
  await call;
  await until(() => !alive(pid), 'the command to die', 4000);
});

test('stopping the helper kills what it started', async t => {
  const h = await boot(t, { rules: [allow('linger')] });
  const call = h.call(h.token(), 'run_command', { argv: ['linger', 'pid'], timeout_s: 60 }).catch(error => error);
  const pid = await pidIn(join(h.root, 'pid'));
  await h.helper.close();
  await call;
  await until(() => !alive(pid), 'the command to die', 2000);
  assert.equal(existsSync(join(h.home, 'run.json')), false);
});

test('the operation log gets exactly one line per call, whatever the outcome', async t => {
  const h = await boot(t, { rules: [allow('say'), allow('fail'), { program: 'mark', action: 'confirm' }], options: { confirmSeconds: 0.2 } });
  await h.call(h.token(), 'machine_info');
  await h.call(h.token(), 'run_command', { argv: ['say', 'x'] });
  await h.call(h.token(), 'run_command', { argv: ['fail'] });
  await h.call(h.token(), 'run_command', { argv: ['sudo', 'say'] });
  await h.call(h.token(), 'run_command', { argv: ['mark'] });
  await h.call(h.token(), 'run_command', { argv: [] });
  await h.call(h.token(), 'list_serial_ports');
  await h.call(h.token(), 'no_such_tool');
  await h.post(h.token(), { jsonrpc: '2.0', id: 99, method: 'tools/list' });
  await h.call('bad-token', 'run_command', { argv: ['say'] });
  const lines = h.auditLines();
  assert.deepEqual(lines.map(line => [line.tool, line.verdict, line.rule ?? null, line.exit_code ?? null]), [
    ['machine_info', 'allow', null, null],
    ['run_command', 'allow', 'say', 0],
    ['run_command', 'allow', 'fail', 7],
    ['run_command', 'deny', 'builtin:sudo', null],
    ['run_command', 'deny-unconfirmed', 'mark', null],
    ['run_command', 'error', null, null],
    ['list_serial_ports', 'allow', null, null],
    ['no_such_tool', 'error', null, null],
  ]);
  assert.deepEqual(lines[1].args, { argv: ['say', 'x'] });
  assert.equal(lines[1].task, 'task-a');
  assert.equal(lines[1].label, 'demo');
  assert.equal(lines[4].confirmation, 'timeout');
  assert.ok(typeof lines[1].seconds === 'number' && lines[1].time);
  const viaControl = await h.control('GET', 'audit?n=3');
  assert.deepEqual(viaControl.records.map(line => line.tool), ['run_command', 'list_serial_ports', 'no_such_tool']);
});

test('when the operation log cannot be written, nothing runs', async t => {
  const h = await boot(t, { rules: [allow('mark')] });
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['mark'] })).ran, true);
  rmSync(join(h.root, 'EXECUTED'));
  renameSync(join(h.home, 'audit'), join(h.home, 'audit-moved'));
  writeFileSync(join(h.home, 'audit'), 'not a directory');
  const result = await h.call(h.token(), 'run_command', { argv: ['mark'] });
  assert.equal(result.failed, true);
  assert.equal(result.ran, false);
  assert.match(result.error, /operation log/);
  assert.equal(existsSync(join(h.root, 'EXECUTED')), false);
  assert.equal((await h.call(h.token(), 'machine_info')).failed, true, 'no tool works without the log');
});

test('rules are changed through the management port in one step each', async t => {
  const h = await boot(t, { rules: [allow('say')] });
  const before = await h.control('GET', 'policy');
  assert.deepEqual(before.policy.rules, [allow('say')]);
  assert.ok(before.built_in.length >= 5);
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['fail'] })).rule, 'not-listed');
  assert.equal((await h.control('POST', 'policy', { set: allow('fail') })).status, 200);
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['fail'] })).exit_code, 7, 'a new rule works at once');
  await h.control('POST', 'policy', { set: { program: 'fail', action: 'deny' } });
  assert.deepEqual((await h.control('GET', 'policy')).policy.rules, [allow('say'), { program: 'fail', action: 'deny' }], 'the same rule is changed, not added twice');
  assert.equal((await h.control('POST', 'policy', { remove: { program: 'fail' } })).status, 200);
  assert.equal((await h.control('POST', 'policy', { remove: { program: 'fail' } })).status, 400);
  assert.equal((await h.control('POST', 'policy', { set: { program: '/bin/sh', action: 'allow' } })).status, 400);
  assert.equal((await h.control('POST', 'policy', { set: { program: 'x', action: 'always' } })).status, 400);
  assert.deepEqual(JSON.parse(readFileSync(join(h.home, 'policy.json'), 'utf8')).rules, [allow('say')]);
});

test('serial: lists ports and reads what a port sends for the asked time', async t => {
  const devices = mkdtempSync(join(tmpdir(), 'cfh-dev-'));
  // A pseudo-terminal stands in for a board: the script holds the board's end and keeps printing.
  const board = spawn('python3', ['-c', [
    'import os, pty, sys, time',
    'master, slave = pty.openpty()',
    'print(os.ttyname(slave), flush=True)',
    'n = 0',
    'while True:',
    '    os.write(master, ("boot line %d\\n" % n).encode()); n += 1; time.sleep(0.05)',
  ].join('\n')], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { board.kill('SIGKILL'); rmSync(devices, { recursive: true, force: true }); });
  const slave = await new Promise(resolve => board.stdout.once('data', chunk => resolve(String(chunk).trim())));
  symlinkSync(slave, join(devices, 'ttyUSB0'));
  writeFileSync(join(devices, 'ttyS0'), '');
  const h = await boot(t, { options: { serialDirectory: devices } });
  assert.deepEqual((await h.call(h.token(), 'list_serial_ports')).ports, [join(devices, 'ttyUSB0')]);
  const started = Date.now();
  const read = await h.call(h.token(), 'read_serial', { port: join(devices, 'ttyUSB0'), seconds: 1 });
  const took = Date.now() - started;
  assert.match(read.text, /boot line \d+\n/);
  assert.ok(took >= 900 && took < 3000, 'returned after about the asked second, took ' + took);
  assert.equal((await h.call(h.token(), 'read_serial', { port: slave, seconds: 1 })).failed, true, 'only listed ports');
  assert.equal((await h.call(h.token(), 'read_serial', { port: join(devices, 'ttyUSB0'), seconds: 61 })).failed, true);
  const noReset = await h.call(h.token(), 'read_serial', { port: join(devices, 'ttyUSB0'), seconds: 1, reset: true });
  assert.equal(noReset.failed, true);
  assert.match(noReset.error, /esptool/);
});

test('serial: reset runs esptool under the rules before reading', async t => {
  const devices = mkdtempSync(join(tmpdir(), 'cfh-dev-'));
  const board = spawn('python3', ['-c', 'import os, pty, time\nm, s = pty.openpty()\nprint(os.ttyname(s), flush=True)\nwhile True:\n    os.write(m, b"up\\n"); time.sleep(0.05)'], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { board.kill('SIGKILL'); rmSync(devices, { recursive: true, force: true }); });
  symlinkSync(await new Promise(resolve => board.stdout.once('data', chunk => resolve(String(chunk).trim()))), join(devices, 'ttyACM0'));
  const h = await boot(t, { rules: defaultPolicy('linux').rules, unlisted: 'allow', options: { serialDirectory: devices } });
  h.program('esptool', 'echo "$*" > ' + join(h.base, 'esptool-args'));
  const read = await h.call(h.token(), 'read_serial', { port: join(devices, 'ttyACM0'), seconds: 1, reset: true });
  assert.match(read.text, /up\n/);
  assert.equal(readFileSync(join(h.base, 'esptool-args'), 'utf8').trim(), '--port ' + join(devices, 'ttyACM0') + ' --after hard-reset flash-id');
});

test('the firmware rules: reads run, writes ask, efuse and forced writes never', async t => {
  const h = await boot(t, { rules: defaultPolicy('linux').rules, unlisted: 'allow', marks: ['esptool', 'espefuse'], options: { confirmSeconds: 0.2 } });
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['esptool', '--port', '/dev/ttyUSB0', 'flash-id'] })).verdict, 'allow');
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['esptool', '--port', '/dev/ttyUSB0', 'write-flash', '0x0', 'build/merged.bin'] })).verdict, 'deny-unconfirmed');
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['esptool', 'write_flash', '0x0', 'a.bin'] })).verdict, 'deny-unconfirmed', 'the old spelling asks too');
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['esptool', '--force', 'write-flash', '0x0', 'a.bin'] })).rule, 'builtin:force-write');
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['esptool', 'write-flash', '--do-not-confirm'] })).rule, 'builtin:do-not-confirm');
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['espefuse', 'burn-efuse', 'X'] })).rule, 'builtin:efuse');
  assert.equal((await h.call(h.token(), 'run_command', { argv: ['esptool', 'run'] })).rule, 'unlisted');
});

test('command line: serve, token, policy, audit, status, stop', async t => {
  const base = mkdtempSync(join(tmpdir(), 'cfh-cli-'));
  const env = { ...process.env, CODERFLEET_HELPER_HOME: join(base, 'home') };
  const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
  const cli = (...args) => spawnSync(process.execPath, [main, ...args], { env, encoding: 'utf8' });
  const service = spawn(process.execPath, [main, 'serve', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { service.kill('SIGKILL'); rmSync(base, { recursive: true, force: true }); });
  const record = await until(() => existsSync(join(base, 'home', 'run.json')) && JSON.parse(readFileSync(join(base, 'home', 'run.json'), 'utf8')), 'the service to start');
  assert.equal(record.pid, service.pid);
  assert.equal(readFileSync(join(base, 'home', 'secret'), 'utf8').trim().length, 64);
  assert.equal(JSON.parse(cli('status').stdout).version, VERSION);

  const shown = cli('policy', 'show').stdout;
  assert.deepEqual(JSON.parse(shown.slice(0, shown.indexOf('\nAlways refused'))), defaultPolicy('linux'), 'the first start writes the default rules');
  assert.match(shown, /sudo and su never run/);
  assert.equal(cli('policy', 'set', 'true', 'allow').status, 0);
  assert.equal(cli('policy', 'set', 'true', 'sometimes').status, 1);

  const token = cli('token', '--root', base, '--label', 'by hand').stdout.trim();
  assert.match(token, /^cfh1\./);
  const answer = await fetch('http://127.0.0.1:' + record.port + '/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_command', arguments: { argv: ['true'] } } }),
  });
  assert.equal(answer.headers.get('content-type'), 'application/json; charset=utf-8', 'a caller that does not ask for a stream gets plain JSON');
  assert.equal(JSON.parse((await answer.json()).result.content[0].text).exit_code, 0);

  const audit = cli('audit', '-n', '5').stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(audit.map(line => [line.tool, line.label, line.exit_code]), [['run_command', 'by hand', 0]]);
  assert.equal(cli('policy', 'remove', 'true').status, 0);
  assert.equal(JSON.parse(cli('policy', 'unlisted', 'deny').stdout).unlisted, 'deny');
  assert.equal(cli('policy', 'unlisted', 'maybe').status, 1);
  assert.deepEqual(JSON.parse(cli('policy', 'path', '/usr/bin', '/bin').stdout).path, ['/usr/bin', '/bin']);
  assert.equal(cli('token').status, 1);

  const exited = new Promise(resolve => service.once('exit', code => resolve(code)));
  assert.equal(cli('stop').stdout.trim(), 'Stopped');
  assert.equal(await exited, 0);
  assert.equal(existsSync(join(base, 'home', 'run.json')), false);
  assert.equal(cli('status').status, 3);
});
