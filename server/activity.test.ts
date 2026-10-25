import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callsLabel, countCalls, groupActivity, kindOf } from '../src/components/activity.ts';

const tool = (id, name, kind, summary, status = 'completed', extra = {}) => ({ type: 'tool', id, name, kind, summary, input: '', output: '', status, ...extra });
const bash = (id, command, status) => tool(id, 'Bash', 'shell', command, status);
const read = (id, file) => tool(id, 'Read', 'read', file);
const edit = (id, file) => tool(id, 'Edit', 'edit', file);
const mcp = (id, name) => tool(id, `mcp__cocopilot__${name}`, 'unknown', '{}');
const shape = (items) => items.map((it) => (it.kind === 'tools' ? ['tools', it.label] : it.kind === 'event' ? [it.event.type, it.event.text ?? ''] : [it.kind, it.text]));

test('consecutive tool calls between two messages fold into one row labelled like Paseo', () => {
  const items = groupActivity([bash('1', 'git status'), mcp('2', 'list_works'), { type: 'text', text: 'Two works.' }, read('3', '/acme/widgets/a.ts'), read('4', '/acme/widgets/b.ts'), read('5', '/acme/widgets/a.ts')]);
  assert.deepEqual(shape(items), [['tools', 'Ran 1 command and used 1 other tool'], ['text', 'Two works.'], ['tools', 'Read 2 files']]);
  assert.equal(items[0].calls.length, 2);
});

test('the label counts edited files, commands, reads, searches, other tools and Paseo calls in Paseo order', () => {
  const calls = [edit('1', '/acme/a.ts'), tool('2', 'Write', 'write', '/acme/b.ts'), edit('3', '/acme/a.ts'), bash('4', 'ls'), bash('5', 'npm test'), read('6', '/acme/c.ts'), tool('7', 'Grep', 'search', 'widgets'), tool('8', 'mcp__paseo__list_agents', 'unknown', '{}'), mcp('9', 'get_work')];
  assert.deepEqual(countCalls(calls), { editedFiles: 2, commands: 2, readFiles: 1, searches: 1, otherTools: 1, paseoCalls: 1 });
  assert.equal(callsLabel(countCalls(calls)), 'Edited 2 files, ran 2 commands, read 1 file, searched 1 time, used 1 other tool, and called Paseo 1 time');
  assert.equal(callsLabel(countCalls([edit('1', '/acme/a.ts'), edit('2', '/acme/b.ts')])), 'Edited 2 files');
});

test('thinking is its own row, consecutive thoughts merge, and it splits the tool runs around it', () => {
  const items = groupActivity([{ type: 'think', text: 'weighing' }, { type: 'think', text: 'the widgets' }, bash('1', 'ls'), { type: 'think', text: 'now the API' }, bash('2', 'git log')]);
  assert.deepEqual(shape(items), [['think', 'weighing\n\nthe widgets'], ['tools', 'Ran 1 command'], ['think', 'now the API'], ['tools', 'Ran 1 command']]);
});

test('a running call shows its row in progress while the agent works, then settles in place under the same id', () => {
  const running = [bash('1', 'npm test', 'running')];
  assert.equal(groupActivity(running, { active: true })[0].running, true);
  assert.equal(groupActivity(running, { active: false })[0].running, false);
  const settled = groupActivity([...running, { type: 'tool', id: '1', name: 'Bash', kind: 'shell', summary: 'npm test', input: '', output: 'ok', status: 'completed' }], { active: true });
  assert.equal(settled.length, 1);
  assert.deepEqual([settled[0].calls.length, settled[0].calls[0].output, settled[0].running], [1, 'ok', false]);
});

test('streamed thinking and text show live until their finished event replaces them', () => {
  const live = groupActivity([bash('1', 'ls'), { type: 'think_delta', text: 'hmm ' }, { type: 'think_delta', text: 'ok' }], { active: true });
  assert.deepEqual(live.slice(1).map((it) => [it.kind, it.text, it.running]), [['think', 'hmm ok', true]]);
  const typing = groupActivity([{ type: 'think', text: 'hmm ok' }, { type: 'delta', text: 'The ' }, { type: 'delta', text: 'answer' }], { active: true });
  assert.deepEqual(shape(typing), [['think', 'hmm ok'], ['live', 'The answer']]);
  const done = groupActivity([{ type: 'think', text: 'hmm ok' }, { type: 'delta', text: 'The ' }, { type: 'text', text: 'The answer.' }]);
  assert.deepEqual(shape(done), [['think', 'hmm ok'], ['text', 'The answer.']]);
});

test('text, typed blocks and notes are never folded into an activity row and keep their payload', () => {
  const blocks = { type: 'blocks', blocks: [{ type: 'diagram', mermaid: 'graph TD; a-->b' }] };
  const text = { type: 'text', text: '<b>widgets</b> ```mermaid\ngraph TD; a-->b\n```' };
  const items = groupActivity([bash('1', 'ls'), text, bash('2', 'ls'), blocks, { type: 'meta', text: 'waiting for a permission' }, bash('3', 'ls'), bash('4', 'pwd')]);
  assert.deepEqual(items.map((it) => it.kind), ['tools', 'event', 'tools', 'event', 'event', 'tools']);
  assert.equal(items[1].event, text);
  assert.equal(items[3].event, blocks);
  for (const row of items.filter((it) => it.kind === 'tools')) assert.ok(row.calls.every((c) => c.type === 'tool'));
});

test('older logs without a kind or an id still group by tool name, a tool_result fills the call before it', () => {
  const items = groupActivity([{ type: 'tool', name: 'Bash', input: '{"command":"ls"}' }, { type: 'tool_result', text: 'a.ts' }, { type: 'tool', name: 'Read', input: '{"file_path":"a.ts"}' }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].label, 'Ran 1 command and read 1 file');
  assert.equal(items[0].calls[0].output, 'a.ts');
  assert.equal(kindOf({ name: 'MultiEdit' }), 'edit');
});
