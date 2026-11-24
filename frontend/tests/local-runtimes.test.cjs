const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const storage = new Map();
global.window = {
  localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  },
};

const calls = [];
let listing = { items: [], max_concurrent: 3, running: 0 };
let failNext = null;
const runtime = (name, status = 'running') => ({ uuid: name, name, container: `c-${name}`, status, created_at: null, is_default: name === 'default' });
const http = {
  async get(url) { calls.push(['get', url]); return { data: listing }; },
  async post(url, body) {
    calls.push(['post', url, body]);
    if (failNext) { const error = failNext; failNext = null; throw error; }
    if (body && body.name) listing = { ...listing, items: [...listing.items.filter(i => i.name !== body.name), runtime(body.name)], running: listing.running + 1 };
    return { data: listing };
  },
  async delete(url) {
    calls.push(['delete', url]);
    const name = decodeURIComponent(url.split('/').filter(Boolean).at(-1));
    listing = { ...listing, items: listing.items.filter(i => i.name !== name) };
    return { data: listing };
  },
};

function load(filename) {
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = id => {
    if (id === '@/lib/axios') return { authedAxios: http, API_BASE: 'http://api' };
    if (id === './RuntimePicker') return { __esModule: true, default: () => null };
    return Module.prototype.require.call(loaded, id);
  };
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, filename);
  return loaded.exports;
}

const extension = load(path.resolve(__dirname, '../src/extensions/noop/index.ts'));
const { useLocalRuntimesStore, normalizeRuntimeName } = extension;
const bridge = extension.default.runtimeBridge;

beforeEach(() => {
  calls.length = 0;
  storage.clear();
  listing = { items: [runtime('default')], max_concurrent: 3, running: 1 };
  useLocalRuntimesStore.setState({ workspaceUuid: null, items: [], selected: {}, supported: true, error: null, pending: null });
});

test('runtime names follow the backend rules', () => {
  assert.equal(normalizeRuntimeName(' API '), 'api');
  assert.equal(normalizeRuntimeName('worker-2'), 'worker-2');
  for (const bad of ['', '-api', 'api-', 'a b', 'a_b', 'x'.repeat(25)]) assert.equal(normalizeRuntimeName(bad), null, bad);
});

test('the default runtime sends no selection; a launched runtime becomes selected and is sent with requests', async () => {
  await bridge.fetchRuntimes('ws1');
  assert.deepEqual(calls[0], ['get', 'http://api/sandbox/workspaces/ws1/runtimes/']);
  assert.equal(bridge.getSelectedRuntimeUuid(), null);
  assert.deepEqual(bridge.getRequestHeaders('ws1'), {});

  assert.equal(await useLocalRuntimesStore.getState().launch('ws1', 'API'), true);
  assert.deepEqual(calls.at(-1), ['post', 'http://api/sandbox/workspaces/ws1/runtimes/', { name: 'api' }]);
  assert.equal(bridge.getSelectedRuntimeUuid(), 'api');
  assert.deepEqual(bridge.getRequestHeaders('ws1'), { 'X-Sandbox-Runtime': 'api' });
  assert.deepEqual(bridge.getRequestHeaders('ws2'), {});
  assert.equal(JSON.parse(storage.get('nr_selected_runtime')).ws1, 'api');

  useLocalRuntimesStore.getState().select('ws1', 'default');
  assert.equal(bridge.getSelectedRuntimeUuid(), null);
});

test('deleting the selected runtime falls back to the default one', async () => {
  await bridge.fetchRuntimes('ws1');
  await useLocalRuntimesStore.getState().launch('ws1', 'worker');
  assert.equal(await useLocalRuntimesStore.getState().stop('ws1', 'worker', { remove: true }), true);
  assert.deepEqual(calls.at(-1), ['delete', 'http://api/sandbox/workspaces/ws1/runtimes/worker/']);
  assert.equal(bridge.getSelectedRuntimeUuid(), null);
});

test('stopping posts to the stop endpoint and keeps the selection', async () => {
  await bridge.fetchRuntimes('ws1');
  await useLocalRuntimesStore.getState().launch('ws1', 'api');
  await useLocalRuntimesStore.getState().stop('ws1', 'api');
  assert.deepEqual(calls.at(-1), ['post', 'http://api/sandbox/workspaces/ws1/runtimes/api/stop/', undefined]);
  assert.equal(bridge.getSelectedRuntimeUuid(), 'api');
});

test('limit errors from the server are surfaced and keep the current selection', async () => {
  await bridge.fetchRuntimes('ws1');
  failNext = { response: { status: 409, data: { error: 'maximum is 3', code: 'runtime_limit_reached' } } };
  assert.equal(await useLocalRuntimesStore.getState().launch('ws1', 'extra'), false);
  assert.equal(useLocalRuntimesStore.getState().error, 'maximum is 3');
  assert.equal(bridge.getSelectedRuntimeUuid(), null);
});

test('invalid names are rejected before any request', async () => {
  await bridge.fetchRuntimes('ws1');
  const before = calls.length;
  assert.equal(await useLocalRuntimesStore.getState().launch('ws1', 'bad name'), false);
  assert.equal(calls.length, before);
});
