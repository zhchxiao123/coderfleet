import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { environment, until } from './helpers.mjs';

const operation = (env, id) => until(() => env.get('operations/' + id), value => value.body.status !== 'running', 'operation ' + id);

test('the App initializes the workspace and manages accounts, projects, containers and the image', async () => {
  const env = await environment();
  try {
    let overview = (await env.get('overview')).body;
    assert.equal(overview.initialized, false);
    assert.equal(overview.docker, '27.0.0');
    assert.ok(overview.accountTypes.some(type => type.id === 'claude' && type.chat));
    assert.equal((await env.post('workspace/init')).status, 200);
    overview = (await env.get('overview')).body;
    assert.equal(overview.initialized, true);
    assert.match(readFileSync(join(env.workspace, 'Dockerfile'), 'utf8'), /agy --version/);
    assert.ok(existsSync(join(env.workspace, 'scripts', 'install_claude_sdk.py')));

    // Settings keep other config.conf content.
    assert.equal((await env.put('settings', { PROXY_HTTP_PORT: '10808' })).body.PROXY_HTTP_PORT, '10808');
    assert.match(readFileSync(join(env.workspace, 'config.conf'), 'utf8'), /^PROXY_HTTP_PORT=10808$/m);
    assert.equal((await env.put('settings', { PROXY_HOST: 'a b' })).status, 400);

    // Image build runs as a background operation; asking again returns the running one.
    process.env.FAKE_BUILD_STEPS = '4';
    const build = (await env.post('image/build')).body;
    assert.equal((await env.post('image/build')).body.id, build.id);
    const listed = await until(() => env.get('operations'), value => value.body[0]?.step, 'build step');
    assert.deepEqual([listed.body[0].id, listed.body[0].status, listed.body[0].output], [build.id, 'running', undefined]);
    assert.equal(listed.body[0].step.total, 4);
    assert.equal((await operation(env, build.id)).body.status, 'succeeded');
    delete process.env.FAKE_BUILD_STEPS;
    assert.match((await env.get('operations/' + build.id)).body.output, /--tag coderfleet:latest/);

    // Accounts.
    assert.equal((await env.post('accounts', { name: 'bad name', type: 'claude' })).status, 400);
    assert.equal((await env.post('accounts', { name: 'codex-env', type: 'codex', auth: 'env' })).status, 400);
    assert.equal((await env.post('accounts', { name: 'claude-a', type: 'claude' })).status, 201);
    assert.equal((await env.post('accounts', { name: 'claude-a', type: 'claude' })).status, 400);
    assert.equal((await env.post('accounts', { name: 'claude-api', type: 'claude', auth: 'env', env: { ANTHROPIC_API_KEY: 'sk-test' } })).status, 201);
    let accounts = (await env.get('accounts')).body;
    assert.deepEqual(accounts.map(item => [item.name, item.auth, item.proxy]), [['claude-a', 'login', 'relay'], ['claude-api', 'env', 'relay']]);
    assert.deepEqual(accounts[1].envKeys, ['ANTHROPIC_API_KEY']);
    assert.ok(!JSON.stringify(accounts).includes('sk-test'));
    const envFile = join(env.workspace, 'accounts', 'claude-api', 'env');
    assert.equal(statSync(envFile).mode & 0o777, 0o600);
    await env.put('accounts/claude-api/env', { values: { ANTHROPIC_BASE_URL: 'https://example.test', ANTHROPIC_API_KEY: '' } });
    assert.equal(readFileSync(envFile, 'utf8'), 'ANTHROPIC_BASE_URL=https://example.test\n');
    assert.equal((await env.post('accounts/claude-api/login')).status, 400);

    // Projects: adding one regenerates docker-compose.yml and starts its container.
    assert.equal((await env.post('projects', { name: 'app', account: 'claude-a', path: '/does/not/exist' })).status, 400);
    const created = await env.post('projects', { name: 'app', account: 'claude-a', path: env.project });
    assert.equal(created.status, 201);
    assert.equal((await operation(env, created.body.operation.id)).body.status, 'succeeded');
    const compose = JSON.parse(readFileSync(join(env.workspace, 'docker-compose.yml'), 'utf8').replace(/^#.*\n/, ''));
    assert.equal(compose.services['claude-project-app'].container_name, 'claude-app');
    assert.ok(compose.services['proxy-relay']);
    let project = (await env.get('projects')).body[0];
    assert.deepEqual([project.name, project.state, project.chat, project.typeLabel], ['app', 'running', true, 'Claude Code']);

    // Project environment variables: projects/<name>/env, owner-only, put into the container on restart.
    assert.deepEqual((await env.get('projects/app/env')).body.vars, {});
    assert.equal((await env.put('projects/app/env', { vars: { '1BAD': 'x' } })).status, 400);
    assert.deepEqual((await env.put('projects/app/env', { vars: { API_TOKEN: ' abc ', EMPTY: '', MODE: 'dev' } })).body.vars, { API_TOKEN: 'abc', MODE: 'dev' });
    const projectEnvFile = join(env.workspace, 'projects', 'app', 'env');
    assert.equal(readFileSync(projectEnvFile, 'utf8'), 'API_TOKEN=abc\nMODE=dev\n');
    assert.equal(statSync(projectEnvFile).mode & 0o777, 0o600);
    assert.equal((await operation(env, (await env.post('projects/app/restart')).body.id)).body.status, 'succeeded');
    const recreated = JSON.parse(readFileSync(join(env.workspace, 'docker-compose.yml'), 'utf8').replace(/^#.*\n/, ''));
    assert.equal(recreated.services['claude-project-app'].environment.MODE, 'dev');
    assert.deepEqual((await env.put('projects/app/env', { vars: { MODE: 'dev' } })).body.vars, { MODE: 'dev' }, 'removed rows are dropped');

    // Extra mounts: EXTRA_MOUNTS in projects.conf, checked when saved, in the container after a restart.
    assert.deepEqual(project.mounts, []);
    const shared = join(env.workspace, 'shared');
    mkdirSync(shared);
    assert.equal((await env.put('projects/app/mounts', { mounts: ['/does/not/exist:/data'] })).status, 400);
    assert.equal((await env.put('projects/app/mounts', { mounts: [shared + ':/workspace'] })).status, 400);
    assert.equal((await env.put('projects/app/mounts', { mounts: [shared + ':relative'] })).status, 400);
    assert.deepEqual((await env.put('projects/app/mounts', { mounts: [shared + ':/data:ro'] })).body.mounts, [shared + ':/data:ro']);
    assert.match(readFileSync(join(env.workspace, 'projects.conf'), 'utf8'), /NAME=app .*EXTRA_MOUNTS=\S+:\/data:ro/);
    assert.deepEqual((await env.get('projects')).body[0].mounts, [shared + ':/data:ro']);
    assert.equal((await operation(env, (await env.post('projects/app/restart')).body.id)).body.status, 'succeeded');
    const mounted = JSON.parse(readFileSync(join(env.workspace, 'docker-compose.yml'), 'utf8').replace(/^#.*\n/, ''));
    assert.ok(mounted.services['claude-project-app'].volumes.includes(shared + ':/data:ro'));
    assert.deepEqual((await env.put('projects/app/mounts', { mounts: [] })).body.mounts, []);
    assert.doesNotMatch(readFileSync(join(env.workspace, 'projects.conf'), 'utf8'), /EXTRA_MOUNTS/);
    assert.equal((await env.del('accounts/claude-a')).status, 400);
    accounts = (await env.get('accounts')).body;
    assert.deepEqual(accounts[0].projects, ['app']);

    // A shell in the running container.
    const terminal = (await env.post('projects/app/terminal', { cols: 90, rows: 20 })).body.terminalId;
    await env.post('terminals/' + terminal + '/input', { data: Buffer.from('echo hi-$((40+2))\nexit\n').toString('base64') });
    let output = '';
    let offset = 0;
    const final = await until(async () => {
      const chunk = (await env.get('terminals/' + terminal + '?offset=' + offset + '&wait=500')).body;
      output += Buffer.from(chunk.data, 'base64').toString();
      offset = chunk.offset;
      return chunk;
    }, chunk => chunk.exited, 'terminal exit');
    assert.match(output, /hi-42/);
    assert.equal(final.exitCode, 0);

    // Stop, disable, remove.
    assert.equal((await operation(env, (await env.post('projects/app/stop')).body.id)).body.status, 'succeeded');
    project = (await env.get('projects')).body[0];
    assert.equal(project.state, 'exited');
    await env.post('projects/app/disable');
    assert.equal((await env.post('projects/app/start')).status, 400);
    await env.post('projects/app/enable');
    const removal = (await env.del('projects/app')).body;
    assert.equal((await operation(env, removal.id)).body.status, 'succeeded');
    assert.deepEqual((await env.get('projects')).body, []);
    assert.equal((await env.del('accounts/claude-a')).status, 200);
    assert.ok(existsSync(join(env.workspace, 'accounts', 'claude-a')));
  } finally { await env.close(); }
});

test('login runs in the running project container', async () => {
  const env = await environment({
    accounts: 'NAME=codex-a TYPE=codex\n', projects: project => `NAME=web ACCOUNT=codex-a PATH=${project}\n`,
    containers: { 'codex-web': 'running' },
    bins: { codex: '#!/usr/bin/env bash\necho "login args: $*"\nread -r code\necho "got $code"\n' },
  });
  try {
    await mkdir(join(env.workspace, 'accounts', 'codex-a'), { recursive: true });
    const terminal = (await env.post('accounts/codex-a/login')).body.terminalId;
    await env.post('terminals/' + terminal + '/input', { data: Buffer.from('ABC-123\n').toString('base64') });
    let output = '';
    let offset = 0;
    await until(async () => {
      const chunk = (await env.get('terminals/' + terminal + '?offset=' + offset + '&wait=500')).body;
      output += Buffer.from(chunk.data, 'base64').toString();
      offset = chunk.offset;
      return chunk;
    }, chunk => chunk.exited, 'login exit');
    assert.match(output, /login args: login --device-auth/);
    assert.match(output, /got ABC-123/);
  } finally { await env.close(); }
});
