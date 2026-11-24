const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const session = new Map();
global.window = { sessionStorage: { getItem: key => session.get(key) ?? null, setItem: (key, value) => session.set(key, value), removeItem: key => session.delete(key) } };
const filename = path.resolve(__dirname, '../src/stores/workspace-tabs.ts');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
const store = loaded.exports.default;
const chat = { id: 'chat-default', type: 'chat', title: 'New Chat' };
const files = { id: 'tab-files', type: 'files', title: 'Files' };
beforeEach(() => store.setState({ tabs: [chat], activeTabId: chat.id, splitTabs: [files], activeSplitTabId: files.id, isSplit: true, focusedPane: 'right' }));

test('PNG and JPEG variants open read-only image tabs in the primary pane and preserve Files', () => {
  for (const name of ['logo.png', 'photo.jpg', 'photo.JPEG', 'çalışma-資料.PNG']) {
    const filePath = '/workspace/' + name;
    const id = store.getState().openFileTab({ uuid: filePath, path: filePath });
    const tab = store.getState().tabs.find(tab => tab.id === id);
    assert.equal(tab.type, 'image');
    assert.equal(tab.isDirty, false);
    assert.equal(store.getState().activeTabId, id);
    assert.equal(store.getState().focusedPane, 'left');
    assert.deepEqual(store.getState().splitTabs, [files]);
    store.getState().openFileTab({ uuid: filePath, path: filePath });
    assert.equal(store.getState().tabs.filter(tab => tab.id === id).length, 1);
  }
});

test('image identity persists without storing binary contents, so reload fetches fresh bytes', async () => {
  const filePath = '/workspace/logo.png';
  const id = store.getState().openFileTab({ uuid: filePath, path: filePath }, 'iVBORw0KGgo=', true);
  const savedSession = session.get('nr_workspace_tabs');
  const stored = JSON.parse(savedSession).state.tabs.find(tab => tab.id === id);
  assert.equal(stored.type, 'image');
  assert.equal(stored.content, undefined);
  assert.equal(stored.isContentLoaded, undefined);
  store.setState({ tabs: [chat], activeTabId: chat.id });
  session.set('nr_workspace_tabs', savedSession);
  await store.persist.rehydrate();
  assert.equal(store.getState().activeTabId, id);
  assert.equal(store.getState().tabs.find(tab => tab.id === id).filePath, filePath);
});

test('deleting an active image closes the preview and opens New Chat', () => {
  const filePath = '/workspace/photo.jpg';
  store.getState().openFileTab({ uuid: filePath, path: filePath });
  assert.equal(store.getState().closeDeletedFileTabs(filePath), true);
  assert.equal(store.getState().tabs.find(tab => tab.id === store.getState().activeTabId).type, 'chat');
  assert.deepEqual(store.getState().splitTabs, [files]);
});
