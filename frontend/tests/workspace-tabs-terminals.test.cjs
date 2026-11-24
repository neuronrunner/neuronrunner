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

const chat = {id:'chat-default',type:'chat',title:'New Chat'};
const files = {id:'tab-files',type:'files',title:'Files'};
beforeEach(()=>store.setState({tabs:[chat],activeTabId:chat.id,splitTabs:[files],activeSplitTabId:files.id,isSplit:true,focusedPane:'right'}));
test('50 terminals have distinct identities and survive persistence and rehydration',()=>{
  const ids=Array.from({length:50},()=>store.getState().openTerminalTab(undefined,'right'));
  assert.equal(new Set(ids).size,50);
  assert.equal(store.getState().splitTabs.filter(t=>t.type==='terminal').length,50);
  assert.equal(store.getState().activeSplitTabId,ids[49]);
  const saved=JSON.parse(session.get('nr_workspace_tabs')).state;
  assert.equal(saved.splitTabs.filter(t=>t.type==='terminal').length,50);
  store.persist.rehydrate();
  assert.equal(store.getState().splitTabs.filter(t=>t.type==='terminal').length,50);
  assert.equal(store.getState().activeSplitTabId,ids[49]);
  assert.deepEqual(store.getState().splitTabs.filter(t=>t.type==='terminal').map(t=>t.title),Array.from({length:50},(_,i)=>'Terminal '+(i+1)));
});
test('closing many terminals preserves other sessions, selects a valid tab, then returns to Files',()=>{
  const ids=Array.from({length:30},()=>store.getState().openTerminalTab(undefined,'right'));
  store.getState().closeTab(ids[10]);
  assert.equal(store.getState().activeSplitTabId,ids[29]);
  store.getState().closeTab(ids[29]);
  assert.equal(store.getState().activeSplitTabId,ids[28]);
  for(const id of ids)store.getState().closeTab(id);
  assert.deepEqual(store.getState().splitTabs,[files]);
  assert.equal(store.getState().activeSplitTabId,files.id);
  assert.equal(store.getState().activeTabId,chat.id);
});
test('terminal numbering fills a closed gap without reusing a live identity',()=>{
  const ids=Array.from({length:12},()=>store.getState().openTerminalTab(undefined,'right'));
  store.getState().closeTab(ids[4]);
  const replacement=store.getState().openTerminalTab(undefined,'right');
  assert.ok(!ids.includes(replacement));
  assert.equal(store.getState().splitTabs.find(t=>t.id===replacement).title,'Terminal 5');
});
test('opening a terminal from Files uses the tools panel even when chat has focus',()=>{
  store.setState({focusedPane:'left'});
  const id=store.getState().openTerminalTab();
  assert.equal(store.getState().activeTabId,chat.id);
  assert.equal(store.getState().activeSplitTabId,id);
  assert.ok(store.getState().splitTabs.some(t=>t.id===id));
});
test('legacy terminals in the chat pane are restored into the tools panel without dropping sessions',()=>{
  const ids=Array.from({length:10},()=>store.getState().openTerminalTab(undefined,'left'));
  const right=store.getState().openTerminalTab(undefined,'right');
  store.setState({activeTabId:ids[9]});
  store.persist.rehydrate();
  assert.deepEqual(store.getState().tabs,[chat]);
  assert.equal(store.getState().splitTabs.filter(t=>t.type==='terminal').length,11);
  assert.equal(store.getState().activeTabId,chat.id);
  assert.equal(store.getState().activeSplitTabId,ids[9]);
  assert.ok(store.getState().splitTabs.some(t=>t.id===right));
});

test('Git opens one tools tab and preserves chat and terminal sessions through persistence',()=>{
  const terminal=store.getState().openTerminalTab();
  const git=store.getState().openGitTab();
  store.getState().openGitTab();
  assert.equal(store.getState().splitTabs.filter(t=>t.type==='git').length,1);
  assert.equal(store.getState().activeSplitTabId,git);
  assert.equal(store.getState().activeTabId,chat.id);
  assert.ok(store.getState().splitTabs.some(t=>t.id===terminal));
  store.persist.rehydrate();
  assert.equal(store.getState().activeSplitTabId,git);
  assert.equal(store.getState().splitTabs.filter(t=>t.type==='git').length,1);
});
test('workspace changes clear the Git view and preserve the workspace Files panel',()=>{
  store.getState().openGitTab();
  store.getState().resetForWorkspace();
  assert.equal(store.getState().splitTabs.some(t=>t.type==='git'),false);
  assert.equal(store.getState().activeSplitTabId,files.id);
  assert.deepEqual(store.getState().splitTabs,[files]);
});
