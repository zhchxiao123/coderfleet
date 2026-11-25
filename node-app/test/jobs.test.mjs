import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { criteriaIn, reviewVerdict } from '../dist/jobs.js';
import { environment, lastTurn, until } from './helpers.mjs';

// A Codex for both sides of a job, working in the directory it was started for.
// As the author it does what the last line of its prompt says and answers with a line of JSON
// about how it was started, then its criteria: `write <file> <text>` (met), `stall` (never
// met), `ask` (the user has to decide), `fail`, anything else (no criteria). Told that it
// listed none it lists one, met; handed a review it writes "good" to state.txt.
// As the reviewer it wants changes while state.txt exists and does not say "good".
const jobCodex = `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const cwd = args[args.indexOf('--cd') + 1];
const sandbox = args[args.indexOf('--sandbox') + 1];
const resumed = args.includes('resume') ? args[args.indexOf('resume') + 1] : '';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const block = (...lines) => ['\`\`\`标准', ...lines, '\`\`\`'].join('\\n');
let prompt = '';
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  prompt = prompt.trim();
  const reviewing = prompt.startsWith('请核对');
  send({ type: 'thread.started', thread_id: reviewing ? 'review-thread' : resumed || 'author-thread' });
  send({ type: 'turn.started' });
  const [verb, file, ...rest] = prompt.split('\\n').at(-1).split(' ');
  let text;
  if (reviewing) {
    const state = join(cwd, 'state.txt');
    const bad = existsSync(state) && !readFileSync(state, 'utf8').includes('good');
    text = sandbox + ' ' + (bad ? block('- [ ] 写好了 —— state.txt 第 1 行应该是 good') + '\\n结论：要改' : block('- [x] 写好了 —— 看过了') + '\\n结论：通过');
  } else {
    if (verb === 'fail') { send({ type: 'turn.failed', error: { message: 'quota exceeded' } }); process.exit(1); }
    if (verb === 'slow') { process.on('SIGINT', () => process.exit(130)); setInterval(() => undefined, 1000); return; }
    let criteria = '';
    if (prompt.includes('核对了你的改动')) { writeFileSync(join(cwd, 'state.txt'), 'good\\n'); criteria = block('- [x] 写好了 —— 改成 good 了'); }
    else if (prompt.includes('没有列出')) criteria = block('- [x] 写好了 —— 补上了');
    else if (prompt.includes('还没有做到') || verb === 'stall') criteria = block('- [x] 开了头 —— 有文件了', '- [ ] 没做到');
    else if (verb === 'ask') criteria = block('- [?] 用哪个端口 —— 8080 还是 8765？');
    else if (verb === 'write') { writeFileSync(join(cwd, file), rest.join(' ') + '\\n'); criteria = block('- [x] 写好了 —— ' + file + ' 里是 ' + rest.join(' ')); }
    text = JSON.stringify({ cwd, sandbox, resumed, preamble: prompt.includes('独立的工作目录'), continued: prompt.includes('从现在起') }) + '\\n' + criteria;
  }
  send({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text } });
  send({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
});
`;

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
    // tools. Its criteria are met, so a fresh read-only session of the same account (there
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
    assert.match(turns[1].answer, /^read-only [\s\S]*结论：通过$/);
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

    // The project moved on in a conflicting way: accepting merges nothing and leaves it as it was.
    writeFileSync(join(env.project, 'readme.md'), 'other\n');
    git(env.project, 'commit', '-q', '-am', 'conflicting');
    response = await env.post('conversations/' + conversation + '/job/accept');
    assert.equal(response.status, 409);
    assert.match(response.body.error, /冲突/);
    job = await jobOf(env, conversation);
    assert.equal(job.state, 'review');
    assert.match(job.mergeError, /冲突/);
    assert.equal(git(env.project, 'status', '--porcelain'), '');
    assert.equal(readFileSync(join(env.project, 'readme.md'), 'utf8'), 'other\n');

    // Without the conflict it merges into the checked-out branch; worktree and branch are removed.
    git(env.project, 'reset', '-q', '--hard', 'HEAD~1');
    response = await env.post('conversations/' + conversation + '/job/accept');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.job.state, 'accepted');
    assert.equal(response.body.job.mergeError, undefined);
    assert.equal(readFileSync(join(env.project, 'hello.txt'), 'utf8'), 'hi\n');
    assert.equal(readFileSync(join(env.project, 'readme.md'), 'utf8'), 'two\n');
    assert.equal(existsSync(work), false);
    assert.equal(git(env.project, 'branch', '--list', 'cf/*'), '');
    assert.equal(git(env.project, 'status', '--porcelain'), '');
    assert.equal(git(env.project, 'log', '-1', '--format=%s'), 'Add greeting write hello.txt hi');
    // What was merged stays readable; the conversation takes no more messages.
    assert.equal((await env.get('conversations/' + conversation + '/job/changes')).body.files.length, 2);
    response = await env.post('conversations/' + conversation + '/turns', { prompt: 'more' });
    assert.equal(response.status, 409);
    assert.match(response.body.error, /新对话/);
    assert.equal((await env.post('conversations/' + conversation + '/job/discard')).status, 409);

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
    assert.match(await cli('job', 'discard', going, '--config', join(env.root, 'config.json')), /已丢弃/);
    assert.equal(existsSync(goingWork), false);

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
    const config = ['--config', join(env.root, 'config.json')];
    const listed = await cli('job', 'list', ...config);
    assert.match(listed, new RegExp(conversation + '  等你.*web  ' + job.branch.replace('/', '\\/')));
    assert.match(listed, /已收下/);
    // Deleting the conversation is refused while its job is open.
    assert.equal((await env.delete('conversations/' + conversation)).status, 409);
    const shown = await cli('job', 'discard', conversation, ...config);
    assert.match(shown, /已丢弃/);
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

