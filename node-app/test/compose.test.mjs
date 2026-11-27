import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateCompose } from '../dist/compose.js';

const fixture = fileURLToPath(new URL('./fixtures/compose.expected.json', import.meta.url));

// The expected file is the generated compose data with the temporary root written as <root>.
test('docker-compose generation matches the recorded output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coderfleet-compose-test-'));
  try {
    const workspace = join(root, 'ws');
    const projectA = join(root, 'a'); const projectB = join(root, 'b'); const extra = join(root, 'extra');
    for (const path of [workspace, projectA, projectB, extra, join(workspace, 'projects', 'alpha')]) await mkdir(path, { recursive: true });
    await writeFile(join(workspace, 'config.conf'), 'PROXY_HTTP_PORT=10808\nCONTAINER_TIMEZONE=UTC\nPROXY_BYPASS=example.com,10.0.0.0/8\nDOCKER_SOCKET=off\n');
    await writeFile(join(workspace, 'accounts.conf'), [
      'NAME=claude-a  TYPE=claude  AUTH=login  PROXY=relay',
      'NAME=codex-b  TYPE=codex  PROXY=off',
      'NAME=open-env  TYPE=opencode  AUTH=env  ENV_FILE=./accounts/open-env/env',
      'NAME=local-c  TYPE=claude  RUNTIME=local',
      'NAME=kimi-s  TYPE=kimi',
    ].join('\n') + '\n');
    await writeFile(join(workspace, 'projects.conf'), [
      `NAME=alpha  ACCOUNT=claude-a  PATH=${projectA}  SECONDARY_ACCOUNTS=kimi-s  EXTRA_MOUNTS=${extra}:/data:ro  IDE=on  IDE_PORT=23456  DOCKER_SOCKET=/var/run/docker.sock`,
      `NAME=beta  ACCOUNT=codex-b  PATH=${projectB}  IMAGE=custom:1`,
      `NAME=gamma  ACCOUNT=open-env  PATH=${projectB}`,
      `NAME=delta  ACCOUNT=local-c  PATH=${projectB}`,
      `NAME=off  ACCOUNT=claude-a  PATH=${projectB}  ACTIVE=off`,
    ].join('\n') + '\n');
    await writeFile(join(workspace, 'projects', 'alpha', 'env'), 'FOO=bar\n# comment\nBAZ = qux\n');
    const expected = JSON.parse((await readFile(fixture, 'utf8')).replaceAll('<root>', root));
    const actual = (await generateCompose(workspace, 'docker')).data;
    assert.deepEqual(Object.keys(expected.services).sort(),
      ['claude-project-alpha', 'codex-project-beta', 'ide-project-alpha', 'opencode-project-gamma', 'proxy-relay']);
    assert.deepEqual(actual, expected);

    // A container shared by several accounts carries no account's keys: each turn brings its own account's.
    const projects = await readFile(join(workspace, 'projects.conf'), 'utf8');
    await writeFile(join(workspace, 'projects.conf'), projects.replace('ACCOUNT=open-env', 'ACCOUNT=open-env  SECONDARY_ACCOUNTS=kimi-s'));
    const shared = (await generateCompose(workspace, 'docker')).data.services['opencode-project-gamma'];
    assert.equal(shared.env_file, undefined);
    assert.ok(shared.volumes.includes('./accounts/kimi-s:/home/byclaw/.kimi-code'));
    // One container has one way out: a relay account and a direct one never share it.
    await writeFile(join(workspace, 'projects.conf'), projects.replace('ACCOUNT=codex-b', 'ACCOUNT=codex-b  SECONDARY_ACCOUNTS=kimi-s'));
    await assert.rejects(generateCompose(workspace, 'docker'), /不能放在同一个项目里/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
