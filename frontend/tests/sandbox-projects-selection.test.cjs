const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const storage = new Map();
global.window = { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } };
const workspace = { uuid: 'workspace-one' };
const workspaceStore = { getState: () => ({ currentWorkspace: workspace, currentWorkspaceUuid: workspace.uuid }) };
const filesystem = { uuid: 'filesystem-one', workspace_uuid: workspace.uuid, filesystem_path: '/workspace' };
const project = { uuid: 'explicit-project', workspace_uuid: workspace.uuid, filesystem_path: '/workspace/app' };
const requests = [];
let projects = [];
let deleteError = false;
let getHandler;
let auth = { user: { uuid: 'user-one' }, token: 'test' };
const axios = {
  get: async (url, config) => {
    requests.push({ method: 'GET', url, config });
    if (getHandler) return getHandler(url, config);
    if (url.endsWith('/files/')) return { data: [] };
    return { data: { sandboxes: projects, workspace_sandbox: filesystem } };
  },
  post: async () => { throw new Error('Loading a workspace must not create or pick a project'); },
  delete: async url => {
    requests.push({ method: 'DELETE', url });
    if (deleteError) throw { response: { data: { detail: 'Project removal denied' } } };
  },
};
const filename = path.resolve(__dirname, '../src/stores/sandbox-projects.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded.require = id => {
  if (id === "@/lib/env") return { env: { API_URL: process.env.VITE_API_URL || "", GOOGLE_CLIENT_ID: "", ENABLE_STUDIO: false } };
  if (id === '@/lib/axios') return { authedAxios: axios };
  if (id === '@/i18n') return { __esModule: true, default: { t: k => k } };
  if (id === './workspaces') return { default: workspaceStore };
  if (id === './auth') return { default: { getState: () => auth } };
  return Module.prototype.require.call(loaded, id);
};
loaded._compile(compiled.outputText, filename);
const store = loaded.exports.default;
beforeEach(() => {
  projects = [];
  deleteError = false;
  getHandler = null;
  workspace.uuid = 'workspace-one';
  auth = { user: { uuid: 'user-one' }, token: 'test' };
  requests.length = 0;
  store.setState({ currentSandbox: null, workspaceSandbox: null, sandboxes: [], sandboxesLoadedFor: null, files: [], sandboxConversations: {}, errorMessage: null });
});

test('concurrent page, sidebar and Files loads share one request', async () => {
  let finish;
  getHandler = () => new Promise(resolve => { finish = resolve; });
  const loads = [store.getState().ensureSandboxes(), store.getState().ensureSandboxes(workspace.uuid), store.getState().fetchSandboxes(workspace.uuid)];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1);
  finish({ data: { sandboxes: [project], workspace_sandbox: filesystem } });
  assert.deepEqual(await Promise.all(loads), [[project], [project], [project]]);
  await store.getState().ensureSandboxes(workspace.uuid);
  assert.equal(requests.length, 1);
});

test('an empty successful list is reused without requesting the fallback', async () => {
  getHandler = async () => ({ data: { sandboxes: [], workspace_sandbox: null } });
  await store.getState().ensureSandboxes(workspace.uuid);
  await store.getState().ensureSandboxes(workspace.uuid);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith('/sandbox-tools/list/'));
});

test('explicit refresh loads newly added projects after initialization', async () => {
  await store.getState().ensureSandboxes(workspace.uuid);
  projects = [project];
  await store.getState().fetchSandboxes(workspace.uuid);
  assert.deepEqual(store.getState().sandboxes, [project]);
  assert.equal(requests.length, 2);
});

test('token rotation reuses initialized data but another user or workspace reloads it', async () => {
  await store.getState().ensureSandboxes(workspace.uuid);
  auth.token = 'refreshed';
  await store.getState().ensureSandboxes(workspace.uuid);
  assert.equal(requests.length, 1);
  auth.user.uuid = 'user-two';
  await store.getState().ensureSandboxes(workspace.uuid);
  assert.equal(requests.length, 2);
  workspace.uuid = 'workspace-two';
  await store.getState().ensureSandboxes(workspace.uuid);
  assert.equal(requests.length, 3);
  assert.equal(requests[2].config.params.workspace_uuid, 'workspace-two');
});

test('a failed primary request uses the fallback', async () => {
  getHandler = async url => {
    if (url.endsWith('/sandbox-tools/list/')) throw new Error('Unavailable');
    return { data: [project] };
  };
  await store.getState().ensureSandboxes(workspace.uuid);
  assert.deepEqual(store.getState().sandboxes, [project]);
  assert.equal(requests.length, 2);
});

test('a failed initialization is released so a later consumer can retry', async () => {
  getHandler = async () => { throw new Error('Offline'); };
  await store.getState().ensureSandboxes(workspace.uuid);
  assert.equal(store.getState().sandboxesLoadedFor, null);
  getHandler = null;
  await store.getState().ensureSandboxes(workspace.uuid);
  assert.equal(requests.length, 3);
  assert.equal(store.getState().errorMessage, null);
  assert.equal(store.getState().isLoading, false);
});

