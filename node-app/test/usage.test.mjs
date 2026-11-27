import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { environment, until } from './helpers.mjs';

const response = (status, body) => JSON.stringify({ status, body: JSON.stringify(body) });
const probes = env => !existsSync(join(env.root, 'docker.log')) ? 0 : readFileSync(join(env.root, 'docker.log'), 'utf8').split('\n').filter(line => line.includes('"python3"')).length;

test('subscription usage is asked from the account\'s own container', async () => {
  const env = await environment();
  try {
    await env.post('workspace/init');
    await env.post('accounts', { name: 'claude-a', type: 'claude' });
    await env.post('accounts', { name: 'codex-a', type: 'codex' });
    await env.post('accounts', { name: 'claude-api', type: 'claude', auth: 'env', env: { ANTHROPIC_API_KEY: 'sk-test' } });
    const usage = async name => (await env.get('accounts')).body.find(item => item.name === name).usage;
    assert.deepEqual([await usage('claude-a'), await usage('claude-api')], [{}, null]);
    assert.equal((await env.post('accounts/claude-api/usage')).status, 400);

    // No running container: nothing is asked, from anywhere.
    assert.equal((await env.post('accounts/claude-a/usage')).status, 409);
    assert.equal(probes(env), 0);

    for (const [name, account] of [['app', 'claude-a'], ['tool', 'codex-a']]) {
      const created = await env.post('projects', { name, account, path: env.project });
      await until(() => env.get('operations/' + created.body.operation.id), value => value.body.status !== 'running', 'start ' + name);
    }
    process.env.FAKE_USAGE = '{"plan": "max"}\n' + response(200, {
      five_hour: { utilization: 42.5, resets_at: '2026-11-24T20:00:00+00:00' }, seven_day: { utilization: 18, resets_at: '2026-11-28T00:00:00+00:00' },
    });
    const claude = await env.post('accounts/claude-a/usage');
    assert.deepEqual([claude.status, claude.body.fiveHour, claude.body.sevenDay.used, claude.body.plan, claude.body.error],
      [200, { used: 42.5, resetsAt: '2026-11-24T20:00:00+00:00' }, 18, 'max', '']);
    // Stored in the Python service's file and format, so both services share one probe.
    const cache = JSON.parse(readFileSync(join(env.workspace, 'accounts', 'claude-a', 'usage-cache.json'), 'utf8'));
    assert.deepEqual([cache.five_hour.utilization, cache.seven_day.resets_at, cache.subscription_type, cache.error], [42.5, '2026-11-28T00:00:00+00:00', 'max', '']);
    assert.equal((await usage('claude-a')).fiveHour.used, 42.5);

    process.env.FAKE_USAGE_CODEX = response(200, { plan_type: 'pro', rate_limit: { primary_window: { used_percent: 7, reset_at: 1795550400 }, secondary_window: { used_percent: 91, reset_at: 1795900000 } } });
    const codex = (await env.post('accounts/codex-a/usage')).body;
    assert.deepEqual([codex.fiveHour, codex.sevenDay.used, codex.plan], [{ used: 7, resetsAt: new Date(1795550400000).toISOString() }, 91, 'pro']);

    // Antigravity: one pool per model family, from the per-model fractions agy's own endpoint returns.
    await env.post('accounts', { name: 'google-a', type: 'antigravity' });
    const agy = await env.post('projects', { name: 'web', account: 'google-a', path: env.project });
    await until(() => env.get('operations/' + agy.body.operation.id), value => value.body.status !== 'running', 'start web');
    const quota = (remainingFraction, resetTime) => ({ quotaInfo: { remainingFraction, ...(resetTime ? { resetTime } : {}) } });
    process.env.FAKE_USAGE_AGY = '{"plan": "Google AI Pro"}\n' + response(200, { models: {
      'gemini-3-flash': { displayName: 'Gemini 3 Flash', modelProvider: 'MODEL_PROVIDER_GOOGLE', ...quota(0.75, '2026-11-27T12:18:59Z') },
      'gemini-4-hydrogen-sonar': { modelProvider: 'MODEL_PROVIDER_GOOGLE', ...quota(0.75, '2026-11-27T12:18:59Z') },
      'claude-opus-5-5-low': { displayName: 'Claude Opus 5.5 (Low)', modelProvider: 'MODEL_PROVIDER_ANTHROPIC', ...quota(1, '2026-11-27T12:36:30Z') },
      'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B (Medium)', modelProvider: 'MODEL_PROVIDER_OPENAI', ...quota(1, '2026-11-27T12:36:30Z') },
      tab_flash_lite_preview: quota(1),
    } });
    const google = (await env.post('accounts/google-a/usage')).body;
    assert.deepEqual([google.pools, google.plan, google.error], [[
      { id: 'gemini', label: 'Gemini', used: 25, resetsAt: '2026-11-27T12:18:59Z' },
      // Untouched: the reset time it reports is only "five hours from now".
      { id: 'claude', label: 'Claude', used: 0, resetsAt: '' },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', used: 0, resetsAt: '' },
    ], 'Google AI Pro', '']);
    assert.deepEqual((await usage('google-a')).pools, google.pools);
    // Its hourly token ran out: the next turn renews it, and the last numbers stay.
    process.env.FAKE_USAGE_AGY = response(401, {});
    const stale = (await env.post('accounts/google-a/usage')).body;
    assert.deepEqual([stale.error, stale.pools[0].used, stale.plan], ['token_stale', 25, 'Google AI Pro']);

    // A failed probe keeps the last numbers next to the reason; a signed-out account has none.
    process.env.FAKE_USAGE = response(429, {});
    const limited = (await env.post('accounts/claude-a/usage')).body;
    assert.deepEqual([limited.error, limited.fiveHour.used], ['rate_limited', 42.5]);
    process.env.FAKE_USAGE = response(401, {});
    assert.deepEqual((({ error, fiveHour }) => [error, fiveHour])((await env.post('accounts/claude-a/usage')).body), ['unauthorized', undefined]);

    // A relay account's container that could reach the network directly is not used.
    const before = probes(env);
    process.env.FAKE_NETWORK = 'bridge';
    await env.restart();
    assert.equal((await env.post('accounts/claude-a/usage')).status, 409);
    assert.equal(probes(env), before);
  } finally {
    delete process.env.FAKE_USAGE; delete process.env.FAKE_USAGE_CODEX; delete process.env.FAKE_USAGE_AGY;
    await env.close();
  }
});
