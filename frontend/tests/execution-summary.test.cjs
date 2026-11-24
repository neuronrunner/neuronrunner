const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
function load(name) {
  const filename = path.resolve(__dirname, '../src/components/chat/', name + '.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(compiled.outputText, filename);
  return loaded.exports;
}
const { summarizeExecution, executionGroupKey } = load('execution-summary');
const { buildStreamFromMessage } = load('stream-builder');
const tool = (id, name, status = 'done', extra = {}) => ({ id, name, status, arguments: '{}', ...extra });
const segment = (idx, call) => ({ segIdx: idx, key: `tool-${call.id}`, kind: call.status === 'calling' ? 'tool_call' : 'tool_result', status: call.status, content: '', tool: call });
const message = (calls, phases = []) => ({ role: 'assistant', content: '', tool_calls: calls, phases });
const callPhase = call => ({ type: 'tool_call', toolCallId: call.id, toolName: call.name, label: call.name });

test('the long alternating file and command timeline becomes one concise category summary', () => {
  const names = ['glob_files', 'file_read', 'shell_exec', 'list_directory', 'shell_exec', 'shell_exec', 'file_write'];
  const segments = names.flatMap((name, i) => [
    { segIdx: i * 2, kind: 'thinking', content: 'Inspecting the project', status: 'done' },
    segment(i * 2 + 1, tool(String(i), name)),
  ]);
  const summary = summarizeExecution(segments);
  assert.equal(summary.tools.length, 7);
  assert.equal(summary.thinkingCount, 7);
  assert.deepEqual(summary.categories, [{ label: 'Files', count: 3 }, { label: 'Commands', count: 3 }, { label: 'Changes', count: 1 }]);
  assert.equal(summary.running, false);
});

test('a tool call and its result count once, retaining completed results', () => {
  const summary = summarizeExecution([
    segment(0, tool('one', 'file_read', 'calling')),
    segment(1, tool('one', 'file_read', 'done', { result: 'README contents' })),
  ]);
  assert.equal(summary.tools.length, 1);
  assert.equal(summary.tools[0].result, 'README contents');
  assert.equal(summary.running, false);
});

test('errors remain counted while another tool is running', () => {
  const failed = tool('failed', 'shell_exec', 'error');
  const running = tool('active', 'file_read', 'calling', { arguments: { path: '/workspace/README.md' } });
  const summary = summarizeExecution([{ segIdx: 0, kind: 'tool_group', status: 'calling', content: '', tools: [failed, running] }]);
  assert.equal(summary.errorCount, 1);
  assert.equal(summary.running, true);
  assert.equal(summary.activeTool.id, 'active');
});

test('reasoning without tools has a running summary and no invented tool count', () => {
  const summary = summarizeExecution([{ segIdx: 0, kind: 'thinking', content: '', status: 'streaming' }]);
  assert.equal(summary.running, true);
  assert.equal(summary.tools.length, 0);
  assert.equal(summary.thinkingCount, 1);
});

test('a pending tool stays visible and transitions to a single completed result', () => {
  const pending = tool('one', 'shell_exec', 'calling', { arguments: { command: 'python hello.py' } });
  const live = buildStreamFromMessage(message([pending], [callPhase(pending)]));
  assert.equal(live.segments[0].kind, 'tool_call');
  assert.equal(summarizeExecution(live.segments).running, true);
  const done = { ...pending, status: 'done', result: '', durationMs: 250 };
  const completed = buildStreamFromMessage(message([done], [callPhase(done), { ...callPhase(done), type: 'tool_result' }]));
  assert.equal(completed.segments.length, 1);
  assert.equal(completed.segments[0].tool.result, '');
  assert.equal(completed.segments[0].tool.durationMs, 250);
  assert.equal(summarizeExecution(completed.segments).running, false);
  assert.equal(executionGroupKey(live.segments[0]), executionGroupKey(completed.segments[0]));
});

test('adding a second tool preserves the activity identity so expanded details do not reset', () => {
  const first = tool('one', 'file_read');
  const second = tool('two', 'shell_exec', 'calling');
  const initial = buildStreamFromMessage(message([first], [callPhase(first)]));
  const updated = buildStreamFromMessage(message([first, second], [callPhase(first), callPhase(second)]));
  assert.equal(updated.segments[0].kind, 'tool_group');
  assert.equal(updated.segments[0].status, 'calling');
  assert.equal(executionGroupKey(initial.segments[0]), executionGroupKey(updated.segments[0]));
  assert.equal(summarizeExecution(updated.segments).tools.length, 2);
});

test('assistant text between tools remains in chronological order outside the activity groups', () => {
  const first = tool('one', 'file_read');
  const second = tool('two', 'shell_exec');
  const stream = buildStreamFromMessage(message([first, second], [
    callPhase(first), { type: 'content', chunk: 'Now I will run the project.', round: 1 },
    callPhase(second), { type: 'content', chunk: 'The project ran successfully.', round: 2 },
  ]));
  assert.deepEqual(stream.segments.map(s => s.kind), ['tool_result', 'message', 'tool_result', 'message']);
  assert.equal(stream.segments[1].content, 'Now I will run the project.');
  assert.equal(stream.segments[3].content, 'The project ran successfully.');
});

test('a mixed tool group prioritizes ongoing work without losing failures, including messages without phases', () => {
  const failed = tool('one', 'shell_exec', 'error');
  const pending = tool('two', 'file_read', 'calling');
  const stream = buildStreamFromMessage(message([failed, pending]));
  assert.equal(stream.segments[0].status, 'calling');
  const summary = summarizeExecution(stream.segments);
  assert.equal(summary.errorCount, 1);
  assert.equal(summary.running, true);
});

test('older saved phases without a tool ID use the completed call instead of spinning indefinitely', () => {
  const call = tool('legacy-read', 'file_read', 'done', { result: 'README contents' });
  const stream = buildStreamFromMessage(message([call], [{ type: 'tool_call', toolName: call.name, label: call.name }]));
  const summary = summarizeExecution(stream.segments);
  assert.equal(summary.running, false);
  assert.equal(summary.tools[0].id, call.id);
  assert.equal(summary.tools[0].result, 'README contents');
});
