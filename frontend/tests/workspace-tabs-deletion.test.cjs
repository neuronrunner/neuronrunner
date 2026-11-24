const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const session = new Map();
global.window = { sessionStorage: { getItem: key => session.get(key) ?? null, setItem: (key, value) => session.set(key, value), removeItem: key => session.delete(key) } };
const filename = path.resolve(__dirname, '../src/stores/workspace-tabs.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(compiled.outputText, filename);
const store = loaded.exports.default;
const chat = { id: 'previous-chat', type: 'chat', title: 'Previous', conversationUuid: 'previous-conversation' };
const filesPanel = { id: 'files', type: 'files', title: 'Files' };
const file = (id, filePath) => ({ id, type: 'code', title: path.basename(filePath), filePath, fileUuid: filePath });
const active = () => store.getState().tabs.find(tab => tab.id === store.getState().activeTabId);
beforeEach(() => store.setState({ tabs: [chat], activeTabId: chat.id, splitTabs: [filesPanel], activeSplitTabId: filesPanel.id, isSplit: true, focusedPane: 'left' }));

test('deleting the active file opens New Chat and keeps other tabs and Files', () => {
  const edited = file('edited', '/workspace/hello.py');
  const other = file('other', '/workspace/notes.txt');
  store.setState({ tabs: [chat, other, edited], activeTabId: edited.id });
  assert.equal(store.getState().closeDeletedFileTabs(edited.filePath), true);
  assert.equal(active().type, 'chat');
  assert.equal(active().title, 'New Chat');
  assert.equal(active().conversationUuid, undefined);
  assert.ok(store.getState().tabs.some(tab => tab.id === other.id));
  assert.ok(store.getState().tabs.some(tab => tab.id === chat.id));
  assert.deepEqual(store.getState().splitTabs, [filesPanel]);
  const saved = JSON.parse(session.get('nr_workspace_tabs'));
  assert.ok(!saved.state.tabs.some(tab => tab.filePath === edited.filePath));
});

test('deleting an inactive open file keeps the current editor', () => {
  const first = file('first', '/workspace/first.py');
  const second = file('second', '/workspace/second.py');
  store.setState({ tabs: [chat, first, second], activeTabId: second.id });
  assert.equal(store.getState().closeDeletedFileTabs(first.filePath), false);
  assert.equal(active().id, second.id);
  assert.equal(store.getState().tabs.length, 2);
});

test('deleting a folder closes all descendants in both panes and keeps similarly named siblings', () => {
  const first = file('first', '/workspace/src/hello.py');
  const second = file('second', '/workspace/src/nested/help.ts');
  const sibling = file('sibling', '/workspace/src-backup/hello.py');
  store.setState({ tabs: [chat, first, sibling], activeTabId: first.id, splitTabs: [filesPanel, second] });
  assert.equal(store.getState().closeDeletedFileTabs('/workspace/src/'), true);
  assert.ok(store.getState().tabs.some(tab => tab.id === sibling.id));
  assert.ok(![...store.getState().tabs, ...store.getState().splitTabs].some(tab => tab.id === first.id || tab.id === second.id));
  assert.equal(active().title, 'New Chat');
});

test('deleting a file displayed in the right pane returns focus to New Chat', () => {
  const right = file('right', '/workspace/right.py');
  store.setState({ splitTabs: [filesPanel, right], activeSplitTabId: right.id, focusedPane: 'right' });
  assert.equal(store.getState().closeDeletedFileTabs(right.filePath), true);
  assert.equal(active().title, 'New Chat');
  assert.equal(store.getState().focusedPane, 'left');
  assert.equal(store.getState().activeSplitTabId, filesPanel.id);
});

test('deleting the only editor keeps Files in its panel', () => {
  const only = file('only', '/workspace/only.py');
  store.setState({ tabs: [only], activeTabId: only.id });
  store.getState().closeDeletedFileTabs(only.filePath);
  assert.equal(active().title, 'New Chat');
  assert.deepEqual(store.getState().splitTabs, [filesPanel]);
  assert.equal(store.getState().isSplit, true);
});

test('deleting a file with no open tab leaves navigation unchanged', () => {
  const before = store.getState();
  assert.equal(before.closeDeletedFileTabs('/workspace/unopened.py'), false);
  assert.equal(store.getState(), before);
});

test('closing the only file tab when files panel is in splitTabs creates New Chat and preserves files panel in splitTabs', () => {
  const only = file('only-file', '/workspace/only.py');
  store.setState({ tabs: [only], activeTabId: only.id, splitTabs: [filesPanel], activeSplitTabId: filesPanel.id, isSplit: true });
  store.getState().closeTab(only.id);
  assert.equal(active().type, 'chat');
  assert.equal(active().title, 'New Chat');
  assert.deepEqual(store.getState().splitTabs, [filesPanel]);
  assert.equal(store.getState().isSplit, true);
});

test('opening file tab puts editor in left pane and keeps files panel active in right pane', () => {
  store.setState({ tabs: [chat], activeTabId: chat.id, splitTabs: [filesPanel], activeSplitTabId: filesPanel.id, isSplit: true });
  const tabId = store.getState().openFileTab({ path: 'src/main.ts', file_size_bytes: 100 });
  assert.equal(store.getState().activeTabId, tabId);
  assert.equal(active().type, 'code');
  assert.equal(active().filePath, 'src/main.ts');
  assert.deepEqual(store.getState().splitTabs, [filesPanel]);
  assert.equal(store.getState().activeSplitTabId, filesPanel.id);
  assert.equal(store.getState().isSplit, true);
});
