import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { label, nextAfter, parseRule, ruleFromWords } from '../dist/schedules.js';
import { environment, lastTurn, until } from './helpers.mjs';
import { fakeCodex } from './fakes.mjs';

// The service runs in this process: the command line must not block it.
const cli = async (...args) => (await promisify(execFile)(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8' })).stdout;
const setup = () => environment({
  accounts: 'NAME=codex-a TYPE=codex\n', projects: project => `NAME=web ACCOUNT=codex-a PATH=${project}\n`,
  containers: { 'codex-web': 'running' }, bins: { codex: fakeCodex },
});
/** Rewrites the saved schedules the way the clock moving on would. */
const rewrite = (env, change) => {
  const path = join(env.root, 'state', 'schedules.json');
  const file = JSON.parse(readFileSync(path, 'utf8'));
  change(file.schedules);
  writeFileSync(path, JSON.stringify(file));
};
const shown = async (env, id) => (await env.get('schedules/' + id)).body;

test('rules: how they read, how the command line writes them, when they next fall', () => {
  assert.equal(label({ kind: 'daily', time: '09:00' }), '每天 09:00');
  assert.equal(label({ kind: 'weekly', days: [0, 1, 3], time: '03:00' }), '每周一、三、日 03:00');
  assert.equal(label({ kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '03:00' }), '每天 03:00');
  assert.equal(label({ kind: 'every', hours: 6 }), '每隔 6 小时');
  assert.deepEqual(parseRule({ kind: 'daily', time: '9:05' }), { kind: 'daily', time: '09:05' });
  assert.deepEqual(parseRule({ kind: 'weekly', days: [3, 1, 3], time: '03:00' }), { kind: 'weekly', days: [1, 3], time: '03:00' });
  for (const bad of [{ kind: 'daily', time: '25:00' }, { kind: 'weekly', days: [], time: '03:00' }, { kind: 'weekly', days: [7], time: '03:00' },
    { kind: 'every', hours: 0 }, { kind: 'every', hours: 1.5 }, { kind: 'cron' }, null]) assert.throws(() => parseRule(bad));
  assert.deepEqual(ruleFromWords(['daily', '09:00', 'do', 'it']), { rule: { kind: 'daily', time: '09:00' }, used: 2 });
  // On the command line 1 is Monday and 7 is Sunday.
  assert.deepEqual(ruleFromWords(['weekly', '1,7', '03:00', 'x']), { rule: { kind: 'weekly', days: [0, 1], time: '03:00' }, used: 3 });
  assert.deepEqual(ruleFromWords(['every', '6h', 'x']), { rule: { kind: 'every', hours: 6 }, used: 2 });
  assert.throws(() => ruleFromWords(['weekly', '0', '03:00']));
  assert.throws(() => ruleFromWords(['hourly']));

  const wednesday = new Date(2026, 10, 25, 10, 0); // 2026-11-25 is a Wednesday
  assert.deepEqual(nextAfter({ kind: 'daily', time: '09:00' }, wednesday), new Date(2026, 10, 26, 9, 0));
  assert.deepEqual(nextAfter({ kind: 'daily', time: '10:30' }, wednesday), new Date(2026, 10, 25, 10, 30));
  assert.deepEqual(nextAfter({ kind: 'weekly', days: [1], time: '03:00' }, wednesday), new Date(2026, 10, 30, 3, 0));
  // The same weekday, time already past: a week later.
  assert.deepEqual(nextAfter({ kind: 'weekly', days: [3], time: '09:00' }, wednesday), new Date(2026, 11, 2, 9, 0));
  assert.deepEqual(nextAfter({ kind: 'every', hours: 6 }, wednesday), new Date(2026, 10, 25, 16, 0));
});

test('a schedule starts a new conversation by itself, on request and by the clock', { timeout: 120_000 }, async () => {
  const env = await setup();
  try {
    assert.deepEqual((await env.get('schedules')).body, []);
    assert.equal((await env.post('schedules', { projectId: 'web', prompt: 'x' })).status, 400);
    assert.equal((await env.post('schedules', { projectId: 'nope', prompt: 'x', rule: { kind: 'daily', time: '09:00' } })).status, 404);
    assert.equal((await env.post('schedules', { projectId: 'web', prompt: 'x', rule: { kind: 'daily', time: '9am' } })).status, 400);
    const preview = (await env.post('schedules/preview', { rule: { kind: 'weekly', days: [1, 3], time: '03:00' } })).body;
    assert.equal(preview.label, '每周一、三 03:00');
    assert.ok(Date.parse(preview.nextAt) > Date.now());

    const created = (await env.post('schedules', { projectId: 'web', prompt: 'look around', rule: { kind: 'daily', time: '09:00' } })).body;
    assert.equal(created.label, '每天 09:00');
    assert.equal(created.enabled, true);
    assert.equal(created.last, null);
    assert.ok(Date.parse(created.nextAt) > Date.now());

    // 立即跑一次: a new conversation whose turn uses its tools without asking; the next time stays.
    const run = (await env.post('schedules/' + created.id + '/run')).body;
    let turn = await until(() => lastTurn(env, run.conversationId), value => value?.status === 'done', 'manual run');
    assert.match(turn.answer, /^echo:look around:.*--sandbox danger-full-access/);
    let detail = await shown(env, created.id);
    assert.equal(detail.nextAt, created.nextAt);
    assert.deepEqual(detail.runs.map(item => [item.result, item.manual, item.conversationId, item.status]), [['started', true, run.conversationId, 'done']]);
    // The conversation says which schedule opened it.
    assert.equal((await env.get('conversations')).body.find(item => item.id === run.conversationId).schedule, '每天 09:00');

    // The clock reaches it (the service was off at the time: the latest one is made up).
    rewrite(env, list => { list[0].nextAt = new Date(Date.now() - 3 * 3600_000).toISOString(); });
    await env.restart();
    detail = await until(() => shown(env, created.id), value => value.runs.length === 2 && value.runs[0].result === 'started', 'clock run');
    assert.equal(detail.runs[0].manual, undefined);
    assert.notEqual(detail.runs[0].conversationId, run.conversationId);
    assert.ok(Date.parse(detail.nextAt) > Date.now());
    turn = await until(() => lastTurn(env, detail.runs[0].conversationId), value => value?.status === 'done', 'clock turn');
    assert.match(turn.answer, /^echo:look around:/);

    // Off: the clock passes it by. On again: counted from now, nothing made up.
    assert.equal((await env.put('schedules/' + created.id, { enabled: false })).body.enabled, false);
    rewrite(env, list => { list[0].nextAt = new Date(Date.now() - 3600_000).toISOString(); });
    await env.restart();
    await new Promise(done => setTimeout(done, 600));
    assert.equal((await shown(env, created.id)).runs.length, 2);
    const again = (await env.put('schedules/' + created.id, { enabled: true })).body;
    assert.ok(Date.parse(again.nextAt) > Date.now());
    await new Promise(done => setTimeout(done, 600));
    assert.equal((await shown(env, created.id)).runs.length, 2);

    // More than a day late: not made up.
    await env.put('schedules/' + created.id, { rule: { kind: 'every', hours: 168 } });
    rewrite(env, list => { list[0].nextAt = new Date(Date.now() - 48 * 3600_000).toISOString(); });
    await env.restart();
    detail = await until(() => shown(env, created.id), value => value.runs.length === 3, 'missed run');
    assert.equal(detail.runs[0].result, 'missed');
    assert.ok(Date.parse(detail.nextAt) > Date.now());

    // A run that cannot start says why and leaves no conversation behind.
    const before = (await env.get('conversations')).body.length;
    const broken = (await env.post('schedules', { projectId: 'web', prompt: 'x', rule: { kind: 'daily', time: '09:00' }, job: true })).body;
    const failed = await env.post('schedules/' + broken.id + '/run');
    assert.equal(failed.status, 409);
    assert.match(failed.body.error, /没有跑起来：.*git/);
    assert.equal((await shown(env, broken.id)).runs[0].result, 'failed');
    assert.equal((await env.get('conversations')).body.length, before);

    assert.equal((await env.del('schedules/' + broken.id)).body.removed, true);
    assert.equal((await env.get('schedules/' + broken.id)).status, 404);
    // Deleting the schedule keeps the conversations it opened.
    await env.del('schedules/' + created.id);
    assert.equal((await env.get('conversations')).body.length, before);
  } finally { await env.close(); }
});

test('while the previous run is still going the next one is skipped', { timeout: 120_000 }, async () => {
  const env = await setup();
  try {
    const item = (await env.post('schedules', { projectId: 'web', prompt: 'slow', rule: { kind: 'every', hours: 1 } })).body;
    const run = (await env.post('schedules/' + item.id + '/run')).body;
    await until(() => lastTurn(env, run.conversationId), value => value?.answer === 'working', 'slow run');
    assert.equal((await env.get('schedules')).body[0].busy, true);
    const second = await env.post('schedules/' + item.id + '/run');
    assert.equal(second.status, 409);
    assert.match(second.body.error, /上一次还在做/);

    rewrite(env, list => { list[0].nextAt = new Date(Date.now() - 60_000).toISOString(); });
    await env.restart();
    const detail = await until(() => shown(env, item.id), value => value.runs.length === 2, 'skipped run');
    assert.equal(detail.runs[0].result, 'skipped');
    assert.ok(Date.parse(detail.nextAt) > Date.now());

    const turn = await lastTurn(env, run.conversationId);
    await env.post('turns/' + turn.id + '/cancel');
    await until(() => env.get('schedules'), value => value.body[0].busy === false, 'idle again');
  } finally { await env.close(); }
});

test('the command line manages schedules like the App', { timeout: 120_000 }, async () => {
  const env = await setup();
  try {
    const config = ['--config', join(env.root, 'config.json')];
    assert.equal((await cli('schedule', 'list', ...config)).trim(), '没有定时');
    const added = await cli('schedule', 'add', 'web', 'weekly', '1,3', '03:00', 'tidy', 'up', ...config);
    assert.match(added, /^\w{8}  开  web  每周一、三 03:00  下次 \d\d-\d\d 03:00  tidy up\n$/);
    const id = added.split('  ')[0];
    assert.match(await cli('schedule', 'show', id, ...config), /tidy up\n还没有跑过\n$/);
    assert.match(await cli('schedule', 'off', id, ...config), /  关  web  .*已停用/);
    assert.match(await cli('schedule', 'on', id, ...config), /  开  web  /);
    assert.match(await cli('schedule', 'edit', id, 'rule', 'every', '6', ...config), /每隔 6 小时/);
    assert.match(await cli('schedule', 'edit', id, 'prompt', 'hello', 'there', ...config), /hello there\n$/);
    assert.equal((await env.get('schedules')).body[0].job, false);

    const conversation = (await cli('schedule', 'run', id, ...config)).trim();
    await until(() => lastTurn(env, conversation), value => value?.status === 'done', 'cli run');
    assert.match(await cli('schedule', 'show', id, ...config), new RegExp('\\d\\d-\\d\\d \\d\\d:\\d\\d 手动  做完了  ' + conversation));
    assert.match(await cli('schedule', 'list', ...config), new RegExp('^' + id + '  开  web  每隔 6 小时  '));

    await assert.rejects(cli('schedule', 'add', 'web', 'hourly', 'x', ...config), /时间规则写成/);
    await assert.rejects(cli('schedule', 'show', 'nothere1', ...config), /这个定时不存在/);
    assert.equal((await cli('schedule', 'remove', id, ...config)).trim(), '已删除 ' + id);
    assert.equal((await cli('schedule', 'list', ...config)).trim(), '没有定时');
  } finally { await env.close(); }
});
