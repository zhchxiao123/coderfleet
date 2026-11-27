import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { serve } from '../dist/server.js';

// Fake Docker CLI. Container state lives in $FAKE_STATE/containers.json.
// `docker exec` runs the command on this machine with the container's
// /workspace mapped to the project directory, so real workers, the control
// mailbox and the host follower run end to end. Every call is logged.
export const fakeDocker = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const [command, ...args] = process.argv.slice(2);
const state = process.env.FAKE_STATE;
appendFileSync(state + '/docker.log', JSON.stringify([command, ...args]) + '\\n');
const file = state + '/containers.json';
const containers = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const save = () => writeFileSync(file, JSON.stringify(containers));
const project = process.env.FAKE_PROJECT;
if (command === 'version') { console.log(args.join(' ').includes('Arch') ? process.env.FAKE_ARCH || 'arm64' : '27.0.0'); process.exit(0); }
if (command === 'ps') { for (const [name, value] of Object.entries(containers)) console.log(name + '\\t' + value + '\\t' + value); process.exit(0); }
if (command === 'image') process.exit(process.env.FAKE_IMAGE === 'missing' ? 1 : 0);
if (command === 'build') {
  console.log('building ' + args.join(' '));
  // FAKE_BUILD_STEPS: print BuildKit-style steps slowly (the UI preview shows progress).
  const steps = Number(process.env.FAKE_BUILD_STEPS || 0);
  for (let step = 1; step <= steps; step += 1) {
    console.log('#' + (step + 4) + ' [' + String(step).padStart(2) + '/' + steps + '] RUN step ' + step);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
  }
  process.exit(0);
}
if (command === 'pull') {
  // FAKE_PULL_MISSING: a tag the registry does not have.
  if (process.env.FAKE_PULL_MISSING && args.at(-1).endsWith(':' + process.env.FAKE_PULL_MISSING)) { console.error('manifest unknown'); process.exit(1); }
  console.log('Pulling from ' + args.at(-1));
  for (const layer of ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc']) console.log(layer + ': Pulling fs layer');
  for (const layer of ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']) console.log(layer + ': Pull complete');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_PULL_MS || 0));
  console.log('cccccccccccc: Pull complete');
  process.exit(0);
}
if (command === 'tag') process.exit(0);
if (command === 'rm') { for (const name of args.filter(value => !value.startsWith('-'))) delete containers[name]; save(); process.exit(0); }
if (command === 'compose') {
  const services = args.slice(3).filter(value => !value.startsWith('-'));
  const action = args[2];
  // Without services, compose acts on every container of the file.
  for (const service of services.length || action !== 'stop' ? services : Object.keys(containers)) {
    const name = service.replace('-project-', '-');
    if (action === 'up') containers[name] = 'running';
    if (action === 'stop' && containers[name]) containers[name] = 'exited';
  }
  save();
  console.log(action + ' ' + services.join(' '));
  process.exit(0);
}
if (command === 'inspect') {
  const format = args[1];
  const running = containers[args.at(-1)] === 'running';
  if (!running) { console.log('false'); process.exit(0); }
  // $FAKE_STATE/mounts.json: container name → the directories mounted in it (only asked for a project's added accounts).
  if (format.includes('.Mounts')) {
    const mounts = existsSync(state + '/mounts.json') ? JSON.parse(readFileSync(state + '/mounts.json', 'utf8')) : {};
    console.log((mounts[args.at(-1)] ?? []).join(' '));
    process.exit(0);
  }
  console.log(format.includes('Networks') ? 'true ' + process.env.FAKE_NETWORK + ' ' : 'true');
  process.exit(0);
}
if (command === 'network') { console.log(args.at(-1) === 'relay-net' ? 'true' : 'false'); process.exit(0); }
if (command !== 'exec') { console.error('unexpected docker call ' + command); process.exit(1); }
let detached = false; const env = { ...process.env, PATH: process.env.FAKE_BIN + ':' + process.env.PATH };
let index = 0;
for (; index < args.length; index += 1) {
  const value = args[index];
  if (value === '-d') detached = true;
  else if (value === '-i' || value === '-it') continue;
  else if (value === '--workdir') index += 1;
  else if (value === '--env' || value === '-e') { const [k, ...v] = args[++index].split('='); env[k] = v.join('='); }
  else if (value === '--env-file') for (const line of readFileSync(args[++index], 'utf8').split('\\n').filter(Boolean)) { const [k, ...v] = line.split('='); env[k] = v.join('='); }
  else break;
}
if (containers[args[index]] !== 'running') { console.error('container is not running'); process.exit(1); }
const argv = args.slice(index + 1).map(value => value.replaceAll('/workspace', project));
if (detached) {
  // The task specification holds container paths; map them like the argv.
  const spec = /--spec '([^']+)'/.exec(argv.join(' '))?.[1];
  if (spec) writeFileSync(spec, readFileSync(spec, 'utf8').replaceAll('/workspace', project));
  spawn(argv[0], argv.slice(1), { env, cwd: project, detached: true, stdio: 'ignore' }).unref();
  process.exit(0);
}
const child = spawn(argv[0], argv.slice(1), { env, cwd: project, stdio: 'inherit' });
child.once('exit', code => process.exit(code ?? 1));
`;

// Stand-in for the container's python3, which only the usage probe runs: prints
// $FAKE_USAGE ($FAKE_USAGE_CODEX for a Codex account, $FAKE_USAGE_AGY for an Antigravity one),
// or "not signed in".
export const fakePython = `#!/usr/bin/env node
const codex = process.argv.at(-1).includes('chatgpt.com');
const agy = process.argv.at(-1).includes('cloudcode-pa');
console.log((codex && process.env.FAKE_USAGE_CODEX) || (agy ? process.env.FAKE_USAGE_AGY : process.env.FAKE_USAGE) || '{"error": "no_credentials"}');
`;

export async function port() {
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const { port: value } = server.address();
  await new Promise(done => server.close(done));
  return value;
}

export async function until(operation, matches, label, attempts = 200) {
  let last;
  for (let index = 0; index < attempts; index += 1) {
    last = await operation();
    if (matches(last)) return last;
    await sleep(50);
  }
  throw new Error('Timed out waiting for ' + label + ': ' + JSON.stringify(last)?.slice(0, 600));
}

/**
 * A temporary workspace, project directory, fake binaries and a running
 * service. `bins` maps executable names to script sources.
 */
export async function environment({ accounts = '', projects = (project) => '', bins = {}, containers = {}, network = 'relay-net' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'coderfleet-node-test-'));
  const workspace = join(root, 'workspace');
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  await mkdir(workspace); await mkdir(project); await mkdir(bin);
  await writeFile(join(workspace, 'accounts.conf'), accounts);
  await writeFile(join(workspace, 'projects.conf'), projects(project));
  await writeFile(join(root, 'containers.json'), JSON.stringify(containers));
  // Workers start through `setsid -w` (util-linux). macOS has none: a stand-in that starts
  // a new session the same way, so the tests run there too.
  const setsid = ['/usr/bin/setsid', '/bin/setsid'].some(path => existsSync(path))
    ? {} : { setsid: "#!/bin/sh\n[ \"$1\" = \"-w\" ] && shift\nexec perl -MPOSIX -e 'if (POSIX::setsid() < 0) { my $pid = fork; die \"fork: $!\" unless defined $pid; if ($pid) { waitpid($pid, 0); exit($? & 127 ? 128 + ($? & 127) : $? >> 8) } POSIX::setsid() } exec @ARGV or die \"exec: $!\"' \"$@\"\n" };
  for (const [name, source] of Object.entries({ docker: fakeDocker, python3: fakePython, ...setsid, ...bins })) {
    await writeFile(join(bin, name), source);
    await chmod(join(bin, name), 0o755);
  }
  Object.assign(process.env, { FAKE_STATE: root, FAKE_BIN: bin, FAKE_PROJECT: project, FAKE_NETWORK: network });
  const token = 'synthetic-node-test-token-0000000';
  const config = join(root, 'config.json');
  const servicePort = await port();
  await writeFile(config, JSON.stringify({ token, port: servicePort, dockerPath: join(bin, 'docker'), workspace: 'workspace', stateDirectory: 'state' }));
  let server = await serve(config);
  const stop = () => new Promise(done => { server.close(done); server.closeAllConnections(); });
  const base = 'http://127.0.0.1:' + servicePort + '/v1/';
  // No keep-alive: a restarted service must not see requests on a socket the old one closed.
  const call = (method, path, value, bearer = token) => new Promise((resolve, reject) => {
    const body = value === undefined ? undefined : JSON.stringify(value);
    const request = httpRequest(base + path, {
      method, agent: false,
      headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json', ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (error) { reject(error); }
      });
    });
    request.once('error', reject);
    request.end(body);
  });
  return {
    root, workspace, project, bin, port: servicePort,
    /** A request with another bearer token (a paired phone, or a wrong one). */
    as: (bearer, method, path, value) => call(method, path, value, bearer),
    get: path => call('GET', path),
    post: (path, value = {}) => call('POST', path, value),
    /** A file sent as the request body (the App's upload; `projectId` null: to 领航); `length` overrides the declared size. */
    upload: (projectId, name, data, length = data.length) => new Promise((resolve, reject) => {
      const request = httpRequest(base + (projectId === null ? 'lead' : 'projects/' + projectId) + '/uploads?name=' + encodeURIComponent(name), {
        method: 'POST', agent: false, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream', 'Content-Length': length },
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      request.once('error', reject);
      request.end(length === data.length ? data : undefined);
    }),
    delete: path => call('DELETE', path),
    put: (path, value) => call('PUT', path, value),
    del: path => call('DELETE', path),
    async restart() { await stop(); server = await serve(config); },
    async close() {
      await stop();
      // Detached workers may still be finishing in the project directory.
      if (process.env.KEEP_TEST_DIR) console.log('KEPT ' + root);
      else await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    },
  };
}

export async function lastTurn(env, conversation) {
  return (await env.get('conversations/' + conversation + '/turns')).body.at(-1);
}

// A stand-in for the system model (Anthropic Messages). `script(prompt, results, body)`: `prompt`
// is the run's first message, `results` what the tool calls of the step before printed
// (undefined on a run's first step). It answers with tool calls ([name, input]) or a sentence;
// throwing makes the request fail. A streamed request (领航's) gets the answer as events, the
// sentence in pieces `pace` ms apart; any other gets it whole. Requests without tools (naming
// a conversation) are put off and not recorded.
export async function systemModel(script, { pace = 0 } = {}) {
  const requests = [];
  const words = content => typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('');
  const server = createHttpServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', async () => {
      const body = JSON.parse(raw);
      if (!body.tools?.length) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '__DEFER__' }] })); return; }
      const last = body.messages.at(-1).content;
      const results = Array.isArray(last) && last.some(block => block.type === 'tool_result') ? last.filter(block => block.type === 'tool_result').map(block => words(block.content)) : undefined;
      const prompt = words(body.messages[0].content);
      requests.push({ prompt, results, body });
      let said;
      try { said = script(prompt, results, body); }
      catch { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'down' } })); return; }
      const content = typeof said === 'string' ? [{ type: 'text', text: said }]
        : said.map(([name, input], index) => ({ type: 'tool_use', id: 'call-' + requests.length + '-' + index, name, input }));
      const stop_reason = typeof said === 'string' ? 'end_turn' : 'tool_use';
      if (!body.stream) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ stop_reason, content })); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n');
      send('message_start', { message: { id: 'msg-' + requests.length, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      for (const [index, block] of content.entries()) {
        if (block.type === 'text') {
          send('content_block_start', { index, content_block: { type: 'text', text: '' } });
          for (const piece of block.text.match(/[\s\S]{1,6}/g) ?? []) {
            if (pace) await new Promise(resolve => setTimeout(resolve, pace));
            send('content_block_delta', { index, delta: { type: 'text_delta', text: piece } });
          }
        } else {
          send('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
          send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
        }
        send('content_block_stop', { index });
      }
      send('message_delta', { delta: { stop_reason }, usage: { output_tokens: 1 } });
      send('message_stop', {});
      response.end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, port: server.address().port, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
