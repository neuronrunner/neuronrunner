const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const storage = new Map();
global.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => {
    storage.set(key, value);
    global.localStorage[key] = value;
  },
  removeItem: key => {
    storage.delete(key);
    delete global.localStorage[key];
  },
  clear: () => {
    for (const key of storage.keys()) {
      delete global.localStorage[key];
    }
    storage.clear();
  },
};
global.window = {};

let postRequests = [];
let sidebarState = {
  isOpen: true,
  width: 310,
  conversations: [{ uuid: 'conv-1', title: 'Test Conv' }],
  generalConversations: [{ uuid: 'conv-1', title: 'Test Conv' }],
  projectConversations: {},
};

const mockAxios = {
  post: (url, body, options) => {
    postRequests.push({ url, body, options });
    return new Promise(resolve => setTimeout(() => resolve({ status: 200 }), 100));
  },
};

const mockSidebarStore = {
  getState: () => sidebarState,
  setState: (updater) => {
    if (typeof updater === 'function') {
      sidebarState = { ...sidebarState, ...updater(sidebarState) };
    } else {
      sidebarState = { ...sidebarState, ...updater };
    }
  },
};

const mockWorkspacesStore = {
  getState: () => ({
    resetWorkspaces: () => {},
  }),
};

const filename = path.resolve(__dirname, '../src/stores/auth.ts');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded.require = id => {
  if (id === '@/lib/env') return { env: { API_URL: 'http://test-api' } };
  if (id === '@/lib/attribution') return { readSignupAttribution: () => ({}), clearSignupAttribution: () => {} };
  if (id === '@/i18n') return { __esModule: true, default: { t: k => k } };
  if (id === 'axios') return { default: mockAxios, ...mockAxios };
  if (id === './sidebar' || id === '@/stores/sidebar') return { default: mockSidebarStore };
  if (id === './workspaces' || id === '@/stores/workspaces') return { default: mockWorkspacesStore };
  return Module.prototype.require.call(loaded, id);
};

loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, filename);

const useAuthStore = loaded.exports.default;

beforeEach(() => {
  localStorage.clear();
  postRequests = [];
  localStorage.setItem('token', 'fake-access-token');
  localStorage.setItem('refreshToken', 'fake-refresh-token');
  localStorage.setItem('user', JSON.stringify({ uuid: 'user-1', email: 'test@example.com' }));
  localStorage.setItem('nr_selected_vm:ws-1', 'vm-1');

  sidebarState = {
    isOpen: true,
    width: 310,
    conversations: [{ uuid: 'conv-1', title: 'Test Conv' }],
    generalConversations: [{ uuid: 'conv-1', title: 'Test Conv' }],
    projectConversations: {},
  };

  useAuthStore.setState({
    token: 'fake-access-token',
    refreshToken: 'fake-refresh-token',
    user: { uuid: 'user-1', email: 'test@example.com' },
  });
});

test('signOut is synchronous and instant: clears state and localStorage immediately without waiting for API', () => {
  const auth = useAuthStore.getState();

  // Call signOut synchronously
  auth.signOut();

  // Immediately (in the same tick), state and storage MUST be cleared
  assert.equal(useAuthStore.getState().user, null, 'user in state should be null');
  assert.equal(useAuthStore.getState().token, null, 'token in state should be null');
  assert.equal(useAuthStore.getState().refreshToken, null, 'refreshToken in state should be null');

  assert.equal(localStorage.getItem('token'), null, 'token in localStorage should be removed');
  assert.equal(localStorage.getItem('refreshToken'), null, 'refreshToken in localStorage should be removed');
  assert.equal(localStorage.getItem('user'), null, 'user in localStorage should be removed');
  assert.equal(localStorage.getItem('nr_selected_vm:ws-1'), null, 'vm storage in localStorage should be removed');
});

test('signOut closes the sidebar (isOpen becomes false)', async () => {
  assert.equal(sidebarState.isOpen, true);

  useAuthStore.getState().signOut();

  // Give any microtasks a chance to run
  await new Promise(resolve => setTimeout(resolve, 10));

  // Sidebar must be closed upon sign out
  assert.equal(sidebarState.isOpen, false, 'sidebarState.isOpen should be false after logout');
});

test('signOut fires backend logout in background with token and refresh token', async () => {
  useAuthStore.getState().signOut();

  assert.equal(postRequests.length, 1);
  assert.equal(postRequests[0].url, 'http://test-api/auth/logout/');
  assert.deepEqual(postRequests[0].body, { refresh: 'fake-refresh-token' });
  assert.equal(postRequests[0].options.headers.Authorization, 'Bearer fake-access-token');
});
