import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
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
if (command === 'version') { console.log('27.0.0'); process.exit(0); }
if (command === 'ps') { for (const [name, value] of Object.entries(containers)) console.log(name + '\\t' + value + '\\t' + value); process.exit(0); }
if (command === 'image') process.exit(process.env.FAKE_IMAGE === 'missing' ? 1 : 0);
if (command === 'build') { console.log('building ' + args.join(' ')); process.exit(0); }
if (command === 'rm') { for (const name of args.filter(value => !value.startsWith('-'))) delete containers[name]; save(); process.exit(0); }
if (command === 'compose') {
  const services = args.slice(3).filter(value => !value.startsWith('-'));
  const action = args[2];
  for (const service of services) {
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
  else if (value === '--env') { const [k, ...v] = args[++index].split('='); env[k] = v.join('='); }
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
  for (const [name, source] of Object.entries({ docker: fakeDocker, ...setsid, ...bins })) {
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
