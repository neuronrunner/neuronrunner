const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../src/components/chat/tool-status.ts');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded.require = id => id === '@/i18n' ? { __esModule: true, default: { t: k => k } } : Module.prototype.require.call(loaded, id);
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
const { hasToolResult, toolResultStatus, serializeToolResult, formatToolName, cleanPhaseLabel } = loaded.exports;

test('structured and serialized failures show an error instead of done', () => {
  for (const result of [{ error: 'not found' }, { exit_code: -1 }, { exit_code: -15 }, { status: 'failed' }, { status: 'error' }, { success: false }]) {
    assert.equal(toolResultStatus(result), 'error');
    assert.equal(toolResultStatus(JSON.stringify(result)), 'error');
  }
});

test('completed shell executions with non-zero exit codes or stderr are done, not sandbox errors', () => {
  for (const result of [
    { command: 'git fetch', exit_code: 128, stderr: "fatal: couldn't find remote ref" },
    { command: 'grep foo bar', exit_code: 1, stdout: '', stderr: '' },
    { exit_code: 1 },
    { exit_code: 128 },
    { status_code: 404, body: 'Not found' },
    { status_code: 403, body: 'Forbidden' },
  ]) {
    assert.equal(toolResultStatus(result), 'done');
    assert.equal(toolResultStatus(JSON.stringify(result)), 'done');
  }
});

test('empty successful results complete instead of leaving the spinner pending', () => {
  for (const result of ['', false, 0, {}, [], { exit_code: 0 }, { status_code: 200 }, { status: 'partial', images: [] }]) {
    assert.equal(hasToolResult(result), true);
    assert.equal(toolResultStatus(result), 'done');
    assert.notEqual(serializeToolResult(result), undefined);
  }
  for (const result of [null, undefined]) {
    assert.equal(hasToolResult(result), false);
    assert.equal(toolResultStatus(result), 'calling');
    assert.equal(serializeToolResult(result), undefined);
  }
});

test('saved JSON is not double encoded when history or polling restores a result', () => {
  const json = '{"exit_code":-1,"stderr":"failed"}';
  assert.equal(serializeToolResult(json), json);
  assert.equal(serializeToolResult(JSON.parse(json)), json);
  assert.equal(toolResultStatus(serializeToolResult(json)), 'error');
});

test('cleanPhaseLabel removes duration and done suffixes from backend-provided labels', () => {
  assert.equal(cleanPhaseLabel('Playwright · Browser Navigate: 1.2s'), 'Playwright · Browser Navigate');
  assert.equal(cleanPhaseLabel('Playwright · Browser Navigate - Done'), 'Playwright · Browser Navigate');
  assert.equal(cleanPhaseLabel('Playwright · Browser Navigate - Failed'), 'Playwright · Browser Navigate');
  assert.equal(cleanPhaseLabel('Playwright · Browser Navigate'), 'Playwright · Browser Navigate');
});

test('MCP tool fallback formats cleanly without hardcoded lists', () => {
  assert.equal(
    formatToolName('mcp__io_github_microsoft_playwright-mcp__browser_navigate'),
    'Playwright · Browser Navigate'
  );
  assert.equal(
    formatToolName('shell_exec'),
    'Shell Exec'
  );
});
