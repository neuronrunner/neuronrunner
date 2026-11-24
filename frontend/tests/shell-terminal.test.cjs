const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const enChat = require('../src/locales/en/chat.json');
const tEn = (key, vars = {}) => {
  const pathKey = key.replace(/^chat:/, '');
  const val = pathKey.split('.').reduce((acc, part) => acc?.[part], enChat);
  if (typeof val !== 'string') return key;
  return val.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
};

function load(name) {
  const filename = path.resolve(__dirname, '../src/components/chat/', name);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = id => {
    if (id === './terminal-output') return outputHelpers;
    if (id === '@/i18n') return { __esModule: true, default: { t: tEn } };
    if (id === 'react-i18next') return { useTranslation: () => ({ t: tEn, i18n: { resolvedLanguage: 'en' } }) };
    return Module.prototype.require.call(loaded, id);
  };
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, filename);
  return loaded.exports;
}
const outputHelpers = load('terminal-output.ts');
const ShellTerminal = load('shell-terminal.tsx').default;
const render = extra => renderToStaticMarkup(React.createElement(ShellTerminal, {
  command: 'echo hello',
  tool: { id: 'shell', name: 'shell_exec', arguments: '{}', status: 'done', ...extra },
}));

test('structured output frames render their text without crashing or exposing object coercion', () => {
  const html = render({ output: { stream: 'stdout', text: 'hello <script>alert(1)</script>' } });
  assert.ok(html.includes('hello &lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('[object Object]'));
});

test('output arrays and structured terminal results render useful text', () => {
  assert.ok(render({ output: [{ stream: 'stdout', text: 'first\n' }, { stream: 'stderr', text: 'second' }] }).includes('first\nsecond'));
  const html = render({ result: { stdout: 'saved stdout', stderr: 'saved stderr', cwd: '/workspace/app', exit_code: 1 } });
  assert.ok(html.includes('saved stdout\nsaved stderr'));
  assert.ok(html.includes('/workspace/app'));
  assert.ok(html.includes('Exit 1'));
});

test('serialized results retain terminal status and output when no streamed text exists', () => {
  const html = render({ output: '', result: JSON.stringify({ stdout: 'finished', exit_code: 0 }) });
  assert.ok(html.includes('finished'));
  assert.ok(html.includes('Exit 0'));
});

test('results with an output field render their output instead of No output', () => {
  const byosHtml = render({ output: undefined, result: JSON.stringify({ output: 'PR created: #42', status: 'success' }) });
  assert.ok(byosHtml.includes('PR created: #42'));
  assert.ok(!byosHtml.includes('No output'));

  const codexHtml = render({ output: undefined, result: { output: 'branch pushed', exit_code: 0, status: 'completed' } });
  assert.ok(codexHtml.includes('branch pushed'));
  assert.ok(codexHtml.includes('Exit 0'));

  const emptyOutputHtml = render({ output: undefined, result: JSON.stringify({ output: '', status: 'success' }) });
  assert.ok(emptyOutputHtml.includes('No output'));
  assert.ok(!emptyOutputHtml.includes('&quot;status&quot;'));

  assert.equal(outputHelpers.terminalOutputText({ output: 'direct output', status: 'success' }), 'direct output');
  assert.equal(outputHelpers.terminalOutputText({ output: '', status: 'success' }), '');
});

test('terminal escape sequences are stripped and plain text legacy results remain readable', () => {
  const html = render({ output: '\x1b[31mred\x1b[0m\x1b]0;title\x07' });
  assert.ok(html.includes('red'));
  assert.ok(!html.includes('\x1b'));
  assert.ok(!html.includes('0;title'));
  assert.ok(render({ result: 'legacy output' }).includes('legacy output'));
});

test('unexpected scalar, empty, and JSON output values cannot crash the terminal', () => {
  for (const output of [0, 42, false, null, undefined, {}, []]) {
    assert.doesNotThrow(() => render({ output, result: null }));
  }
  assert.ok(render({ output: 42 }).includes('42'));
  assert.equal(outputHelpers.terminalOutputText({ text: 'earlier\n' }) + outputHelpers.terminalOutputText({ text: 'later' }), 'earlier\nlater');
});

test('while generating or running without output, the cursor is placed directly on the command line', () => {
  const html = render({ status: 'calling', output: '', result: {} });
  // The command pre block contains the cursor
  assert.ok(html.includes('$ </span>echo hello<span aria-hidden="true"'));
  // No empty output pre block
  assert.ok(!html.includes('aria-label="Terminal output"'));
});

test('when output arrives during execution, output renders underneath and cursor follows output', () => {
  const html = render({ status: 'calling', output: 'running tests...', result: {} });
  assert.ok(!html.includes('echo hello<span aria-hidden="true"'));
  assert.ok(html.includes('aria-label="Terminal output">running tests...<span aria-hidden="true"'));
});

test('getShellCommand extracts commands in real-time from incomplete streaming JSON chunks', () => {
  const executionBlock = (() => {
    const filename = path.resolve(__dirname, '../src/components/chat/execution-block.tsx');
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded.require = id => {
      if (id === './shell-terminal') return ShellTerminal;
      if (id === '@/lib/utils') return { cn: (...v) => v.filter(Boolean).join(' ') };
      if (id === '@/components/chat/animated-collapse') return () => null;
      if (id === '@/components/markdown-renderer') return () => null;
      if (id === '@/components/markdown-image') return () => null;
      if (id === '@/components/content-renderer') return { ToolOutputCard: () => null, normalizeMediaUrl: v => v };
      if (id === './execution-summary') return { summarizeExecution: () => ({}) };
      if (id === './view-image') return { viewedImages: () => [] };
      if (id === './diff-view') return { __esModule: true, default: () => null, DiffContentBlock: () => null };
      if (id === './tool-diff') return { extractToolDiff: () => null };
      if (id === '@/stores/chat') return { __esModule: true, default: () => ({}) };
      if (id === '@/i18n') return { __esModule: true, default: { t: tEn } };
      if (id === 'react-i18next') return { useTranslation: () => ({ t: tEn, i18n: { resolvedLanguage: 'en' } }) };
      if (id.startsWith('react-icons/')) return new Proxy({}, { get: () => () => null });
      return Module.prototype.require.call(loaded, id);
    };
    loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    }).outputText, filename);
    return loaded.exports;
  })();

  const { getShellCommand, extractStreamingJsonField } = executionBlock;

  // Realtime token-by-token progression
  assert.equal(getShellCommand('{"command": "n'), 'n');
  assert.equal(getShellCommand('{"command": "npm '), 'npm ');
  assert.equal(getShellCommand('{"command": "npm install -g pnpm'), 'npm install -g pnpm');
  assert.equal(getShellCommand('{"command": "npm install -g pnpm"}'), 'npm install -g pnpm');

  // Alternative keys (cmd, script, code, input)
  assert.equal(getShellCommand('{"cmd": "git status --short'), 'git status --short');
  assert.equal(getShellCommand('{"script": "python main.py'), 'python main.py');

  // Escaped strings inside JSON
  assert.equal(getShellCommand('{"command": "echo \\"hello world\\" && ls'), 'echo "hello world" && ls');

  // Streaming field extraction on primary keys
  assert.equal(extractStreamingJsonField('{"query": "search term', ['query']), 'search term');
});

