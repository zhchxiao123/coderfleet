import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { environment, lastTurn, until } from './helpers.mjs';
import { fakeClaude } from './fakes.mjs';

test('Claude turns run through the TypeScript Agent SDK inside the container', { timeout: 120_000 }, async () => {
  const env = await environment({
    accounts: 'NAME=claude-a TYPE=claude\n', projects: project => `NAME=app ACCOUNT=claude-a PATH=${project}\n`,
    containers: { 'claude-app': 'running' }, bins: { claude: fakeClaude },
  });
  try {
    assert.deepEqual((await env.get('projects/app/models')).body.map(item => item.id), ['opus', 'sonnet', 'haiku']);
    const conversation = (await env.post('conversations', { projectId: 'app' })).body.id;
    await env.post('conversations/' + conversation + '/turns', { prompt: 'hello', model: 'opus' });
    let turn = await until(() => lastTurn(env, conversation), value => !['starting', 'running'].includes(value.status), 'first turn');
    assert.equal(turn.status, 'done', turn.error);
    assert.equal(turn.answer, 'echo:hello:opus');
    assert.equal(turn.sessionId, 'claude-session-1');

    // The conversation's time is its latest activity: the turn's finish (as the Python service touches it).
    const summary = (await env.get('conversations')).body.find(item => item.id === conversation);
    assert.ok(turn.finishedAt && summary.updatedAt === turn.finishedAt, summary.updatedAt + ' vs ' + turn.finishedAt);
    assert.equal(summary.status, 'done');

    await env.post('conversations/' + conversation + '/turns', { prompt: 'again' });
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'done', 'resumed turn');
    assert.equal(turn.answer, 'echo:again::resumed=claude-session-1');

    // Tool approval, across a service restart.
    await env.post('conversations/' + conversation + '/turns', { prompt: 'tool' });
    turn = await until(() => lastTurn(env, conversation), value => value.permission, 'permission');
    assert.equal(turn.permission.title, 'Bash');
    assert.match(turn.permission.details, /"command": "ls"/);
    await env.restart();
    assert.equal((await env.post('turns/' + turn.id + '/permission', { id: turn.permission.id, decision: 'allow' })).status, 200);
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'done', 'approved turn');
    assert.equal(turn.answer, 'ran');
    assert.deepEqual(turn.tools.map(tool => [tool.title, tool.status, tool.detail, tool.hasDetail]), [['Bash', 'completed', 'ls', true]]);
    assert.equal(turn.tools[0].output, undefined, 'turn lists stay small');
    const detail = (await env.get('turns/' + turn.id + '/tools/' + encodeURIComponent(turn.tools[0].id))).body;
    assert.deepEqual([detail.input, detail.output, detail.status], [{ command: 'ls' }, 'x', 'completed']);

    await env.post('conversations/' + conversation + '/turns', { prompt: 'tool' });
    turn = await until(() => lastTurn(env, conversation), value => value.permission, 'second permission');
    await env.post('turns/' + turn.id + '/permission', { id: turn.permission.id, decision: 'deny' });
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'done', 'denied turn');
    assert.equal(turn.answer, 'denied:Operator denied this tool');
    assert.deepEqual(turn.tools.map(tool => tool.status), ['denied']);

    // Native question.
    await env.post('conversations/' + conversation + '/turns', { prompt: 'ask' });
    turn = await until(() => lastTurn(env, conversation), value => value.permission?.questions, 'question');
    assert.deepEqual(turn.permission.questions[0].options.map(option => option.label), ['A', 'B']);
    assert.equal((await env.post('turns/' + turn.id + '/permission', { id: turn.permission.id, answers: { 'Pick one?': 'B' } })).status, 200);
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'done', 'answered turn');
    assert.equal(turn.answer, 'answer:{"Pick one?":"B"}');

    // Images go as base64 image blocks; auto mode bypasses permissions.
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
    const upload = (await env.post('projects/app/uploads', { name: 'shot.png', data: png })).body;
    assert.match(upload.path, /^\/workspace\/\.coderfleet-uploads\/[a-f0-9]{16}-shot\.png$/);
    assert.equal((await env.get('projects/app/uploads/' + upload.path.split('/').pop())).body.data, png);
    assert.equal((await env.post('conversations/' + conversation + '/turns', { prompt: 'see', images: ['/workspace/.coderfleet-uploads/../x.png'] })).status, 400);
    await env.post('conversations/' + conversation + '/turns', { prompt: 'see', images: [upload.path] });
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'done', 'image turn');
    assert.equal(turn.answer, 'images:image/png:' + png.length + ':see');
    assert.deepEqual(turn.images, [upload.path]);
    // Any file: a PDF goes as a document block, anything else by its path (Python _input_content).
    const pdf = (await env.post('projects/app/uploads', { name: '设计 稿.pdf', data: Buffer.from('%PDF-1.4').toString('base64') })).body;
    const csv = (await env.post('projects/app/uploads', { name: 'data.csv', data: Buffer.from('a,b\n1,2').toString('base64') })).body;
    assert.match(pdf.path, /^\/workspace\/\.coderfleet-uploads\/[a-f0-9]{16}-设计_稿\.pdf$/);
    const chineseImage = (await env.post('projects/app/uploads', { name: '截图 1.png', data: png })).body;
    assert.equal((await env.get('projects/app/uploads/' + encodeURIComponent(chineseImage.path.split('/').pop()))).body.data, png);
    assert.match(csv.path, /-data\.csv$/);
    await env.post('conversations/' + conversation + '/turns', { prompt: 'files', images: [pdf.path, csv.path] });
    turn = await until(() => lastTurn(env, conversation), value => value.prompt === 'files' && value.status === 'done', 'file turn');
    assert.match(turn.answer, /^images:application\/pdf:\d+:files\[Attached file: \S+-data\.csv\]$/);
    await env.post('conversations/' + conversation + '/turns', { prompt: 'mode' });
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'done', 'manual turn');
    assert.equal(turn.answer, 'mode:acceptEdits');
    await env.post('conversations/' + conversation + '/turns', { prompt: 'mode', auto: true });
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'done', 'auto turn');
    assert.equal(turn.answer, 'mode:bypassPermissions');
    assert.equal(turn.auto, true);

    // A message sent while the turn runs goes into the same run.
    await env.post('conversations/' + conversation + '/turns', { prompt: 'long' });
    turn = await until(() => lastTurn(env, conversation), value => value.answer === 'working' && value.capabilities?.includes('message'), 'long turn');
    const sent = (await env.post('conversations/' + conversation + '/turns', { prompt: 'also this' })).body;
    assert.equal(sent.delivered, 'message');
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'done', 'interjected turn', 400);
    assert.match(turn.answer, /echo:also this/);
    assert.match(turn.answer, /long-done/);
    assert.deepEqual(turn.blocks.filter(block => block.kind === 'user'), [{ kind: 'user', text: 'also this' }]);
    assert.deepEqual((await env.get('conversations/' + conversation + '/follow-ups')).body, []);

    // A newer CLI folds the message into the running turn: the turn still ends.
    await env.post('conversations/' + conversation + '/turns', { prompt: 'fold' });
    turn = await until(() => lastTurn(env, conversation), value => value.answer === 'working' && value.capabilities?.includes('message'), 'folding turn');
    assert.equal((await env.post('conversations/' + conversation + '/turns', { prompt: 'fold this' })).body.delivered, 'message');
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'done', 'folded turn', 400);
    assert.equal(turn.answer, 'working folded:fold this');

    // A tool that returns an image (Read of a picture): the detail panel gets the image from the log.
    await env.post('conversations/' + conversation + '/turns', { prompt: 'readimg' });
    turn = await until(() => lastTurn(env, conversation), value => value.prompt === 'readimg' && value.status === 'done', 'image tool turn');
    const imageTool = (await env.get('turns/' + turn.id + '/tools/img-1')).body;
    assert.deepEqual([imageTool.output, imageTool.images], ['', [{ mime: 'image/png', data: 'iVBORw0KGgo=' }]]);

    // Fork at a finished turn: a new conversation resumes it under a new session ID.
    const source = (await env.post('conversations', { projectId: 'app' })).body.id;
    await env.post('conversations/' + source + '/turns', { prompt: 'forkme' });
    const sourceTurn = await until(() => lastTurn(env, source), value => value.status === 'done', 'source turn');
    const S = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const U = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    assert.equal(sourceTurn.sessionId, S);
    const refused = await env.post('conversations/' + source + '/fork', { turnId: sourceTurn.id });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /找不到这个会话的 Claude 记录/);
    // Claude's own transcript of the session, in the account directory.
    mkdirSync(join(env.workspace, 'accounts', 'claude-a', 'projects', '-workspace'), { recursive: true });
    writeFileSync(join(env.workspace, 'accounts', 'claude-a', 'projects', '-workspace', S + '.jsonl'), JSON.stringify({ type: 'assistant', uuid: U }) + '\n');
    const fork = (await env.post('conversations/' + source + '/fork', { turnId: sourceTurn.id })).body;
    assert.equal(fork.name, 'forkme · 分叉');
    assert.deepEqual([fork.fork.source_session_id, fork.fork.message_uuid, fork.fork.inherited_task_ids], [S, U, [sourceTurn.id]]);
    const listed = (await env.get('conversations')).body.find(item => item.id === fork.id);
    assert.deepEqual(listed.forkedFrom, { conversationId: source, turnId: sourceTurn.id });
    let forkTurns = (await env.get('conversations/' + fork.id + '/turns')).body;
    assert.deepEqual(forkTurns.map(item => [item.id, item.inherited]), [[sourceTurn.id, true]]);
    await env.post('conversations/' + fork.id + '/turns', { prompt: 'branch' });
    turn = await until(() => lastTurn(env, fork.id), value => value.prompt === 'branch' && value.status === 'done', 'fork turn');
    const T = fork.fork.target_session_id;
    assert.equal(turn.answer, 'echo:branch::resumed=' + S + ':forked=' + T + '@' + U);
    assert.equal(turn.sessionId, T);
    await env.post('conversations/' + fork.id + '/turns', { prompt: 'more' });
    turn = await until(() => lastTurn(env, fork.id), value => value.prompt === 'more' && value.status === 'done', 'second fork turn');
    assert.equal(turn.answer, 'echo:more::resumed=' + T, 'later turns continue the fork, not the source');
    // The source is unchanged.
    assert.equal((await lastTurn(env, source)).id, sourceTurn.id);

    // Native interrupt.
    await env.post('conversations/' + conversation + '/turns', { prompt: 'slow' });
    turn = await until(() => lastTurn(env, conversation), value => value.answer === 'working' && value.controlReady, 'slow turn');
    await env.post('turns/' + turn.id + '/cancel');
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'cancelled', 'interrupted turn');
    assert.equal(turn.interrupted, true);

    // A CLI that ignores the interrupt is killed; the turn still stops.
    await env.post('conversations/' + conversation + '/turns', { prompt: 'stubborn' });
    turn = await until(() => lastTurn(env, conversation), value => value.answer === 'working' && value.controlReady, 'stubborn turn');
    await env.post('turns/' + turn.id + '/cancel');
    assert.equal((await lastTurn(env, conversation)).stopping, true);
    turn = await until(() => lastTurn(env, conversation), value => value.status === 'cancelled', 'stopped stubborn turn', 500);
  } finally { await env.close(); }
});
