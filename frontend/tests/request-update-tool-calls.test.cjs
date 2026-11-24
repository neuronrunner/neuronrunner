const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const cache = new Map();
function load(filename) {
  if (cache.has(filename)) return cache.get(filename);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = id => {
    if (id === '@/i18n') return { __esModule: true, default: { t: k => k } };
    if (id.startsWith('@/components/chat/')) {
      const target = id.split('/').at(-1);
      return load(path.resolve(__dirname, '../src/components/chat/', target + '.ts'));
    }
    return Module.prototype.require.call(loaded, id);
  };
  loaded._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    }).outputText,
    filename
  );
  cache.set(filename, loaded.exports);
  return loaded.exports;
}

const { normalizeToolCalls, mergeRequestUpdateMessage } = load(
  path.resolve(__dirname, '../src/components/chat/normalize-tool-calls.ts')
);
const { buildStreamFromMessage } = load(
  path.resolve(__dirname, '../src/components/chat/stream-builder.ts')
);

test('normalizeToolCalls maps raw OpenAI-shaped backend tool calls to ToolCallInfo', () => {
  const normalized = normalizeToolCalls([
    {
      id: 'tc-1',
      type: 'function',
      function: { name: 'edit_file', arguments: '{"path":"/workspace/app.ts"}' },
      title: 'Edit',
      result: { output: '', status: 'success' },
      duration_ms: 140,
    },
    {
      id: 'tc-2',
      type: 'function',
      function: { name: 'shell_exec', arguments: '{"command":"npm test"}' },
      output: [{ text: 'ok' }],
    },
  ]);

  assert.equal(normalized[0].name, 'edit_file');
  assert.equal(normalized[0].arguments, '{"path":"/workspace/app.ts"}');
  assert.equal(normalized[0].status, 'done');
  assert.equal(normalized[0].durationMs, 140);
  assert.equal(normalized[0].result, '{"output":"","status":"success"}');

  assert.equal(normalized[1].name, 'shell_exec');
  assert.equal(normalized[1].arguments, '{"command":"npm test"}');
  assert.equal(normalized[1].output, 'ok');
  assert.equal(normalized[1].status, 'calling');
});

test('mergeRequestUpdateMessage preserves tool arguments and ignores stale regressions', () => {
  const initial = mergeRequestUpdateMessage(null, {
    parent_uuid: 'parent-1',
    partial_content: 'Working on it...',
    phases: [
      { type: 'tool_result', label: 'Edit', toolName: 'edit_file', toolCallId: 'tc-1' },
      { type: 'tool_call', label: 'Shell', toolName: 'shell_exec', toolCallId: 'tc-2' },
    ],
    tool_calls: [
      {
        id: 'tc-1',
        function: { name: 'edit_file', arguments: '{"path":"/workspace/app.ts"}' },
        result: { status: 'success' },
      },
      {
        id: 'tc-2',
        function: { name: 'shell_exec', arguments: '{"command":"npm test"}' },
      },
    ],
  });

  assert.equal(initial.tool_calls.length, 2);
  assert.equal(initial.tool_calls[0].arguments, '{"path":"/workspace/app.ts"}');
  assert.equal(initial.tool_calls[1].arguments, '{"command":"npm test"}');

  // Simulate an out-of-order / empty-args request_update broadcast
  const afterStale = mergeRequestUpdateMessage(initial, {
    partial_content: 'Work',
    phases: [{ type: 'tool_result', label: 'Edit', toolName: 'edit_file', toolCallId: 'tc-1' }],
    tool_calls: [
      {
        id: 'tc-1',
        function: { name: 'edit_file', arguments: '{}' },
      },
    ],
  });

  assert.equal(afterStale.content, 'Working on it...');
  assert.equal(afterStale.phases.length, 2);
  assert.equal(afterStale.tool_calls.length, 2);
  assert.equal(afterStale.tool_calls[0].arguments, '{"path":"/workspace/app.ts"}');
  assert.equal(afterStale.tool_calls[1].arguments, '{"command":"npm test"}');

  // Same-length update with empty '{}' for an existing tool call also keeps previous arguments
  const afterEmptyArgs = mergeRequestUpdateMessage(initial, {
    partial_content: 'Working on it... done',
    phases: initial.phases,
    tool_calls: [
      { id: 'tc-1', function: { name: 'edit_file', arguments: '{}' }, result: { status: 'success' } },
      { id: 'tc-2', function: { name: 'shell_exec', arguments: '{}' }, result: { exit_code: 0 } },
    ],
  });

  assert.equal(afterEmptyArgs.tool_calls[0].arguments, '{"path":"/workspace/app.ts"}');
  assert.equal(afterEmptyArgs.tool_calls[1].arguments, '{"command":"npm test"}');
  assert.equal(afterEmptyArgs.tool_calls[1].status, 'done');
});

test('buildStreamFromMessage extracts nested function.name and function.arguments defensively', () => {
  const stream = buildStreamFromMessage({
    role: 'assistant',
    content: '',
    phases: [
      { type: 'tool_result', label: 'Edit', toolName: 'edit_file', toolCallId: 'tc-raw' },
    ],
    tool_calls: [
      {
        id: 'tc-raw',
        function: { name: 'edit_file', arguments: '{"path":"/workspace/file.ts"}' },
        result: '{"status":"success"}',
      },
    ],
  });

  const seg = stream.segments.find(s => s.tool?.id === 'tc-raw');
  assert.ok(seg);
  assert.equal(seg.tool.name, 'edit_file');
  assert.equal(seg.tool.arguments, '{"path":"/workspace/file.ts"}');
});

test('mergeRequestUpdateMessage preserves durationMs on tool_calls and phases', () => {
  const initial = mergeRequestUpdateMessage(null, {
    parent_uuid: 'parent-1',
    partial_content: '',
    phases: [
      { type: 'thinking', label: 'Thought', durationMs: 650, streaming: false },
      { type: 'tool_result', label: 'Edit', toolName: 'edit_file', toolCallId: 'tc-1' },
    ],
    tool_calls: [
      {
        id: 'tc-1',
        function: { name: 'edit_file', arguments: '{"path":"/workspace/app.ts"}' },
        result: { status: 'success' },
        duration_ms: 822,
      },
    ],
  });

  assert.equal(initial.phases[0].durationMs, 650);
  assert.equal(initial.tool_calls[0].durationMs, 822);

  // Subsequent update omits duration_ms on tc-1 and durationMs on thinking phase
  const next = mergeRequestUpdateMessage(initial, {
    partial_content: 'Done',
    phases: [
      { type: 'thinking', label: 'Thought', streaming: false },
      { type: 'tool_result', label: 'Edit', toolName: 'edit_file', toolCallId: 'tc-1' },
      { type: 'tool_call', label: 'Shell', toolName: 'shell_exec', toolCallId: 'tc-2' },
    ],
    tool_calls: [
      {
        id: 'tc-1',
        function: { name: 'edit_file', arguments: '{"path":"/workspace/app.ts"}' },
        result: { status: 'success' },
      },
      {
        id: 'tc-2',
        function: { name: 'shell_exec', arguments: '{"command":"ls"}' },
      },
    ],
  });

  assert.equal(next.phases[0].durationMs, 650);
  assert.equal(next.tool_calls[0].durationMs, 822);
});