test('a late response from a previous workspace cannot overwrite the current list', async () => {
  let finish;
  getHandler = () => new Promise(resolve => { finish = resolve; });
  const previous = store.getState().fetchSandboxes(workspace.uuid);
  await new Promise(resolve => setImmediate(resolve));
  workspace.uuid = 'workspace-two';
  const current = { ...project, uuid: 'new-project', workspace_uuid: workspace.uuid };
  getHandler = async () => ({ data: { sandboxes: [current] } });
  await store.getState().fetchSandboxes(workspace.uuid);
  finish({ data: { sandboxes: [project] } });
  await previous;
  assert.deepEqual(store.getState().sandboxes, [current]);
});

test('an empty workspace loads Files without creating or selecting a default project', async () => {
  assert.deepEqual(await store.getState().fetchSandboxes(workspace.uuid), []);
  assert.equal(store.getState().currentSandbox, null);
  assert.deepEqual(store.getState().workspaceSandbox, filesystem);
  assert.deepEqual(store.getState().sandboxes, []);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].config.params.workspace_uuid, workspace.uuid);
  assert.equal(JSON.parse(storage.get('sandbox-projects-storage')).state.currentSandbox, null);
});

test('existing projects are listed without automatically selecting the first', async () => {
  projects = [project];
  await store.getState().fetchSandboxes(workspace.uuid);
  assert.deepEqual(store.getState().sandboxes, [project]);
  assert.equal(store.getState().currentSandbox, null);
});

test('an explicitly selected project survives a workspace refresh', async () => {
  projects = [project];
  store.setState({ currentSandbox: { ...project, display_name: 'Old name' } });
  await store.getState().fetchSandboxes(workspace.uuid);
  assert.deepEqual(store.getState().currentSandbox, project);
});

test('a persisted Files handle is removed from the selected project while Files stays available', async () => {
  store.setState({ currentSandbox: filesystem });
  await store.getState().fetchSandboxes(workspace.uuid);
  assert.equal(store.getState().currentSandbox, null);
  assert.deepEqual(store.getState().workspaceSandbox, filesystem);
});

test('a missing project is cleared without choosing a replacement', async () => {
  projects = [project];
  store.setState({ currentSandbox: { uuid: 'deleted-or-other-workspace-project' } });
  await store.getState().fetchSandboxes(workspace.uuid);
  assert.equal(store.getState().currentSandbox, null);
});

test('removing the selected project keeps workspace files and other projects', async () => {
  const sibling = { ...project, uuid: 'other-project' };
  const files = [{ uuid: 'tracked', path: '/workspace/app/tracked.txt' }];
  store.setState({ currentSandbox: project, workspaceSandbox: filesystem, sandboxes: [project, sibling], files, sandboxConversations: { [project.uuid]: ['chat-one'], [sibling.uuid]: ['chat-two'] } });
  assert.equal(await store.getState().deleteSandbox(project.uuid), true);
  assert.equal(store.getState().currentSandbox, null);
  assert.deepEqual(store.getState().workspaceSandbox, filesystem);
  assert.deepEqual(store.getState().files, files);
  assert.deepEqual(store.getState().sandboxes, [sibling]);
  assert.deepEqual(store.getState().sandboxConversations, { [sibling.uuid]: ['chat-two'] });
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith(`/sandboxes/${project.uuid}/`));
});

test('removing an inactive project preserves the selected project', async () => {
  const sibling = { ...project, uuid: 'other-project' };
  store.setState({ currentSandbox: project, sandboxes: [project, sibling] });
  assert.equal(await store.getState().deleteSandbox(sibling.uuid), true);
  assert.deepEqual(store.getState().currentSandbox, project);
});

test('a denied removal keeps the project and selection and reports the API error', async () => {
  deleteError = true;
  store.setState({ currentSandbox: project, sandboxes: [project] });
  assert.equal(await store.getState().deleteSandbox(project.uuid), false);
  assert.deepEqual(store.getState().currentSandbox, project);
  assert.deepEqual(store.getState().sandboxes, [project]);
  assert.equal(store.getState().errorMessage, 'Project removal denied');
  assert.equal(store.getState().isLoading, false);
});

function cloneResponse(chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  }));
}

test('a completed Files clone immediately lists its automatically registered project', async () => {
  projects = [project];
  store.setState({ workspaceSandbox: filesystem });
  let payload;
  global.fetch = async (url, options) => {
    assert.ok(url.endsWith(`/sandboxes/${filesystem.uuid}/git-clone/`));
    payload = JSON.parse(options.body);
    return cloneResponse(['Cloning...\n', '[Suc', 'cess] Repository cloned successfully into /workspace/app!\n']);
  };
  const progress = [];
  assert.equal(await store.getState().cloneRepository(filesystem.uuid, 'acme/app', text => progress.push(text)), true);
  assert.deepEqual(payload, { repo_url: 'acme/app' });
  assert.deepEqual(store.getState().sandboxes, [project]);
  assert.equal(store.getState().currentSandbox, null);
  assert.equal(store.getState().isLoading, false);
  assert.ok(progress.join('').includes('[Success]'));
  assert.deepEqual(requests.map(request => request.url.endsWith('/files/')), [false, true]);
});

test('a failed clone reports the error and leaves the project list unchanged', async () => {
  store.setState({ workspaceSandbox: filesystem });
  global.fetch = async () => cloneResponse(['fatal: repository not found\n', '[Error] Clone failed with exit code 128.\n']);
  await assert.rejects(store.getState().cloneRepository(filesystem.uuid, 'acme/missing'), /Clone failed with exit code 128/);
  assert.deepEqual(store.getState().sandboxes, []);
  assert.equal(store.getState().isLoading, false);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith('/files/'));
});
