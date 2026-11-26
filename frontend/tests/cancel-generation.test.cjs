const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

global.localStorage = { getItem: key => key === 'token' ? 'test-token' : null, setItem() {}, removeItem() {} };
global.window = { localStorage: global.localStorage };
const sidebar = { conversations: [], setConversationTitle() {}, moveConversationToTop() {} };
const projects = { currentSandbox: null, workspaceSandbox: null, linkConversationToSandbox() {}, fetchFiles() {} };

function load(filename) {
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = id => {
    if (id === "@/lib/env") return { env: { API_URL: "http://localhost:8000", GOOGLE_CLIENT_ID: "", ENABLE_STUDIO: false } };
    if (id === '@/lib/default-models') return { DEFAULT_MODELS: [], DEFAULT_PLATFORM_MODELS: [] };
    if (id === '@/components/ui/toaster') return { toaster: { create() {} } };
    if (id === '@/lib/axios') return { workspaceHeaders: () => ({ 'X-Workspace-ID': 'test-workspace' }) };
    if (id === '@/i18n') return { __esModule: true, default: { t: k => k } };
    if (id === 'openai') return { __esModule: true, default: class {} };
    if (id === './sidebar') return { __esModule: true, default: { getState: () => sidebar } };
    if (id === './sandbox-projects') return { __esModule: true, default: { getState: () => projects } };
    if (id === './workspace-tabs') return { __esModule: true, default: { getState: () => ({ openChatTab() {} }) } };
    if (id === './vms') return { __esModule: true, default: { getState: () => ({ selectedVMUuid: null }) } };
    if (id === './search-models') return { __esModule: true, default: { getState: () => ({ models: [] }) } };
    if (id === './recent-models') return { __esModule: true, default: { getState: () => ({ recentModels: [] }) } };
    if (id === '@/stores/chat-branch') return { useChatBranchStore: { getState: () => ({ pending: null, setPending() {} }) } };
    if (id === '@/lib/reasoning') return load(path.resolve(__dirname, '../src/lib/reasoning.ts'));
    if (id === '@cloud') return load(path.resolve(__dirname, '../src/extensions/noop/index.ts'));
    if (id.startsWith('@/components/chat/')) return load(path.resolve(__dirname, '../src/components/chat/', id.split('/').at(-1) + '.ts'));
    return Module.prototype.require.call(loaded, id);
  };
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  }).outputText, filename);
  return loaded.exports;
}

const store = load(path.resolve(__dirname, '../src/stores/chat.ts')).default;
const conversationId = 'conv-123';

beforeEach(() => {
  store.setState({
    conversationId,
    conversationCache: {
      [conversationId]: {
        messages: [],
        currentMessage: null,
        activeRequestId: 'req-456',
        activeRequestParentId: null,
        activeRequestModelType: null,
        isStreaming: true,
        selectedMessage: null,
        updatedAt: Date.now(),
      }
    },
    messages: [],
    currentMessage: { role: 'assistant', content: 'Partial text...', type: 'text' },
    isStreaming: true,
    isActivelyGenerating: true,
    generatingConversations: { [conversationId]: true },
    selectedModelType: 'text',
    toolTimeouts: {},
    abortController: new AbortController(),
    fetchAbortController: null,
    requestId: 0,
    activeRequestId: 'req-456',
    error: null,
  });
});

test('cancelGeneration aborts controller immediately and calls cancel endpoints', async () => {
  const controller = store.getState().abortController;
  assert.equal(controller.signal.aborted, false);

  const fetchCalls = [];
  global.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    if (url.includes('/conversations/')) {
      return new Response(JSON.stringify({
        conversation: {
          uuid: conversationId,
          title: 'Test',
          messages: [{ uuid: 'msg-1', role: 'assistant', content: 'Stopped content' }],
          requests: [{ uuid: 'req-456', status: 'canceled' }]
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ message: 'Generation canceled' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const cancelResult = await store.getState().cancelGeneration();
  assert.equal(cancelResult, true);

  // Controller must be aborted
  assert.equal(controller.signal.aborted, true);

  // State must reflect generation stopped
  assert.equal(store.getState().isStreaming, false);
  assert.equal(store.getState().isActivelyGenerating, false);
  assert.equal(store.getState().abortController, null);
  assert.equal(store.getState().activeRequestId, null);
  assert.equal(store.getState().generatingConversations[conversationId], false);

  // Backend cancel requests must have been sent
  const cancelReqUrl = fetchCalls.find(c => c.url === 'http://localhost:8000/requests/req-456/cancel/');
  assert.ok(cancelReqUrl, 'Expected request cancel endpoint to be called');
  assert.equal(cancelReqUrl.options.method, 'POST');
  assert.equal(cancelReqUrl.options.headers['Authorization'], 'Bearer test-token');
  assert.equal(cancelReqUrl.options.headers['X-Workspace-ID'], 'test-workspace');

  const cancelConvUrl = fetchCalls.find(c => c.url === `http://localhost:8000/conversations/${conversationId}/cancel/`);
  assert.ok(cancelConvUrl, 'Expected conversation cancel endpoint to be called');
  assert.equal(cancelConvUrl.options.method, 'POST');
});

test('cancelGeneration preserves partial generation in messages even if backend fetch does not have it yet', async () => {
  store.setState({
    currentMessage: { role: 'assistant', content: 'Generation up to this point', type: 'text', parent: 'user-1' },
    messages: [{ uuid: 'user-1', role: 'user', content: 'Hello' }],
    isStreaming: true,
  });

  global.fetch = async () => new Response(JSON.stringify({
    conversation: {
      uuid: conversationId,
      messages: [{ uuid: 'user-1', role: 'user', content: 'Hello' }],
      requests: []
    }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  await store.getState().cancelGeneration();

  const msgs = store.getState().messages;
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].content, 'Generation up to this point');
});

test('stopStreaming stops stream and resets active generation flag while preserving partial content', () => {
  const controller = store.getState().abortController;
  store.getState().stopStreaming();

  assert.equal(controller.signal.aborted, true);
  assert.equal(store.getState().isStreaming, false);
  assert.equal(store.getState().isActivelyGenerating, false);
  assert.equal(store.getState().abortController, null);

  const msgs = store.getState().messages;
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].content, 'Partial text...');
});
