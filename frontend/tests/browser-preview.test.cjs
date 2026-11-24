const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
function load(relative) {
  const filename = path.resolve(__dirname, relative);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
  const loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(compiled.outputText, filename);
  return loaded.exports;
}
const { parsePreviewAddress } = load('../src/lib/browser-preview.ts');
test('localhost and bare ports select the workspace and preserve routes, queries and fragments', () => {
  assert.deepEqual(parsePreviewAddress('3000'), {kind:'workspace',port:3000,path:'/'});
  assert.deepEqual(parsePreviewAddress('localhost:5173/app?q=1#section'), {kind:'workspace',port:5173,path:'/app?q=1#section'});
  for (const host of ['127.0.0.1','0.0.0.0','[::1]']) assert.equal(parsePreviewAddress(`http://${host}:8080`).port,8080);
});
test('external browsing requires HTTPS and never accepts credentials or executable URLs', () => {
  assert.deepEqual(parsePreviewAddress('https://example.com/path'), {kind:'external',url:'https://example.com/path'});
  for (const input of ['', '0', '65536', 'http://example.com', 'https://user:password@example.com', 'javascript:alert(1)', 'data:text/html,unsafe']) {
    assert.throws(() => parsePreviewAddress(input), undefined, input);
  }
});
test('desktop services cannot be opened through the generic browser preview', () => {
  for (const port of [5901, 6001, 6080, 9222]) {
    assert.throws(() => parsePreviewAddress(String(port)), /reserved/);
    assert.throws(() => parsePreviewAddress(`localhost:${port}`), /reserved/);
  }
});
test('desktop opens once beside chat and terminal, without persisting access links', () => {
  const session = new Map();
  global.window = {sessionStorage:{getItem:key=>session.get(key)??null,setItem:(key,value)=>session.set(key,value),removeItem:key=>session.delete(key)}};
  const store = load('../src/stores/workspace-tabs.ts').default;
  store.setState({tabs:[{id:'chat',type:'chat',title:'Chat'}],activeTabId:'chat',splitTabs:[],activeSplitTabId:null,isSplit:false});
  const terminal = store.getState().openTerminalTab();
  const desktop = store.getState().openDesktopTab();
  store.getState().openDesktopTab();
  assert.equal(store.getState().activeTabId, 'chat');
  assert.equal(store.getState().activeSplitTabId, desktop);
  assert.equal(store.getState().splitTabs.filter(tab=>tab.type==='desktop').length, 1);
  assert.ok(store.getState().splitTabs.some(tab=>tab.id===terminal));
  assert.ok(!session.get('nr_workspace_tabs').includes('preview_token'));
  store.getState().resetForWorkspace();
  assert.ok(!store.getState().splitTabs.some(tab=>tab.type==='desktop'));
});
test('browser opens only once on the right, preserves chat and terminal, and resets on workspace change', () => {
  const session = new Map();
  global.window = {sessionStorage:{getItem:key=>session.get(key)??null,setItem:(key,value)=>session.set(key,value),removeItem:key=>session.delete(key)}};
  const store = load('../src/stores/workspace-tabs.ts').default;
  store.setState({tabs:[{id:'chat',type:'chat',title:'Chat'}],activeTabId:'chat',splitTabs:[],activeSplitTabId:null,isSplit:false});
  const terminal = store.getState().openTerminalTab();
  const browser = store.getState().openBrowserTab();
  store.getState().openBrowserTab();
  assert.equal(store.getState().activeTabId,'chat');
  assert.equal(store.getState().activeSplitTabId,browser);
  assert.equal(store.getState().splitTabs.filter(tab=>tab.type==='browser').length,1);
  assert.ok(store.getState().splitTabs.some(tab=>tab.id===terminal));
  const persisted = session.get('nr_workspace_tabs');
  assert.ok(persisted.includes('browser'));
  assert.ok(!persisted.includes('_modal_connect_token'));
  store.getState().resetForWorkspace();
  assert.ok(!store.getState().splitTabs.some(tab=>tab.type==='browser'));
});
