import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureLocal, probeLocal } from '../dist/local-backend.js';
import { BUILD_ID, VERSION } from '../dist/version.js';
import { port } from './helpers.mjs';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function listen(handler) {
  return new Promise(resolve => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('the App-managed backend moves off a busy port, replaces older builds and restarts on request', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coderfleet-local-'));
  const token = 'managed-token-000000000000000000000';
  const configPath = join(dir, 'local-backend.json');
  const options = (extra = {}) => ({
    configPath, managed: true, logPath: join(dir, 'backend.log'), pidPath: join(dir, 'backend.pid'),
    command: [process.execPath, cli], env: { ...process.env }, version: BUILD_ID, ...extra,
  });
  const stopOurs = async () => {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    await fetch('http://127.0.0.1:' + config.port + '/v1/shutdown', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }).catch(() => undefined);
  };
  // Another backend (different token) already holds the configured port.
  const foreign = await listen((request, response) => { response.writeHead(401); response.end('{"error":"Invalid backend token"}'); });
  const busy = foreign.address().port;
  try {
    writeFileSync(configPath, JSON.stringify({ port: busy, token, workspace: join(dir, 'workspace'), stateDirectory: join(dir, 'state') }));
    let health = await ensureLocal(options());
    assert.equal(health.build, VERSION);
    const moved = JSON.parse(readFileSync(configPath, 'utf8')).port;
    assert.notEqual(moved, busy, 'moved to a free port');
    assert.equal((await probeLocal('http://127.0.0.1:' + moved, token, BUILD_ID)).kind, 'ours');

    // Connecting again reuses the running backend; a restart replaces the process.
    assert.equal((await ensureLocal(options())).pid, health.pid);
    const restarted = await ensureLocal(options({ restart: true }));
    assert.notEqual(restarted.pid, health.pid);
    health = restarted;

    // A user-chosen configuration does not move; it reports the conflict.
    const userConfig = join(dir, 'mine.json');
    writeFileSync(userConfig, JSON.stringify({ port: busy, token, workspace: join(dir, 'workspace') }));
    await assert.rejects(ensureLocal({ ...options(), configPath: userConfig, managed: false }), /已被另一个后端占用/);
  } finally {
    await stopOurs();
    foreign.close();
  }

  // An older build on the port is shut down and replaced in place.
  const oldPort = await port();
  let stopped = false;
  const old = await listen((request, response) => {
    if (request.url === '/v1/shutdown') { stopped = true; response.end('{}'); old.close(); old.closeAllConnections(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ service: 'coderfleet-node', version: 1, build: '0.0.1' }));
  });
  await new Promise(resolve => old.close(() => resolve()));
  const replaced = await listen((request, response) => {
    if (request.url === '/v1/shutdown') { stopped = true; response.end('{}'); setImmediate(() => { replaced.close(); replaced.closeAllConnections(); }); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ service: 'coderfleet-node', version: 1, build: '0.0.1' }));
  });
  const stalePort = replaced.address().port;
  try {
    writeFileSync(configPath, JSON.stringify({ port: stalePort, token, workspace: join(dir, 'workspace') }));
    const health = await ensureLocal(options());
    assert.ok(stopped, 'the older build was asked to shut down');
    assert.equal(health.build, VERSION);
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).port, stalePort, 'kept its port');
  } finally {
    await stopOurs();
    void oldPort;
    rmSync(dir, { recursive: true, force: true });
  }
});
