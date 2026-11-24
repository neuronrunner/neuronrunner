const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
global.window = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
const requests = [];
let uploadError = false;
let listedFiles = [];
let listError = false;
let deleteError = false;
const root = { uuid: 'workspace-root', workspace_uuid: 'workspace-one', filesystem_path: '/workspace' };
const axios = {
  get: async url => { requests.push({ method: 'GET', url }); if (listError) throw new Error('Verification unavailable'); return { data: listedFiles }; },
  delete: async url => { requests.push({ method: 'DELETE', url }); if (deleteError) throw { response: { data: { error: 'Permission denied' } } }; return { status: 204 }; },
  post: async (url, body, config) => {
    requests.push({ method: 'POST', url, body });
    if (url.endsWith('/upload/')) {
      config.onUploadProgress({ loaded: 25, total: 100 });
      config.onUploadProgress({ loaded: 100, total: 100 });
      if (uploadError) throw { response: { data: { error: 'Upload rejected' } } };
      return { data: { path: body.get('filename') } };
    }
    return { data: { success: true } };
  },
};
const enWorkspace = require('../src/locales/en/workspace.json');
const tWorkspace = (key, vars = {}) => {
  const pathKey = key.replace(/^workspace:/, '');
  const val = pathKey.split('.').reduce((acc, part) => acc?.[part], enWorkspace);
  if (typeof val !== 'string') return key;
  return val.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
};
const filename = path.resolve(__dirname, '../src/stores/sandbox-projects.ts');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded.require = id => {
  if (id === "@/lib/env") return { env: { API_URL: process.env.VITE_API_URL || "", GOOGLE_CLIENT_ID: "", ENABLE_STUDIO: false } };
  if (id === '@/lib/axios') return { authedAxios: axios };
  if (id === '@/i18n') return { __esModule: true, default: { t: tWorkspace } };
  if (id === './auth') return { default: { getState: () => ({ token: 'test' }) } };
  if (id === './workspaces') return { default: { getState: () => ({ currentWorkspaceUuid: 'workspace-one' }) } };
  return Module.prototype.require.call(loaded, id);
};
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
const store = loaded.exports.default;
beforeEach(() => { requests.length = 0; uploadError = false; listedFiles = []; listError = false; deleteError = false; store.setState({ workspaceSandbox: root, files: [], isUploading: false, isLoading: false, openTabs: {}, errorMessage: null }); });

test('batch file/folder writes preserve paths and transfer progress and defer tree refresh', async () => {
  const progress = [];
  const file = new File(['hello'], 'hello.py');
  assert.equal(await store.getState().createFileOrFolder(root.uuid, '/workspace/app/empty', true, { refresh: false }), true);
  await store.getState().uploadFile(root.uuid, file, '/workspace/app/src/hello.py', { refresh: false, onProgress: value => progress.push(value) });
  await store.getState().uploadFile(root.uuid, file, '/workspace/app/hello.py', { refresh: false });
  assert.deepEqual(progress, [0.25, 1]);
  assert.equal(requests.filter(request => request.method === 'GET').length, 0);
  assert.equal(requests[1].body.get('filename'), '/workspace/app/src/hello.py');
  assert.equal(requests[1].body.get('file').name, 'hello.py');
  assert.equal(store.getState().isUploading, false);
  await store.getState().fetchFiles(root.uuid);
  assert.equal(requests.filter(request => request.method === 'GET').length, 1);
  assert.ok(requests.at(-1).url.includes(root.uuid));
});

test('existing callers still refresh after an individual upload or folder creation', async () => {
  await store.getState().uploadFile(root.uuid, new File(['hello'], 'hello.py'));
  await store.getState().createFileOrFolder(root.uuid, '/workspace/empty', true);
  assert.equal(requests.filter(request => request.method === 'GET').length, 2);
});

test('a failed upload clears the uploading state and reports the server error without refreshing', async () => {
  uploadError = true;
  assert.equal(await store.getState().uploadFile(root.uuid, new File(['hello'], 'hello.py'), undefined, { refresh: false }), null);
  assert.equal(store.getState().isUploading, false);
  assert.equal(store.getState().errorMessage, 'Upload rejected');
  assert.equal(requests.filter(request => request.method === 'GET').length, 0);
});

const folder = { uuid: 'folder', path: '/workspace/folder', is_directory: true };
const child = { uuid: 'child', path: '/workspace/folder/hello.py', is_directory: false };
const sibling = { uuid: 'sibling', path: '/workspace/folder-other/keep.py', is_directory: false };
test('a 204 response with the folder still listed is a failed deletion', async () => {
  listedFiles = [folder, child, sibling];
  store.setState({ files: listedFiles });
  assert.equal(await store.getState().deleteFile(root.uuid, folder.path), false);
  assert.match(store.getState().errorMessage, /still exists/);
  assert.deepEqual(store.getState().files, listedFiles);
  assert.equal(store.getState().isLoading, false);
});
test('remaining descendants prevent success even if the explicit directory row disappears', async () => {
  listedFiles = [child, sibling];
  assert.equal(await store.getState().deleteFile(root.uuid, folder.path), false);
  assert.match(store.getState().errorMessage, /still exists/);
});
test('a verified deletion refreshes atomically and preserves similarly named siblings', async () => {
  store.setState({ files: [folder, child, sibling] });
  listedFiles = [sibling];
  assert.equal(await store.getState().deleteFile(root.uuid, folder.path), true);
  assert.deepEqual(store.getState().files, [sibling]);
  assert.deepEqual(requests.map(request => request.method), ['DELETE', 'GET']);
});
test('verification and server deletion failures never close existing editors', async () => {
  store.setState({ files: [child], openTabs: { child: { file: child } }, activeTabUuid: 'child' });
  listError = true;
  assert.equal(await store.getState().deleteFile(root.uuid, child.path), false);
  assert.ok(store.getState().openTabs.child);
  assert.match(store.getState().errorMessage, /Verification unavailable/);
  listError = false; deleteError = true;
  assert.equal(await store.getState().deleteFile(root.uuid, child.path), false);
  assert.ok(store.getState().openTabs.child);
  assert.equal(store.getState().errorMessage, 'Permission denied');
});
test('Unicode paths use UTF-8 URL-safe IDs understood by the backend', async () => {
  const filepath = '/workspace/çalışma-資料';
  assert.equal(await store.getState().deleteFile(root.uuid, filepath), true);
  const encoded = requests[0].url.split('/').filter(Boolean).at(-1);
  assert.equal(Buffer.from(encoded, 'base64url').toString('utf8'), filepath);
  assert.ok(!/[+/]/.test(encoded));
});

test('an old listing cannot resurrect a folder after verified deletion', async () => {
  const originalGet = axios.get;
  let resolveOld;
  axios.get = () => new Promise(resolve => { resolveOld = resolve; });
  const staleListing = store.getState().fetchFiles(root.uuid);
  axios.get = originalGet;
  listedFiles = [sibling];
  assert.equal(await store.getState().deleteFile(root.uuid, folder.path), true);
  resolveOld({ data: [folder, child, sibling] });
  await staleListing;
  assert.deepEqual(store.getState().files, [sibling]);
});

test('partial deletion refreshes the actual tree and retains the storage error', async () => {
  store.setState({ files: [folder, child, sibling] });
  listedFiles = [sibling]; deleteError = true;
  assert.equal(await store.getState().deleteFile(root.uuid, folder.path), false);
  assert.deepEqual(store.getState().files, [sibling]);
  assert.equal(store.getState().errorMessage, 'Permission denied');
});
