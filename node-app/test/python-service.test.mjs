import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findPythonService } from '../dist/python-service.js';

const serve = workspace => new Promise(resolve => {
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/api/health' ? 200 : 404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', workspace }));
  });
  server.listen(0, '127.0.0.1', () => resolve(server));
});

test('the Python service is reported only when it serves this workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coderfleet-python-'));
  const other = mkdtempSync(join(tmpdir(), 'coderfleet-python-other-'));
  const servers = [];
  try {
    assert.equal(await findPythonService(dir), undefined, 'nothing running');

    const same = await serve(dir); servers.push(same);
    writeFileSync(join(dir, 'config.conf'), 'CODERFLEET_PORT=' + same.address().port + '\n');
    assert.deepEqual(await findPythonService(dir), { url: 'http://127.0.0.1:' + same.address().port, pid: undefined });

    const elsewhere = await serve(other); servers.push(elsewhere);
    writeFileSync(join(dir, 'config.conf'), 'CODERFLEET_PORT=' + elsewhere.address().port + '\n');
    assert.equal(await findPythonService(dir), undefined, 'a service on another workspace is not ours');

    // A daemon pid file of a live process counts even when the port does not answer.
    writeFileSync(join(dir, 'server.pid'), String(process.pid));
    assert.deepEqual(await findPythonService(dir), { url: undefined, pid: process.pid });
    writeFileSync(join(dir, 'server.pid'), '999999999');
    assert.equal(await findPythonService(dir), undefined, 'stale pid file');
  } finally {
    for (const server of servers) server.close();
    rmSync(dir, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true });
  }
});
