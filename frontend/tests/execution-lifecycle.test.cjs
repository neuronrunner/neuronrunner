const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const cache = new Map();
const text = ({ markdown }) => React.createElement('p', null, markdown);
const empty = () => null;
const store = {
  isStreaming: true,
  setSelectedModel() {}, setSelectedModelType() {}, setReasoningLevel() {}, fetchModelDetails() {},
};
const enChat = require('../src/locales/en/chat.json');
const tChat = (key, vars = {}) => {
  const pathKey = key.replace(/^chat:/, '');
  const resolve = value => value.split('.').reduce((acc, part) => acc?.[part], enChat);
  let val = resolve(pathKey);
  if (typeof val !== 'string' && vars.count !== undefined) {
    val = resolve(`${pathKey}_${Number(vars.count) === 1 ? 'one' : 'other'}`);
  }
  if (typeof val !== 'string') return key;
  return val.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
};
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const filename = path.resolve(__dirname, '../src/components/chat/', name);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = id => {
    if (id === '@/lib/utils') return { cn: (...values) => values.filter(Boolean).join(' '), formatModelIdentifier: value => value };
    if (id === '@/lib/reasoning') return load('../../lib/reasoning.ts');
    if (id === '@/components/markdown-renderer') return { __esModule: true, default: text };
    if (id === '@/components/content-renderer') return { __esModule: true, default: empty, ToolOutputCard: empty, normalizeMediaUrl: value => value };
    if (id === '@/stores/chat') return { __esModule: true, default: selector => selector(store) };
    if (id === '@/stores/search-models') return { __esModule: true, default: selector => selector({ models: [], fetchModels() {} }) };
    if (id === '@/i18n') return { __esModule: true, default: { t: tChat } };
    if (id === 'react-i18next') return { useTranslation: () => ({ t: tChat, i18n: { resolvedLanguage: 'en' } }) };
    if (id === '@/components/ui/toaster') return { toaster: { create() {} } };
    if (['@/components/markdown-image', '@/components/chat-error-message', '@/components/image-gallery', '@/components/message-attachments', '@/components/chat/diff-view', './diff-view'].includes(id)) return { __esModule: true, default: empty };
    if (id.startsWith('@/components/chat/')) {
      const target = id.split('/').at(-1);
      return load(target + (fs.existsSync(path.resolve(path.dirname(filename), target + '.tsx')) ? '.tsx' : '.ts'));
    }
    if (id.startsWith('./')) {
      const target = id.slice(2);
      return load(target + (fs.existsSync(path.resolve(path.dirname(filename), target + '.tsx')) ? '.tsx' : '.ts'));
    }
    return Module.prototype.require.call(loaded, id);
  };
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, filename);
  cache.set(name, loaded.exports);
  return loaded.exports;
}
const StreamView = load('stream-view.tsx').default;
const ChatMessage = load('chat-message.tsx').default;
const tool = (id, status = 'done') => ({
  key: `tool-${id}`, segIdx: Number(id), kind: 'tool_result', content: '', status,
  tool: { id, name: 'shell_exec', arguments: { command: 'echo hello' }, status, result: status === 'done' ? '{"stdout":"hello","exit_code":0}' : undefined },
});
const render = (segments, isStreaming) => renderToStaticMarkup(React.createElement(StreamView, {
  stream: { segments, preToolPreserved: false }, isStreaming,
}));
const statuses = html => [...html.matchAll(/data-status="([^"]+)"/g)].map(match => match[1]);

test('an automatic shell tool opens activity details while running', () => {
  const html = render([tool('1', 'calling')], true);
  assert.ok(html.includes('aria-expanded="true"'));
  assert.ok(html.includes('aria-label="Activity details"'));
  assert.deepEqual(statuses(html), ['running']);
});

test('the activity spinner remains running between a tool result and the next call', () => {
  for (const segments of [[tool('1', 'calling')], [tool('1')], [tool('1'), tool('2', 'calling')], [tool('1'), tool('2')]]) {
    const html = render(segments, true);
    assert.deepEqual(statuses(html), ['running']);
    assert.ok(html.includes('animate-spin'));
    assert.ok(html.includes('aria-expanded="true"'));
  }
  assert.ok(render([tool('1')], true).includes('Preparing the next step…'));
});

test('completed activity summarizes categories and renders clean rows while open', () => {
  const thinking = { key: 'thinking-1', segIdx: 0, kind: 'thinking', status: 'done', content: 'Inspecting the project', durationMs: 1200 };
  const segments = [thinking, tool('1')];
  const completed = render(segments, false);
  assert.ok(completed.includes('1 command'));
  assert.ok(completed.includes('aria-expanded="false"'));
  const live = render(segments, true);
  assert.ok(live.includes('Thought'));
  assert.ok(live.includes('1.2s'));
  assert.ok(live.includes('Shell'));
  assert.ok(live.includes('echo hello'));
});

test('activity closes when the response finishes', () => {
  assert.ok(render([tool('1')], true).includes('aria-expanded="true"'));
  assert.ok(render([tool('1')], false).includes('aria-expanded="false"'));
});

test('only the latest activity runs when assistant text separates tool groups', () => {
  const textSegment = { key: 'text', segIdx: 3, kind: 'message', status: 'streaming', content: 'Next step' };
  assert.deepEqual(statuses(render([tool('1'), textSegment], true)), ['running']);
  assert.deepEqual(statuses(render([tool('1'), textSegment, tool('2')], true)), ['done', 'running']);
});

test('finishing or stopping the response stops the spinner, including unfinished tool records', () => {
  for (const status of ['done', 'calling', 'streaming']) {
    const html = render([tool('1', status)], false);
    assert.deepEqual(statuses(html), ['done']);
    assert.ok(!html.includes('animate-spin'));
  }
});

test('a failed tool retains its error while the response continues and stops on completion', () => {
  const segments = [tool('1', 'error')];
  const live = render(segments, true);
  assert.deepEqual(statuses(live), ['running']);
  assert.ok(live.includes('1 failed'));
  assert.deepEqual(statuses(render(segments, false)), ['error']);
});

test('only the live chat message receives the active response state', () => {
  const message = { role: 'assistant', type: 'text', content: '', tool_calls: [tool('1').tool] };
  const live = renderToStaticMarkup(React.createElement(ChatMessage, { message, isLive: true }));
  const historical = renderToStaticMarkup(React.createElement(ChatMessage, { message }));
  assert.deepEqual(statuses(live), ['running']);
  assert.deepEqual(statuses(historical), ['done']);
  store.isStreaming = false;
  try {
    assert.deepEqual(statuses(renderToStaticMarkup(React.createElement(ChatMessage, { message, isLive: true }))), ['done']);
  } finally { store.isStreaming = true; }
});
