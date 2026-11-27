import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { criteriaIn, reviewVerdict } from '../dist/jobs.js';
import { environment, lastTurn, until } from './helpers.mjs';
import { fakeClaude, jobCodex } from './fakes.mjs';

// The service runs in this process: the command line must not block it.
const cli = async (...args) => (await promisify(execFile)(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8' })).stdout;
const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
const jobOf = async (env, conversation) => (await env.get('conversations/' + conversation + '/job')).body.job;
const settled = (env, conversation, state) => until(() => jobOf(env, conversation), job => job?.state === state, 'job ' + state);
const turnsOf = async (env, conversation) => (await env.get('conversations/' + conversation + '/turns')).body;
/** Waits until the conversation has `count` turns, all ended, and returns them. */
const ended = async (env, conversation, count) => (await until(() => env.get('conversations/' + conversation + '/turns'),
  result => result.body.length === count && result.body.every(turn => !['starting', 'running'].includes(turn.status)), count + ' turns')).body;
/** How the author's turn says it was started. */
const started = turn => JSON.parse(turn.answer.split('\n')[0]);
const repository = env => {
  git(env.project, 'init', '-q', '-b', 'main');
  git(env.project, 'config', 'user.email', 'test@example.com');
  git(env.project, 'config', 'user.name', 'Test');
  writeFileSync(join(env.project, 'readme.md'), 'one\n');
  git(env.project, 'add', 'readme.md');
  git(env.project, 'commit', '-q', '-m', 'first');
};

test('criteria are read from the last 标准 block of a reply', () => {
  assert.equal(criteriaIn('没有代码块'), undefined);
  assert.deepEqual(criteriaIn('```标准\n- [ ] 旧的\n```\n后来\n```做完的标准\n- [x] 能登录 —— 测试过了 —— 两次\n* [?] 端口 -- 用哪个\n1. 没标记的\n说明文字\n```\n'), [
    { text: '能登录', state: 'done', note: '测试过了 —— 两次' }, { text: '端口', state: 'ask', note: '用哪个' }, { text: '没标记的', state: 'open', note: '' }]);
  assert.equal(reviewVerdict('```标准\n- [x] a\n```\n结论：通过'), 'pass');
  assert.equal(reviewVerdict('结论：**要改**'), 'changes');
  // A criterion the reviewer left unmet outweighs its verdict line.
  assert.equal(reviewVerdict('```标准\n- [x] a\n- [ ] b —— 没有\n```\n结论：通过'), 'changes');
  assert.equal(reviewVerdict('看过了'), 'unclear');
});

test('a job works in its own worktree until it is accepted or discarded', { timeout: 120_000 }, async () => {
  const env = await environment({
    accounts: 'NAME=codex-a TYPE=codex\n', projects: project => `NAME=web ACCOUNT=codex-a PATH=${project}\n`,
    containers: { 'codex-web': 'running' }, bins: { codex: jobCodex },
  });
  try {
    // Not a git repository yet: the job cannot start, and says why.
    let support = (await env.get('projects/web/job-support')).body;
    assert.equal(support.supported, false);
    assert.match(support.reason, /git/);
    let conversation = (await env.post('conversations', { projectId: 'web' })).body.id;
    let response = await env.post('conversations/' + conversation + '/turns', { prompt: 'write a.txt x', job: true });
    assert.equal(response.status, 409);
    assert.equal(await jobOf(env, conversation), null);

    repository(env);
    support = (await env.get('projects/web/job-support')).body;
    assert.deepEqual(support, { supported: true, reason: '' });

    // The first message opens a worktree and branch; the turn runs there without asking for
    // tools. Its criteria are met, so a fresh session of the same account, told to change nothing, (there
    // is no other) checks them before the user is asked.
    response = await env.post('conversations/' + conversation + '/turns', { prompt: 'Add greeting\nwrite hello.txt hi', job: true });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    let job = await settled(env, conversation, 'review');
    assert.match(job.branch, /^cf\/add-greeting-write-hello-[a-f0-9]{4}$/);
    assert.equal(job.baseBranch, 'main');
    assert.equal(job.dirtyAtStart, false);
    assert.deepEqual(job.criteria, [{ text: '写好了', state: 'done', note: 'hello.txt 里是 hi' }]);
    let turns = await turnsOf(env, conversation);
    assert.deepEqual(turns.map(turn => [turn.role, turn.account, turn.auto, turn.status]), [[undefined, 'codex-a', true, 'done'], ['review', 'codex-a', true, 'done']]);
    assert.equal(turns[0].prompt, 'Add greeting\nwrite hello.txt hi');
    const work = join(env.project, '.coderfleet-work', job.id);
    assert.deepEqual(started(turns[0]), { cwd: work, sandbox: 'danger-full-access', resumed: '', preamble: true, continued: false });
    assert.match(turns[1].answer, /^danger-full-access [\s\S]*结论：通过$/);
    assert.deepEqual([job.review.account, job.review.verdict, job.review.turnId], ['codex-a', 'pass', turns[1].id]);
    assert.equal(readFileSync(join(work, 'hello.txt'), 'utf8'), 'hi\n');
    assert.equal(existsSync(join(env.project, 'hello.txt')), false);
    // Nothing of this shows as a change in the project itself.
    assert.equal(git(env.project, 'status', '--porcelain'), '');
    assert.equal((await env.get('conversations')).body.find(item => item.id === conversation).job, 'review');
    assert.deepEqual((await env.get('conversations/' + conversation + '/job/changes')).body,
      { files: [{ path: 'hello.txt', added: 1, removed: 0, status: 'added' }], added: 1, removed: 0 });

    // Asking for more continues in the same directory and session; a second job cannot start here.
    await env.post('conversations/' + conversation + '/turns', { prompt: 'write readme.md two', job: true });
    turns = await ended(env, conversation, 4);
    job = await settled(env, conversation, 'review');
    assert.deepEqual(started(turns[2]), { cwd: work, sandbox: 'danger-full-access', resumed: 'author-thread', preamble: false, continued: false });
    assert.deepEqual((await env.get('conversations/' + conversation + '/job/changes')).body.files.map(file => [file.path, file.added, file.removed, file.status]),
      [['hello.txt', 1, 0, 'added'], ['readme.md', 1, 1, 'modified']]);

    // The service restarts: the job is still there.
    await env.restart();
    assert.equal((await jobOf(env, conversation)).state, 'review');

    // Accepting is a turn of the agent's: it is told to merge and decides where. The project
    // moved on in a conflicting way, so it merges nothing and asks; the job waits, all kept.
    const config = ['--config', join(env.root, 'config.json')];
    writeFileSync(join(env.project, 'readme.md'), 'other\n');
    git(env.project, 'commit', '-q', '-am', 'conflicting');
    assert.match(await cli('job', 'accept', conversation, ...config), new RegExp(conversation + '  在做[\\s\\S]*已经让它合并'));
    job = await settled(env, conversation, 'waiting');
    assert.deepEqual([job.reason, job.accepting], ['merge', true]);
    assert.match(job.mergeError, /还没有合并进别的分支/);
    turns = await turnsOf(env, conversation);
    assert.deepEqual(turns.map(turn => [turn.role, turn.status]), [[undefined, 'done'], ['review', 'done'], [undefined, 'done'], ['review', 'done'], ['accept', 'done']]);
    assert.match(turns[4].prompt, new RegExp('^我收下[\\s\\S]*' + job.branch.replace('/', '\\/') + '[\\s\\S]*main 分支[\\s\\S]*拿不准就先问我'));
    assert.deepEqual(started(turns[4]), { cwd: work, sandbox: 'danger-full-access', resumed: 'author-thread', preamble: false, continued: false });
    assert.match(turns[4].answer, /有冲突，没有合并/);
    assert.equal(git(env.project, 'status', '--porcelain'), '');
    assert.equal(readFileSync(join(env.project, 'readme.md'), 'utf8'), 'other\n');
    assert.equal(readFileSync(join(work, 'readme.md'), 'utf8'), 'two\n');
    assert.match(git(env.project, 'rev-parse', '--verify', 'refs/heads/' + job.branch), /^[a-f0-9]{40}$/);
    assert.match(await cli('job', 'show', conversation, ...config), /收下了，还没有合并/);
    // It is still open, and the service restarting keeps it so.
    await env.restart();
    assert.deepEqual([(await jobOf(env, conversation)).state, (await jobOf(env, conversation)).reason], ['waiting', 'merge']);

    // The user answers in the conversation; without the conflict it merges, and only once the
    // branch is seen to be in another one are the worktree and branch removed.
    git(env.project, 'reset', '-q', '--hard', 'HEAD~1');
    response = await env.post('conversations/' + conversation + '/turns', { prompt: 'merge' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    job = await settled(env, conversation, 'accepted');
    assert.deepEqual([job.mergedInto, job.mergeError, job.accepting, job.reason], ['main', undefined, undefined, undefined]);
    // No reviewer and no round of checks after the merge.
    assert.deepEqual((await turnsOf(env, conversation)).slice(5).map(turn => [turn.role, turn.prompt]), [[undefined, 'merge']]);
    assert.equal(readFileSync(join(env.project, 'hello.txt'), 'utf8'), 'hi\n');
    assert.equal(readFileSync(join(env.project, 'readme.md'), 'utf8'), 'two\n');
    assert.equal(existsSync(work), false);
    assert.equal(git(env.project, 'branch', '--list', 'cf/*'), '');
    assert.equal(git(env.project, 'status', '--porcelain'), '');
    assert.match(await cli('job', 'show', conversation, ...config), /合并进了 main/);
    // What was merged stays readable, and the closed job cannot be ended again.
    assert.equal((await env.get('conversations/' + conversation + '/job/changes')).body.files.length, 2);
    assert.equal((await env.post('conversations/' + conversation + '/job/discard')).status, 409);
    assert.equal((await env.post('conversations/' + conversation + '/job/accept')).status, 409);
    // The conversation goes on: the same session, back in the project's directory (Codex runs
    // the same way with or without approvals); the first of these turns is told that the worktree is gone.
    let count = (await turnsOf(env, conversation)).length;
    response = await env.post('conversations/' + conversation + '/turns', { prompt: 'more' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    turns = await ended(env, conversation, count + 1);
    assert.deepEqual(started(turns.at(-1)), { cwd: env.project, sandbox: 'danger-full-access', resumed: 'author-thread', preamble: false, continued: false, moved: true });
    await env.post('conversations/' + conversation + '/turns', { prompt: 'and more' });
    turns = await ended(env, conversation, count + 2);
    assert.equal(started(turns.at(-1)).moved, undefined);
    job = await jobOf(env, conversation);
    assert.deepEqual([job.state, job.criteria.length], ['accepted', 1]);
    // And it can start another job: its own worktree, its own criteria; the first one is kept.
    const firstJob = job.id;
    response = await env.post('conversations/' + conversation + '/turns', { prompt: 'write c.txt z', job: true });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    job = await settled(env, conversation, 'review');
    assert.notEqual(job.id, firstJob);
    assert.deepEqual(job.criteria.map(item => item.note), ['c.txt 里是 z']);
    turns = await turnsOf(env, conversation);
    assert.deepEqual(started(turns[count + 2]), { cwd: join(env.project, '.coderfleet-work', job.id), sandbox: 'danger-full-access', resumed: 'author-thread', preamble: true, continued: true });
    assert.equal(turns[count + 3].role, 'review');
    assert.equal(turns.length, count + 4);
    let found = (await env.get('conversations/' + conversation + '/job')).body;
    assert.deepEqual(found.earlier.map(item => [item.id, item.state, item.mergedInto]), [[firstJob, 'accepted', 'main']]);
    assert.match(await cli('job', 'show', conversation, ...config), /已收下[\s\S]*待验收/);
    // The list has one line per conversation: its current job.
    assert.equal((await env.get('jobs')).body.filter(item => item.conversationId === conversation).length, 1);
    // Discarding the second leaves the first's record alone, and the conversation still goes on.
    assert.equal((await env.post('conversations/' + conversation + '/job/discard')).status, 200);
    assert.equal(existsSync(join(env.project, '.coderfleet-work', job.id)), false);
    assert.equal(existsSync(join(env.project, 'c.txt')), false);
    await env.post('conversations/' + conversation + '/turns', { prompt: 'again' });
    turns = await ended(env, conversation, count + 5);
    assert.deepEqual([started(turns.at(-1)).cwd, started(turns.at(-1)).moved], [env.project, true]);
    found = (await env.get('conversations/' + conversation + '/job')).body;
    assert.deepEqual([found.job.state, found.earlier.length], ['discarded', 1]);
    // Deleting the conversation takes all of its job records with it.
    assert.equal((await env.delete('conversations/' + conversation)).status, 200);
    found = (await env.get('conversations/' + conversation + '/job')).body;
    assert.deepEqual([found.job, found.earlier], [null, []]);

    // A conversation already going can become a job: from that message on its session
    // continues in the worktree, and only that message is the task the reviewer is given.
    const going = (await env.post('conversations', { projectId: 'web' })).body.id;
    await env.post('conversations/' + going + '/turns', { prompt: 'hello' });
    turns = await ended(env, going, 1);
    assert.equal(started(turns[0]).cwd, env.project);
    assert.equal(await jobOf(env, going), null);
    // Not while a turn runs.
    await env.post('conversations/' + going + '/turns', { prompt: 'slow' });
    const slow = await until(() => lastTurn(env, going), value => value.status === 'running', 'slow turn');
    response = await env.post('conversations/' + going + '/turns', { prompt: 'write b.txt y', job: true });
    assert.equal(response.status, 409);
    assert.match(response.body.error, /等这一轮结束/);
    assert.equal(await jobOf(env, going), null);
    await env.post('turns/' + slow.id + '/cancel');
    await ended(env, going, 2);
    assert.equal((await cli('job', 'continue', going, 'write', 'b.txt', 'y', '--config', join(env.root, 'config.json'))).trim(), going);
    job = await settled(env, going, 'review');
    turns = await turnsOf(env, going);
    const goingWork = join(env.project, '.coderfleet-work', job.id);
    assert.deepEqual(started(turns[2]), { cwd: goingWork, sandbox: 'danger-full-access', resumed: 'author-thread', preamble: true, continued: true });
    assert.equal(turns[2].prompt, 'write b.txt y');
    assert.match(turns[3].prompt, /^请核对[\s\S]*只读[\s\S]*- \[x\] 写好了 —— b.txt 里是 y[\s\S]*write b.txt y$/);
    assert.doesNotMatch(turns[3].prompt, /hello/);
    assert.equal(readFileSync(join(goingWork, 'b.txt'), 'utf8'), 'y\n');
    // Where it is merged is the agent's call, not the branch the project had checked out: here
    // it goes into another branch, and the job records that one.
    git(env.project, 'branch', 'side');
    response = await env.post('conversations/' + going + '/job/accept');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual([response.body.job.state, response.body.job.accepting], ['working', true]);
    // Not again while it merges.
    assert.equal((await env.post('conversations/' + going + '/job/accept')).status, 409);
    job = await settled(env, going, 'accepted');
    assert.equal(job.mergedInto, 'side');
    assert.equal(git(env.project, 'show', 'side:b.txt'), 'y');
    assert.equal(existsSync(join(env.project, 'b.txt')), false);
    assert.equal(existsSync(goingWork), false);
    assert.equal(git(env.project, 'branch', '--list', 'cf/*'), '');
    git(env.project, 'branch', '-D', 'side');

    // A failed turn leaves the job waiting; discarding removes its directory and branch, the conversation stays.
    writeFileSync(join(env.project, 'scratch.txt'), 'uncommitted\n');
    conversation = (await env.post('conversations', { projectId: 'web' })).body.id;
    await env.post('conversations/' + conversation + '/turns', { prompt: 'fail', job: true });
    job = await settled(env, conversation, 'waiting');
    assert.equal(job.reason, 'failed');
    assert.equal(job.error, 'quota exceeded');
    assert.equal(job.dirtyAtStart, true);
    assert.match(job.branch, /^cf\/fail-/);
    // The command line lists it.
    const listed = await cli('job', 'list', ...config);
    assert.match(listed, new RegExp(conversation + '  等你.*web  ' + job.branch.replace('/', '\\/')));
    assert.match(listed, /已收下/);
    // Deleting the conversation is refused while its job is open.
    assert.equal((await env.delete('conversations/' + conversation)).status, 409);
    // A worktree someone made elsewhere, whose path cannot be seen from here, keeps its registration.
    git(env.project, 'worktree', 'add', '-q', '-b', 'outside', join(env.root, 'outside'));
    rmSync(join(env.root, 'outside'), { recursive: true });
    const shown = await cli('job', 'discard', conversation, ...config);
    assert.match(shown, /已丢弃/);
    assert.match(git(env.project, 'worktree', 'list'), /outside/);
    assert.equal(existsSync(join(env.project, '.coderfleet-work', job.id)), false);
    assert.equal(git(env.project, 'branch', '--list', 'cf/*'), '');
    assert.equal((await env.get('conversations/' + conversation + '/turns')).body.length, 1);
    assert.equal((await env.delete('conversations/' + conversation)).status, 200);
    assert.equal(await jobOf(env, conversation), null);
  } finally { await env.close(); }
});

test('a job goes back to the agent until its criteria are met, and to the user when it cannot decide', { timeout: 120_000 }, async () => {
  const env = await environment({
    accounts: 'NAME=codex-a TYPE=codex\n', projects: project => `NAME=web ACCOUNT=codex-a PATH=${project}\n`,
    containers: { 'codex-web': 'running' }, bins: { codex: jobCodex },
  });
  try {
    repository(env);
    const config = ['--config', join(env.root, 'config.json')];

    // A criterion stays unmet: the agent is sent back twice, then the user is asked.
    let conversation = (await env.post('conversations', { projectId: 'web' })).body.id;
    await env.post('conversations/' + conversation + '/turns', { prompt: 'stall', job: true });
    let job = await settled(env, conversation, 'waiting');
    assert.deepEqual([job.reason, job.round, job.phase, job.review], ['checks', 3, undefined, undefined]);
    assert.deepEqual(job.criteria, [{ text: '开了头', state: 'done', note: '有文件了' }, { text: '没做到', state: 'open', note: '' }]);
    let turns = await turnsOf(env, conversation);
    assert.deepEqual(turns.map(turn => [turn.checkRound, turn.role, turn.status, turn.auto]), [[undefined, undefined, 'done', true], [1, undefined, 'done', true], [2, undefined, 'done', true]]);
    assert.match(turns[1].prompt, /还没有做到（第 1 轮[\s\S]*\n- 没做到\n/);
    assert.doesNotMatch(turns[1].prompt, /开了头/);
    assert.equal(started(turns[1]).preamble, false);
    assert.match(await cli('job', 'show', conversation, ...config), /做完的标准：\n[\s\S]*开了头[\s\S]*没做到[\s\S]*改了几轮，还有标准没做到/);

    // The user says what to do: the count starts again, and met criteria go to the reviewer.
    await env.post('conversations/' + conversation + '/turns', { prompt: 'write state.txt good' });
    turns = await ended(env, conversation, 5);
    job = await settled(env, conversation, 'review');
    assert.deepEqual([job.review.verdict, job.round, job.reason], ['pass', 0, undefined]);
    assert.equal(turns[4].role, 'review');

    // No criteria at all: the agent is asked to list them.
    conversation = (await env.post('conversations', { projectId: 'web' })).body.id;
    await env.post('conversations/' + conversation + '/turns', { prompt: 'just do it', job: true });
    job = await settled(env, conversation, 'review');
    turns = await turnsOf(env, conversation);
    assert.deepEqual(turns.map(turn => [turn.checkRound, turn.role]), [[undefined, undefined], [1, undefined], [undefined, 'review']]);
    assert.match(turns[1].prompt, /没有列出「做完的标准」（第 1 轮/);
    assert.equal(job.round, 1);

    // A criterion only the user can decide: the job waits with the question, unreviewed.
    conversation = (await env.post('conversations', { projectId: 'web' })).body.id;
    await env.post('conversations/' + conversation + '/turns', { prompt: 'ask', job: true });
    job = await settled(env, conversation, 'waiting');
    assert.equal(job.reason, 'question');
    assert.deepEqual(job.criteria, [{ text: '用哪个端口', state: 'ask', note: '8080 还是 8765？' }]);
    assert.equal((await turnsOf(env, conversation)).length, 1);
    assert.match(await cli('job', 'show', conversation, ...config), /\? 用哪个端口[\s\S]*有标准要你来定/);
    assert.equal((await env.get('conversations')).body.find(item => item.id === conversation).job, 'waiting');
    await env.post('conversations/' + conversation + '/turns', { prompt: 'write port.txt 8765' });
    await ended(env, conversation, 3);
    job = await settled(env, conversation, 'review');
    assert.equal(job.review.verdict, 'pass');
  } finally { await env.close(); }
});

test('a job is checked on its own account and container, even with others on the directory', { timeout: 120_000 }, async () => {
  const env = await environment({
    accounts: 'NAME=codex-a TYPE=codex\nNAME=codex-b TYPE=codex\n',
    projects: project => `NAME=web ACCOUNT=codex-a PATH=${project}\nNAME=web-same ACCOUNT=codex-a PATH=${project}\nNAME=web-review ACCOUNT=codex-b PATH=${project}\n`,
    containers: { 'codex-web': 'running', 'codex-web-review': 'exited', 'codex-web-same': 'exited' }, bins: { codex: jobCodex },
  });
  try {
    repository(env);
    const conversation = (await env.post('conversations', { projectId: 'web' })).body.id;
    await env.post('conversations/' + conversation + '/turns', { prompt: 'write state.txt bad', job: true });
    let job = await settled(env, conversation, 'review');
    // Other accounts and projects on this directory are not used: the conversation's own account
    // reviews, in a fresh session (Codex has no sub-agent). It wanted changes once; the author got
    // them, and the second review passed.
    let turns = await turnsOf(env, conversation);
    assert.deepEqual(turns.map(turn => [turn.role, turn.account, turn.projectId, turn.status]), [
      [undefined, 'codex-a', 'web', 'done'], ['review', 'codex-a', 'web', 'done'],
      ['review-feedback', 'codex-a', 'web', 'done'], ['review', 'codex-a', 'web', 'done']]);
    // No other container was started or used for it.
    assert.deepEqual(JSON.parse(readFileSync(join(env.root, 'containers.json'), 'utf8')), { 'codex-web': 'running', 'codex-web-review': 'exited', 'codex-web-same': 'exited' });
    assert.equal(readFileSync(join(env.root, 'docker.log'), 'utf8').split('\n').filter(line => /codex-web-(review|same)/.test(line)).length, 0);
    assert.doesNotMatch(turns[1].prompt, /子 agent/);
    assert.match(turns[1].prompt, /^请核对[\s\S]*只读[\s\S]*- \[x\] 写好了 —— state.txt 里是 bad[\s\S]*write state.txt bad$/);
    assert.match(turns[1].answer, /^danger-full-access [\s\S]*结论：要改$/);
    assert.match(turns[2].prompt, /独立的复审人核对了你的改动[\s\S]*state.txt 第 1 行应该是 good/);
    // The reviewer's session is its own (it resumed nothing); the author keeps resuming its own.
    assert.doesNotMatch(turns[1].answer, /resumed=/);
    assert.deepEqual(started(turns[2]), { cwd: join(env.project, '.coderfleet-work', job.id), sandbox: 'danger-full-access', resumed: 'author-thread', preamble: false, continued: false });
    assert.deepEqual([job.review.account, job.review.verdict, job.review.turnId, job.round, job.phase], ['codex-a', 'pass', turns[3].id, 1, undefined]);
    assert.match(await cli('job', 'show', conversation, '--config', join(env.root, 'config.json')), /审查：通过/);

    // What the user asks for next is checked again, and counts its rounds from zero.
    writeFileSync(join(env.project, '.coderfleet-work', job.id, 'state.txt'), 'bad\n');
    await env.post('conversations/' + conversation + '/turns', { prompt: 'hello' });
    turns = await ended(env, conversation, 8);
    job = await settled(env, conversation, 'review');
    assert.deepEqual([job.review.verdict, job.round], ['pass', 1]);
    assert.deepEqual(turns.slice(4).map(turn => turn.role), [undefined, 'review', 'review-feedback', 'review']);
  } finally { await env.close(); }
});

test('Claude checks a job in its own session, through a sub-agent', { timeout: 120_000 }, async () => {
  const env = await environment({
    accounts: 'NAME=claude-a TYPE=claude\nNAME=claude-b TYPE=claude\n',
    projects: project => `NAME=app ACCOUNT=claude-a PATH=${project}\nNAME=app-b ACCOUNT=claude-b PATH=${project}\n`,
    containers: { 'claude-app': 'running', 'claude-app-b': 'exited' }, bins: { claude: fakeClaude },
  });
  try {
    repository(env);
    const conversation = (await env.post('conversations', { projectId: 'app' })).body.id;
    await env.post('conversations/' + conversation + '/turns', { prompt: 'job-done', job: true });
    const job = await settled(env, conversation, 'review');
    const turns = await ended(env, conversation, 2);
    assert.deepEqual(turns.map(turn => [turn.role, turn.account, turn.projectId, turn.sessionId]), [
      [undefined, 'claude-a', 'app', 'claude-session-1'], ['review', 'claude-a', 'app', 'claude-session-1']]);
    // The author's session is resumed, and the review handed to a sub-agent with the whole request.
    assert.match(turns[1].answer, /^resume:claude-session-1$/m);
    assert.match(turns[1].prompt, /^请核对你在[\s\S]*Task 工具[\s\S]*----\n请核对另一个 AI[\s\S]*独立复审人[\s\S]*结论：通过[\s\S]*- \[x\] 写好了 —— 加了 a.txt[\s\S]*----$/);
    assert.deepEqual(turns[1].tools.map(tool => [tool.id, tool.parent]), [['review-agent', undefined], ['v1', 'review-agent']]);
    // Read-only still forbids editing files, and leaves the sub-agent's tool alone.
    const disallowed = /^disallowed:(.*)$/m.exec(turns[1].answer)[1];
    assert.match(disallowed, /Edit/);
    assert.doesNotMatch(disallowed, /Task|Agent/);
    assert.deepEqual([job.review.account, job.review.verdict, job.review.turnId], ['claude-a', 'pass', turns[1].id]);
    assert.equal(JSON.parse(readFileSync(join(env.root, 'containers.json'), 'utf8'))['claude-app-b'], 'exited');
  } finally { await env.close(); }
});
