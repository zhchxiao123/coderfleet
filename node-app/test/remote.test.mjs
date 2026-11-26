import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { arch, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findBundle, freePort, install, probe, Tunnel } from '../dist/remote.js';
import { fakeDocker } from './helpers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const sshd = '/usr/sbin/sshd';

async function waitPort(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const open = await new Promise(resolve => {
      import('node:net').then(({ connect }) => {
        const socket = connect({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => resolve(false));
      });
    });
    if (open) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('port ' + port + ' did not open');
}

test('the App installs the backend over SSH and reaches it through a tunnel', { timeout: 180_000 }, async t => {
  if (!existsSync(sshd) || !existsSync('/usr/bin/ssh')) { t.skip('OpenSSH is not installed'); return; }
  const bundleArch = arch() === 'arm64' ? 'arm64' : 'x64';
  execFileSync(process.execPath, ['scripts/package-backend.mjs', '--arch', bundleArch, '--node', process.execPath], { cwd: root, stdio: 'ignore' });
  const bundle = findBundle(join(root, 'bundles'), bundleArch);
  assert.ok(bundle, 'bundle was built');

  const dir = await mkdtemp(join(tmpdir(), 'coderfleet-ssh-test-'));
  const remoteHome = join(dir, 'remote-home');
  const bin = join(dir, 'bin');
  await mkdir(bin);
  writeFileSync(join(bin, 'docker'), fakeDocker); chmodSync(join(bin, 'docker'), 0o755);
  writeFileSync(join(dir, 'containers.json'), '{}');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'host_key')]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'client_key')]);
  writeFileSync(join(dir, 'authorized_keys'), readFileSync(join(dir, 'client_key.pub')));
  chmodSync(join(dir, 'authorized_keys'), 0o600);
  const sshPort = await freePort();
  const remotePort = await freePort();
  writeFileSync(join(dir, 'sshd_config'), [
    'Port ' + sshPort, 'ListenAddress 127.0.0.1', 'HostKey ' + join(dir, 'host_key'), 'PidFile ' + join(dir, 'sshd.pid'),
    'AuthorizedKeysFile ' + join(dir, 'authorized_keys'), 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'UsePAM no', 'StrictModes no', 'AllowTcpForwarding yes',
    // The "remote" session: fake Docker on PATH, no systemd, its own install directory.
    'SetEnv PATH=' + bin + ':/usr/local/bin:/usr/bin:/bin CODERFLEET_BACKEND_HOME=' + remoteHome + ' CODERFLEET_BACKEND_NO_SYSTEMD=1 '
      + 'CODERFLEET_WORKSPACE=' + join(dir, 'workspace') + ' CODERFLEET_BACKEND_PORT=' + remotePort + ' FAKE_STATE=' + dir,
  ].join('\n') + '\n');
  // The client wrapper keeps host keys out of the user's ~/.ssh.
  const ssh = join(dir, 'ssh');
  writeFileSync(ssh, '#!/bin/sh\nexec /usr/bin/ssh -F /dev/null -o UserKnownHostsFile=' + join(dir, 'known_hosts') + ' "$@"\n');
  chmodSync(ssh, 0o755);
  const server = spawn(sshd, ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: 'ignore' });
  let tunnel;
  try {
    await waitPort(sshPort);
    const target = { host: userInfo().username + '@127.0.0.1', port: sshPort, identityFile: join(dir, 'client_key') };

    const before = await probe(ssh, target);
    assert.deepEqual([before.arch, before.docker, before.installed], [bundleArch, '27.0.0', '']);

    let log = '';
    const result = await install(ssh, target, bundle.path, text => { log += text; });
    assert.equal(result.port, remotePort);
    assert.equal(result.version, bundle.version);
    assert.equal(result.mode, 'process');
    assert.match(log, /服务已启动/);
    assert.equal((await probe(ssh, target)).installed, bundle.version);

    tunnel = new Tunnel(ssh, target, await freePort(), result.port);
    await tunnel.ready();
    const base = 'http://127.0.0.1:' + tunnel.localPort + '/v1/';
    const headers = { Authorization: 'Bearer ' + result.token };
    const health = await (await fetch(base + 'health', { headers })).json();
    assert.deepEqual({ ...health, pid: undefined, buildId: undefined }, { service: 'coderfleet-node', version: 1, build: bundle.version, pid: undefined, buildId: undefined });
    assert.match(health.buildId, new RegExp('^' + bundle.version.replaceAll('.', '\\.') + '\\+[a-f0-9]{12}$'), 'the bundle carries its build ID');
    assert.ok(Number.isInteger(health.pid));
    const overview = await (await fetch(base + 'overview', { headers })).json();
    assert.equal(overview.workspace, join(dir, 'workspace'));
    assert.equal(overview.docker, '27.0.0');
    assert.equal((await fetch(base + 'workspace/init', { method: 'POST', headers })).status, 200);
    assert.ok(existsSync(join(dir, 'workspace', 'Dockerfile')), 'template shipped in the bundle');

    // Reinstalling (an upgrade) keeps the token and restarts the service.
    const again = await install(ssh, target, bundle.path, () => undefined);
    assert.equal(again.token, result.token);
    await tunnel.ready();
    assert.equal((await fetch(base + 'health', { headers })).status, 200);
  } finally {
    tunnel?.stop();
    const pidFile = join(remoteHome, 'backend.pid');
    if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch { /* already stopped */ } }
    server.kill();
    await new Promise(resolve => setTimeout(resolve, 300));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
