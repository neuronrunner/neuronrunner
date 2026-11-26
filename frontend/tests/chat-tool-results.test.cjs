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
let generate;
class FakeOpenAI {
  constructor() { this.chat = { completions: { create: () => generate() } }; }
}
function load(filename) {
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = id => {
  if (id === "@/lib/env") return { env: { API_URL: process.env.VITE_API_URL || "", GOOGLE_CLIENT_ID: "", ENABLE_STUDIO: false } };
    if (id === '@/lib/default-models') return { DEFAULT_MODELS: [], DEFAULT_PLATFORM_MODELS: [] };
    if (id === '@/components/ui/toaster') return { toaster: { create() {} } };
    if (id === '@/lib/axios') return { workspaceHeaders: () => ({ 'X-Workspace-ID': 'test-workspace' }) };
    if (id === '@/i18n') return { __esModule: true, default: { t: k => k } };
    if (id === 'openai') return { __esModule: true, default: FakeOpenAI };
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
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename);
  return loaded.exports;
}
const store = load(path.resolve(__dirname, '../src/stores/chat.ts')).default;
const conversation = 'test-conversation';
beforeEach(() => store.setState({ conversationId: conversation, conversationCache: {}, messages: [], currentMessage: null, isStreaming: false, isActivelyGenerating: false, generatingConversations: {}, selectedModelType: 'text', toolTimeouts: {}, abortController: null, fetchAbortController: null, requestId: 0, activeRequestId: null, error: null }));
const response = data => new Response(JSON.stringify({ conversation: { uuid: conversation, title: 'Test', messages: [], ...data } }), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('a stopped conversation overrides stale sidebar activity even without a previous local status', async () => {
  const sidebarConversation = { uuid: conversation, is_generating: true };
  global.fetch = async () => response({ active_request: null, messages: [
    { uuid: 'virtual-failed-request', role: 'assistant', content: 'Partial response', error: 'Request failed' },
  ] });
  await store.getState().fetchConversation(conversation);
  assert.equal(store.getState().generatingConversations[conversation], false);
  assert.equal(Boolean(store.getState().generatingConversations[conversation] ?? sidebarConversation.is_generating), false);
  assert.equal(store.getState().isStreaming, false);
  assert.equal(store.getState().messages[0].error, 'Request failed');
});

test('ending generation also stops cached streaming before switching back to the conversation', () => {
  store.setState({
    conversationId: 'other-conversation',
    generatingConversations: { [conversation]: true },
    conversationCache: { [conversation]: { messages: [{ role: 'user', content: 'Hello' }], isStreaming: true } },
  });
  store.getState().setConversationGenerating(conversation, false);
  store.getState().switchConversation(conversation);
  assert.equal(store.getState().generatingConversations[conversation], false);
  assert.equal(store.getState().conversationCache[conversation].isStreaming, false);
  assert.equal(store.getState().isStreaming, false);
});

test('a persisted failure for the active request stops a still-open local stream', async () => {
  const controller = new AbortController();
  store.setState({
    activeRequestId: 'active-request', abortController: controller,
    isActivelyGenerating: true, isStreaming: true,
    generatingConversations: { [conversation]: true },
    currentMessage: { role: 'assistant', content: 'Still streaming' },
  });
  global.fetch = async () => response({ active_request: null, messages: [
    { uuid: 'saved-partial', request_uuid: 'active-request', role: 'assistant', content: 'Saved partial', error: 'Request failed' },
  ] });
  await store.getState().fetchConversation(conversation);
  assert.equal(controller.signal.aborted, true);
  assert.equal(store.getState().generatingConversations[conversation], false);
  assert.equal(store.getState().isActivelyGenerating, false);
  assert.equal(store.getState().isStreaming, false);
  assert.equal(store.getState().currentMessage, null);
  assert.equal(store.getState().messages[0].content, 'Saved partial');
});

test('a failure from an earlier request does not stop a retry before its backend registration', async () => {
  const controller = new AbortController();
  store.setState({
    activeRequestId: 'retry-request', abortController: controller,
    isActivelyGenerating: true, isStreaming: true,
    generatingConversations: { [conversation]: true },
  });
  global.fetch = async () => response({ active_request: null, messages: [
    { uuid: 'old-partial', request_uuid: 'old-request', role: 'assistant', content: '', error: 'Earlier request failed' },
  ] });
  await store.getState().fetchConversation(conversation);
  assert.equal(controller.signal.aborted, false);
  assert.equal(store.getState().generatingConversations[conversation], true);
  assert.equal(store.getState().isActivelyGenerating, true);
  assert.equal(store.getState().isStreaming, true);
});

test('an older conversation fetch cannot restore activity after a newer fetch reports failure', async () => {
  let resolveOld;
  global.fetch = () => new Promise(resolve => { resolveOld = resolve; });
  const old = store.getState().fetchConversation(conversation);
  global.fetch = async () => response({ active_request: null });
  await store.getState().fetchConversation(conversation);
  resolveOld(response({ active_request: { uuid: 'old-request', status: 'processing' } }));
  await old;
  assert.equal(store.getState().generatingConversations[conversation], false);
  assert.equal(store.getState().activeRequestId, null);
});

test('a failed stream stops the sidebar and cached activity while retaining its partial output', async () => {
  generate = async function* () {
    yield { choices: [{ index: 0, delta: { content: 'Partial output' }, finish_reason: null }] };
    throw new Error('Request failed');
  };
  assert.equal(await store.getState().sendMessage('Run the request'), null);
  assert.equal(store.getState().generatingConversations[conversation], false);
  assert.equal(store.getState().conversationCache[conversation].isStreaming, false);
  assert.equal(store.getState().isStreaming, false);
  assert.equal(store.getState().messages.at(-1).error, 'Request failed');
  assert.equal(store.getState().messages.at(-1).content, 'Partial output');
});

test('loading persisted failures preserves error status and existing JSON without double encoding', async () => {
  global.fetch = async () => response({ messages: [{ uuid: 'assistant', role: 'assistant', content: 'Done', tool_calls: [
    { id: 'failed', function: { name: 'shell_exec', arguments: '{"command":"run"}' }, result: { exit_code: -15, stderr: 'killed' } },
    { id: 'serialized', function: { name: 'file_read', arguments: '{}' }, result: '{"error":"not found"}' },
    { id: 'empty', function: { name: 'shell_exec', arguments: '{}' }, result: '' },
  ] }] });
  await store.getState().fetchConversation(conversation);
  const calls = store.getState().messages[0].tool_calls;
  assert.deepEqual(calls.map(call => call.status), ['error', 'error', 'done']);
  assert.equal(calls[1].result, '{"error":"not found"}');
  assert.equal(calls[2].result, '');
});

test('polling normalizes raw backend tool calls and preserves failed and active states', async () => {
  global.fetch = async () => response({ active_request: { uuid: 'request', status: 'processing', model_type: 'text', tool_calls: [
    { id: 'failed', function: { name: 'shell_exec', arguments: '{"command":"run"}' }, result: { exit_code: -15, stderr: 'killed' } },
    { id: 'pending', function: { name: 'file_read', arguments: '{"path":"README"}' } },
  ] } });
  await store.getState().fetchConversation(conversation);
  const calls = store.getState().currentMessage.tool_calls;
  assert.deepEqual(calls.map(call => call.name), ['shell_exec', 'file_read']);
  assert.deepEqual(calls.map(call => call.status), ['error', 'calling']);
  assert.equal(calls[0].result, '{"exit_code":-15,"stderr":"killed"}');
  assert.equal(store.getState().isStreaming, true);
});

test('streamed failures show an error while generation continues and empty results finish normally', async () => {
  const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
  generate = async function* () {
    yield chunk({ tool_calls: [{ id: 'one', function: { name: 'shell_exec', arguments: '{"command":"run"}' } }] });
    yield chunk({ tool_calls: [{ id: 'one', result: { exit_code: -15, stderr: 'killed' } }] });
    assert.equal(store.getState().currentMessage.tool_calls[0].status, 'error');
    assert.equal(store.getState().isStreaming, true);
    yield chunk({ tool_calls: [{ id: 'two', function: { name: 'shell_exec', arguments: '{}' } }] });
    yield chunk({ tool_calls: [{ id: 'two', result: '' }] });
    assert.equal(store.getState().currentMessage.tool_calls[1].status, 'done');
    assert.equal(store.getState().isStreaming, true);
    yield chunk({}, 'stop');
  };
  assert.equal(await store.getState().sendMessage('Run tools'), conversation);
  const calls = store.getState().messages.at(-1).tool_calls;
  assert.deepEqual(calls.map(call => call.status), ['error', 'done']);
  assert.equal(calls[1].result, '');
  assert.equal(store.getState().isStreaming, false);
});
