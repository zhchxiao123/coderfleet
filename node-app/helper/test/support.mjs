// Shared by the helper's tests: a helper on a free port with a home, a project
// directory and a directory of small programs of its own.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHelper } from '../src/server.ts';
import { signToken } from '../src/token.ts';

const PROGRAMS = {
  say: 'echo "$@"',
  fail: 'echo broken >&2; exit 7',
  many: 'i=0; while [ $i -lt 500 ]; do echo line$i; i=$((i+1)); done',
  // Leaves a grandchild behind and tells where it is.
  linger: '/bin/sleep 300 & echo $! > "$1"; wait',
  // Same, but exits at once: the grandchild outlives the program.
  orphan: '/bin/sleep 300 & echo $! > "$1"',
  // Anything that must never run leaves this file behind if it does.
  mark: 'echo "$0 $*" >> EXECUTED',
};

export function alive(pid) {
  try { return readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ').pop()[0] !== 'Z'; }
  catch { return false; }
}

export async function until(check, what, milliseconds = 5000) {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + what);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** rules: the policy's rules; programs named in `marks` are copies of `mark`. */
export async function boot(t, { rules = [], marks = [], options = {}, guiTools = [] } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cfh-')));
  const home = join(base, 'home');
  const root = join(base, 'project');
  const bin = join(base, 'bin');
  for (const directory of [home, root, bin]) mkdirSync(directory);
  const program = (name, script) => { writeFileSync(join(bin, name), '#!/bin/sh\n' + script + '\n'); chmodSync(join(bin, name), 0o755); };
  for (const [name, script] of Object.entries(PROGRAMS)) program(name, script);
  for (const name of marks) program(name, PROGRAMS.mark);
  symlinkSync('/usr/bin/env', join(bin, 'env'));
  const writePolicy = value => writeFileSync(join(home, 'policy.json'), typeof value === 'string' ? value : JSON.stringify(value));
  writePolicy({ path: [bin], rules, gui_tools: guiTools });
  const helper = await startHelper({ home, port: 0, keepaliveMs: 50, ...options });
  t.after(async () => { await helper.close(); rmSync(base, { recursive: true, force: true }); });
  const secret = Buffer.from(readFileSync(join(home, 'secret'), 'utf8').trim(), 'hex');
  const url = 'http://127.0.0.1:' + helper.port;
  const token = (task = 'task-a', extra = {}) => signToken(secret, { task, label: 'demo', access: 'command', root, exp: Math.floor(Date.now() / 1000) + 3600, ...extra });

  async function post(bearer, message, signal) {
    const response = await fetch(url + '/mcp', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) },
      body: JSON.stringify(message),
    });
    const text = await response.text();
    if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
      const data = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      return { status: response.status, body: data[0], raw: text };
    }
    return { status: response.status, body: text ? JSON.parse(text) : undefined, raw: text };
  }
  let id = 0;
  /** The parsed result of one tool call. */
  async function call(bearer, name, args = {}, signal) {
    const answer = await post(bearer, { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }, signal);
    if (answer.status !== 200) return { status: answer.status };
    return { status: 200, failed: answer.body.result.isError, raw: answer.raw, ...JSON.parse(answer.body.result.content[0].text) };
  }
  async function control(method, path, body, bearer = secret.toString('hex')) {
    const response = await fetch(url + '/control/' + path, {
      method, headers: { ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, ...(await response.json()) };
  }
  const waiting = () => until(async () => (await control('GET', 'pending')).pending[0], 'a request to confirm');
  const auditLines = () => {
    const directory = join(home, 'audit');
    const today = new Date();
    const name = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0') + '.jsonl';
    try { return readFileSync(join(directory, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch { return []; }
  };
  return { base, home, root, bin, helper, secret, url, token, post, call, control, waiting, auditLines, writePolicy, program };
}
