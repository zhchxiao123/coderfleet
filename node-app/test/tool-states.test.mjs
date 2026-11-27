import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEvent, toolDetail } from '../dist/tasks.js';
import { toolOutput } from '../dist/acp-worker.js';

const turn = () => ({ id: 't', status: 'running', answer: '', tools: [] });
const system = (subtype, fields) => ({ type: 'system', subtype, task_id: 't', ...fields });
const use = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, isError) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] } });

test('a tool call moves through running, waiting, approved and completed', () => {
  const value = turn();
  applyEvent(value, use('a', 'Bash', { command: 'npm   test' }));
  assert.deepEqual(value.tools, [{ id: 'a', title: 'Bash', status: 'running', detail: 'npm test', input: { command: 'npm   test' } }]);
  applyEvent(value, system('coderfleet_permission_pending', { tool_call_id: 'a', tool_name: 'Bash', tool_input: {} }));
  assert.equal(value.tools[0].status, 'waiting');
  applyEvent(value, system('coderfleet_permission_closed', { tool_call_id: 'a', status: 'approved' }));
  assert.equal(value.tools[0].status, 'running');
  assert.equal(value.permission, undefined);
  applyEvent(value, result('a', false));
  assert.equal(value.tools[0].status, 'completed');
});

test('a rejected call stays denied after its error result; a failing call is failed', () => {
  const value = turn();
  // Approval before the tool call (Claude) and a separate tool ID (Antigravity).
  applyEvent(value, system('coderfleet_permission_pending', { tool_call_id: 'key', tool_use_id: 'b', tool_name: 'Edit' }));
  applyEvent(value, use('b', 'Edit', { file_path: '/workspace/a.ts' }));
  assert.equal(value.tools[0].status, 'waiting');
  applyEvent(value, system('coderfleet_permission_closed', { tool_call_id: 'key', status: 'denied' }));
  applyEvent(value, result('b', true));
  assert.equal(value.tools[0].status, 'denied');
  applyEvent(value, use('c', 'Bash', { command: 'false' }));
  applyEvent(value, result('c', true));
  assert.deepEqual(value.tools.map(tool => tool.status), ['denied', 'failed']);
});

test('tool details summarize the input', () => {
  assert.equal(toolDetail({ file_path: '/workspace/src/a.ts', content: 'x' }), '/workspace/src/a.ts');
  assert.equal(toolDetail({ command: ['bash', '-lc', 'ls'] }), 'bash -lc ls');
  assert.equal(toolDetail({ changes: [{ path: 'a.ts' }, { path: 'b.ts' }] }), 'a.ts, b.ts');
  assert.equal(toolDetail({ other: 1 }), '');
});

test('steps of a sub-agent belong to its Agent call, and its text is not the answer', () => {
  const value = turn();
  applyEvent(value, use('agent-1', 'Agent', { description: 'Review the diff' }));
  const inner = (event, parent = 'agent-1') => ({ ...event, parent_tool_use_id: parent });
  applyEvent(value, inner({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'sub-agent thinking' } } }));
  applyEvent(value, inner(use('b1', 'Bash', { command: 'git diff' })));
  applyEvent(value, inner(result('b1', false)));
  applyEvent(value, result('agent-1', false));
  assert.deepEqual(value.tools.map(tool => [tool.id, tool.parent, tool.status]), [['agent-1', undefined, 'completed'], ['b1', 'agent-1', 'completed']]);
  assert.deepEqual(value.blocks, [{ kind: 'tool', id: 'agent-1' }]);
  assert.equal(value.answer, '');
});

test('text and tool calls keep the order they happened in', () => {
  const value = turn();
  const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  applyEvent(value, delta('Checking '));
  applyEvent(value, delta('first.'));
  applyEvent(value, use('a', 'Bash', { command: 'npm test' }));
  applyEvent(value, delta('Now building.'));
  applyEvent(value, use('b', 'Bash', { command: 'npm run build' }));
  assert.deepEqual(value.blocks, [
    { kind: 'text', text: 'Checking first.' }, { kind: 'tool', id: 'a' },
    { kind: 'text', text: 'Now building.' }, { kind: 'tool', id: 'b' },
  ]);
  assert.equal(value.answer, 'Checking first.Now building.');
});

test('a tool call keeps its input and output for the detail panel', () => {
  const value = turn();
  applyEvent(value, use('a', 'Bash', { command: 'ls' }));
  applyEvent(value, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'a.ts\nb.ts' }] }] } });
  assert.deepEqual(value.tools[0].input, { command: 'ls' });
  assert.equal(value.tools[0].output, 'a.ts\nb.ts');
  applyEvent(value, use('b', 'Read', { file_path: 'big' }));
  applyEvent(value, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'x'.repeat(200_000) }] } });
  assert.ok(value.tools[1].output.length < 70_000, 'long output is capped');
});

// The shapes are the ones `agy acp` 1.5.15 sends.
test('an ACP tool reports its text, and says so when the agent passed no result on', () => {
  const text = 'Command exited with code 0.\n\nCommand output:\nhello\r\n';
  assert.equal(toolOutput({ status: 'completed', rawOutput: { output: text, exit_code: 0 }, content: [{ type: 'content', content: { type: 'text', text } }] }), text);
  assert.equal(toolOutput({ status: 'completed', rawOutput: { output: text, exit_code: 0 } }), text);
  assert.equal(toolOutput({ status: 'completed', rawOutput: '' }), '');
  assert.equal(toolOutput({ status: 'completed', rawOutput: { matches: 2 } }), '{"matches":2}');
  // Web search and file reads end with no output at all.
  assert.equal(toolOutput({ status: 'completed', kind: 'search', rawInput: { query: 'x' } }), undefined);

  const value = turn();
  applyEvent(value, use('s', '"x" on Web', { query: 'x' }));
  applyEvent(value, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's', content: '', is_error: false, output_unreported: true }] } });
  assert.equal(value.tools[0].outputUnreported, true);
  assert.equal(value.tools[0].output, undefined);
  applyEvent(value, use('e', 'true', { CommandLine: 'true' }));
  applyEvent(value, result('e', false));
  assert.equal(value.tools[1].outputUnreported, undefined);
});