test('another account checks a job before the user does', { timeout: 120_000 }, async () => {
  const env = await environment({
    accounts: 'NAME=codex-a TYPE=codex\nNAME=codex-b TYPE=codex\n',
    projects: project => `NAME=web ACCOUNT=codex-a PATH=${project}\nNAME=web-same ACCOUNT=codex-a PATH=${project}\nNAME=web-review ACCOUNT=codex-b PATH=${project}\n`,
    containers: { 'codex-web': 'running', 'codex-web-review': 'running', 'codex-web-same': 'running' }, bins: { codex: jobCodex },
  });
  try {
    repository(env);
    const conversation = (await env.post('conversations', { projectId: 'web' })).body.id;
    await env.post('conversations/' + conversation + '/turns', { prompt: 'write state.txt bad', job: true });
    let job = await settled(env, conversation, 'review');
    // The other account's project on this directory reviewed, not the same account's second
    // one. It wanted changes once; the author got them, and the second review passed.
    let turns = await turnsOf(env, conversation);
    assert.deepEqual(turns.map(turn => [turn.role, turn.account, turn.projectId, turn.status]), [
      [undefined, 'codex-a', 'web', 'done'], ['review', 'codex-b', 'web-review', 'done'],
      ['review-feedback', 'codex-a', 'web', 'done'], ['review', 'codex-b', 'web-review', 'done']]);
    assert.match(turns[1].prompt, /^请核对[\s\S]*只读[\s\S]*- \[x\] 写好了 —— state.txt 里是 bad[\s\S]*write state.txt bad$/);
    assert.match(turns[1].answer, /^read-only [\s\S]*结论：要改$/);
    assert.match(turns[2].prompt, /codex-b[\s\S]*核对了你的改动[\s\S]*state.txt 第 1 行应该是 good/);
    // The author keeps its own session: the reviewer's is never resumed.
    assert.deepEqual(started(turns[2]), { cwd: join(env.project, '.coderfleet-work', job.id), sandbox: 'danger-full-access', resumed: 'author-thread', preamble: false, continued: false });
    assert.deepEqual([job.review.account, job.review.verdict, job.review.turnId, job.round, job.phase], ['codex-b', 'pass', turns[3].id, 1, undefined]);
    assert.match(await cli('job', 'show', conversation, '--config', join(env.root, 'config.json')), /codex-b[\s\S]*通过/);

    // What the user asks for next is checked again, and counts its rounds from zero.
    writeFileSync(join(env.project, '.coderfleet-work', job.id, 'state.txt'), 'bad\n');
    await env.post('conversations/' + conversation + '/turns', { prompt: 'hello' });
    turns = await ended(env, conversation, 8);
    job = await settled(env, conversation, 'review');
    assert.deepEqual([job.review.verdict, job.round], ['pass', 1]);
    assert.deepEqual(turns.slice(4).map(turn => turn.role), [undefined, 'review', 'review-feedback', 'review']);
  } finally { await env.close(); }
});
