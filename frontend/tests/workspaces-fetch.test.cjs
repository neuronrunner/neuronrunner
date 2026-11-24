const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const storage = new Map();
global.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
let auth, handler;
const requests = [];
const enWorkspace = require('../src/locales/en/workspace.json');
const tWorkspace = (key, vars = {}) => {
  const pathKey = key.replace(/^workspace:/, '');
  const val = pathKey.split('.').reduce((acc, part) => acc?.[part], enWorkspace);
  if (typeof val !== 'string') return key;
  return val.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
};
const filename = path.resolve(__dirname, '../src/stores/workspaces.ts');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded.require = id => {
  if (id === '@/lib/env') return { env: { API_URL: '' } };
  if (id === '@/i18n') return { __esModule: true, default: { t: tWorkspace } };
  if (id === './auth') return { default: { getState: () => auth } };
  if (id === '@/lib/axios') return { authedAxios: { get: url => { requests.push(url); return handler(); } } };
  return Module.prototype.require.call(loaded, id);
};
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, filename);
const store = loaded.exports.default;
const workspace = { uuid: 'workspace-one' };

beforeEach(() => {
  auth = { user: { uuid: 'user-one' }, token: 'token-one' };
  handler = async () => ({ data: [workspace] });
  requests.length = 0;
  store.setState({ workspaces: [], currentWorkspace: null, currentWorkspaceUuid: null, isLoading: false, errorMessage: null });
});

test('concurrent workspace consumers share the pending response and keep the persisted selection', async () => {
  let finish;
  handler = () => new Promise(resolve => { finish = resolve; });
  store.setState({ currentWorkspaceUuid: workspace.uuid });
  const loads = [store.getState().fetchWorkspaces(), store.getState().fetchWorkspaces()];
  assert.equal(requests.length, 1);
  finish({ data: [{ uuid: 'other-workspace' }, workspace] });
  await Promise.all(loads);
  assert.deepEqual(store.getState().currentWorkspace, workspace);
  assert.equal(store.getState().isLoading, false);
});

test('a later refresh starts a new request', async () => {
  await store.getState().fetchWorkspaces();
  await store.getState().fetchWorkspaces();
  assert.equal(requests.length, 2);
});

test('a failed request is released so the next load can retry', async () => {
  handler = async () => { throw new Error('Offline'); };
  await store.getState().fetchWorkspaces();
  assert.equal(store.getState().errorMessage, 'Failed to load workspaces');
  handler = async () => ({ data: [workspace] });
  await store.getState().fetchWorkspaces();
  assert.equal(requests.length, 2);
  assert.equal(store.getState().errorMessage, null);
});

test('a new account gets its own request and the previous account cannot overwrite it', async () => {
  let finish;
  handler = () => new Promise(resolve => { finish = resolve; });
  const previous = store.getState().fetchWorkspaces();
  auth = { user: { uuid: 'user-two' }, token: 'token-two' };
  const current = { uuid: 'workspace-two' };
  handler = async () => ({ data: [current] });
  await store.getState().fetchWorkspaces();
  finish({ data: [workspace] });
  await previous;
  assert.equal(requests.length, 2);
  assert.deepEqual(store.getState().currentWorkspace, current);
});
