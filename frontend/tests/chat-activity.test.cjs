const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const enChat = require('../src/locales/en/chat.json');
const t = (key, vars = {}) => {
  const pathKey = key.replace(/^chat:/, '');
  const resolve = value => value.split('.').reduce((acc, part) => acc?.[part], enChat);
  let value = resolve(pathKey);
  if (typeof value !== 'string' && vars.count !== undefined) {
    value = resolve(`${pathKey}_${Number(vars.count) === 1 ? 'one' : 'other'}`);
  }
  if (typeof value !== 'string') return key;
  return value.replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars[name] ?? ''));
};

const chatStore = {
  conversationId: null,
  undoSandboxChanges: async () => ({ ok: true }),
};
const projectStore = {
  currentSandbox: null,
  sandboxes: [],
  sandboxConversations: {},
};

function load(name) {
  const filename = path.resolve(__dirname, '../src/components/chat/', name);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = id => {
    if (id === 'react-i18next') return { useTranslation: () => ({ t }) };
    if (id === '@/stores/chat') return { __esModule: true, default: selector => selector(chatStore) };
    if (id === '@/stores/sandbox-projects') return { __esModule: true, default: selector => selector(projectStore) };
    if (id === '@/components/ui/toaster') return { toaster: { create() {} } };
    if (id === '@/lib/utils') return { cn: (...values) => values.filter(Boolean).join(' ') };
    if (id.startsWith('react-icons/')) return new Proxy({}, { get: () => () => null });
    return Module.prototype.require.call(loaded, id);
  };
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, filename);
  return loaded.exports;
}

const DiffView = load('diff-view.tsx').default;
const diff = {
  has_changes: true,
  files: [{ path: 'src/app.tsx', status: 'modified', additions: 5, deletions: 2, diff: '@@ -1 +1 @@\n-old\n+new' }],
  total_additions: 5,
  total_deletions: 2,
};

test('compact activity diff renders a file card with line counts', () => {
  const html = renderToStaticMarkup(React.createElement(DiffView, { diff, messageUuid: 'message-1', compact: true }));
  assert.ok(html.includes('data-compact-diff'));
  assert.ok(html.includes('src/app.tsx'));
  assert.ok(html.includes('+5'));
  assert.ok(html.includes('-2'));
  assert.ok(html.includes('1 file modified'));
});
