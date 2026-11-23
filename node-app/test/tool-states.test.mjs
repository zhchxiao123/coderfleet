import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEvent, toolDetail } from '../dist/tasks.js';

const turn = () => ({ id: 't', status: 'running', answer: '', tools: [] });
const system = (subtype, fields) => ({ type: 'system', subtype, task_id: 't', ...fields });
const use = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, isError) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] } });

test('a tool call moves through running, waiting, approved and completed', () => {
  const value = turn();
  applyEvent(value, use('a', 'Bash', { command: 'npm   test' }));
  assert.deepEqual(value.tools, [{ id: 'a', title: 'Bash', status: 'running', detail: 'npm test' }]);
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
