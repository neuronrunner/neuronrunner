const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
global.window = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
global.localStorage = window.localStorage;
let projects = [];
let links = {};
let requests = [];
let handler;
let tabs = [];
const client = {
  get: async (url, config) => { requests.push({ url, config }); return handler(url, config); },
  patch: async () => ({}),
  delete: async () => ({}),
};
const filename = path.resolve(__dirname, '../src/stores/sidebar.ts');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded.require = id => {
  if (id === "@/lib/env") return { env: { API_URL: process.env.VITE_API_URL || "", GOOGLE_CLIENT_ID: "", ENABLE_STUDIO: false } };
  if (id === 'axios') return { __esModule: true, default: client };
  if (id === '@/lib/axios') return { authedAxios: client };
  if (id === './workspace-tabs') return { default: { getState: () => ({ updateChatTabTitle() {}, tabs, splitTabs: [] }) } };
  if (id === './sandbox-projects') return { default: { getState: () => ({ sandboxes: projects, sandboxConversations: links }) } };
  return Module.prototype.require.call(loaded, id);
};
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
const store = loaded.exports.default;
const chat = (uuid, title = uuid) => ({ uuid, title });
beforeEach(() => {
  requests = []; projects = []; links = {}; tabs = [];
  handler = async () => ({ data: { conversations: [], has_next: false } });
  store.setState({ conversations: [], projectConversations: {}, generalConversations: [], generalHistoryProjectId: null, isLoading: false, isLoadingMore: false, hasMore: true, offset: 0, abortController: null, requestId: 0, conversationProjectId: null, isHistoryLoading: false, isHistoryLoadingMore: false, historyHasMore: false, historyOffset: 0, historyRequestId: 0, historyAbortController: null });
});

test('general History uses the shared root and never the selected project', async () => {
  projects = [{ uuid: 'project' }];
  store.setState({ conversationProjectId: 'project' });
  handler = async () => ({ data: { conversations: [chat('general')], has_next: true, next_offset: 20 } });
  await store.getState().fetchGeneralConversations(false, 'root');
  assert.deepEqual(requests[0].config.params, { project_uuid: 'root', general_only: true, limit: 20, offset: 0 });
  assert.equal(store.getState().generalHistoryProjectId, 'root');
  assert.equal(store.getState().conversationProjectId, 'project');
  await store.getState().fetchGeneralConversations(true);
  assert.equal(requests[1].config.params.offset, 20);
  assert.equal(requests[1].config.params.project_uuid, 'root');
});

test('loading another project keeps general History and earlier project conversations', async () => {
  store.setState({ generalConversations: [chat('general')], generalHistoryProjectId: 'root' });
  handler = async (_, config) => ({ data: { conversations: [chat(config.params.project_uuid)], has_next: false } });
  await store.getState().fetchConversations(false, 'first-project');
  await store.getState().fetchConversations(false, 'second-project');
  assert.deepEqual(store.getState().generalConversations, [chat('general')]);
  assert.deepEqual(store.getState().projectConversations['first-project'], [chat('first-project')]);
  assert.deepEqual(store.getState().projectConversations['second-project'], [chat('second-project')]);
});

test('live titles put root chats in History and project chats in their project', () => {
  store.setState({ generalHistoryProjectId: 'root' });
  links = { root: ['general', 'assigned'], project: ['assigned'] };
  projects = [{ uuid: 'project', conversation: 'assigned' }];
  store.getState().setConversationTitle('general', 'General title');
  store.getState().setConversationTitle('assigned', 'Project title');
  assert.deepEqual(store.getState().generalConversations, [chat('general', 'General title')]);
  assert.deepEqual(store.getState().projectConversations.project, [chat('assigned', 'Project title')]);
  store.getState().setConversationTitle('assigned', 'Final title');
  assert.equal(store.getState().projectConversations.project[0].title, 'Final title');
});

test('a title update respects legacy project links and removes a newly assigned chat from History', () => {
  store.setState({ generalHistoryProjectId: 'root', generalConversations: [chat('assigned')] });
  projects = [{ uuid: 'legacy', conversation: 'assigned' }];
  store.getState().setConversationTitle('assigned', 'Assigned title');
  assert.deepEqual(store.getState().generalConversations, []);
  assert.equal(store.getState().projectConversations.legacy[0].uuid, 'assigned');
});

test('renaming and deleting update History and every project cache', async () => {
  store.setState({ conversations: [chat('shared')], generalConversations: [chat('shared')], projectConversations: { first: [chat('shared')], second: [chat('shared')] } });
  await store.getState().renameConversation('shared', 'Renamed');
  assert.equal(store.getState().generalConversations[0].title, 'Renamed');
  assert.equal(store.getState().projectConversations.second[0].title, 'Renamed');
  await store.getState().deleteConversation('shared');
  assert.deepEqual(store.getState().generalConversations, []);
  assert.deepEqual(store.getState().projectConversations, { first: [], second: [] });
});

test('a late previous-workspace response cannot replace the current History', async () => {
  let finishPrevious;
  handler = async (_, config) => config.params.project_uuid === 'previous-root'
    ? new Promise(resolve => { finishPrevious = resolve; })
    : { data: { conversations: [chat('current')], has_next: false } };
  const previous = store.getState().fetchGeneralConversations(false, 'previous-root');
  await store.getState().fetchGeneralConversations(false, 'current-root');
  assert.equal(requests[0].config.signal.aborted, true);
  finishPrevious({ data: { conversations: [chat('previous')], has_next: true } });
  await previous;
  assert.equal(store.getState().generalHistoryProjectId, 'current-root');
  assert.deepEqual(store.getState().generalConversations, [chat('current')]);
  assert.equal(store.getState().isHistoryLoading, false);
});

test('opening or updating the title of an existing chat preserves its position everywhere', () => {
  projects = [{ uuid: 'project', conversation: 'older' }];
  links = { project: ['newer', 'older'] };
  store.setState({
    conversations: [chat('newer'), chat('older')],
    projectConversations: { project: [chat('newer'), chat('older')] },
  });
  store.getState().setConversationTitle('older', 'Opened title', { insertIfMissing: false });
  assert.deepEqual(store.getState().conversations.map(c => c.uuid), ['newer', 'older']);
  assert.deepEqual(store.getState().projectConversations.project.map(c => c.uuid), ['newer', 'older']);
  assert.equal(store.getState().projectConversations.project[1].title, 'Opened title');

  projects = []; links = { root: ['newer', 'older'] };
  store.setState({ generalHistoryProjectId: 'root', generalConversations: [chat('newer'), chat('older')] });
  store.getState().setConversationTitle('older', 'Final title');
  assert.deepEqual(store.getState().generalConversations.map(c => c.uuid), ['newer', 'older']);
  assert.equal(store.getState().generalConversations[1].title, 'Final title');
});

test('opening a conversation beyond the loaded page does not insert it at the top', () => {
  projects = [{ uuid: 'project', conversation: 'not-loaded' }];
  links = { root: ['not-loaded'] };
  store.setState({
    conversations: [chat('loaded')], generalHistoryProjectId: 'root',
    generalConversations: [chat('loaded')], projectConversations: { project: [chat('loaded')] },
  });
  store.getState().setConversationTitle('not-loaded', 'Old chat', { insertIfMissing: false });
  assert.deepEqual(store.getState().conversations, [chat('loaded')]);
  assert.deepEqual(store.getState().projectConversations.project, [chat('loaded')]);
  assert.deepEqual(store.getState().generalConversations, [chat('loaded')]);
});

test('sending a message moves the conversation to the top without losing metadata or duplicating it', () => {
  const older = { ...chat('older'), can_edit: false, is_generating: true };
  store.setState({
    conversations: [chat('newer'), older, chat('oldest')],
    generalConversations: [chat('newer'), older, chat('oldest')],
    projectConversations: { first: [chat('newer'), older], second: [chat('unrelated')] },
  });
  store.getState().moveConversationToTop('older');
  assert.deepEqual(store.getState().conversations.map(c => c.uuid), ['older', 'newer', 'oldest']);
  assert.deepEqual(store.getState().generalConversations.map(c => c.uuid), ['older', 'newer', 'oldest']);
  assert.deepEqual(store.getState().projectConversations.first, [older, chat('newer')]);
  assert.deepEqual(store.getState().projectConversations.second, [chat('unrelated')]);
  assert.equal(store.getState().generalConversations[0].can_edit, false);
  store.getState().moveConversationToTop('older');
  assert.equal(store.getState().generalConversations.filter(c => c.uuid === 'older').length, 1);
  store.getState().moveConversationToTop('missing');
  assert.equal(store.getState().generalConversations.length, 3);
});

test('a delayed reply title cannot reorder a chat above a more recent send', () => {
  store.setState({ generalHistoryProjectId: 'root', generalConversations: [chat('first'), chat('second')] });
  links = { root: ['first', 'second'] };
  store.getState().moveConversationToTop('first');
  store.getState().moveConversationToTop('second');
  store.getState().setConversationTitle('first', 'Delayed final title');
  assert.deepEqual(store.getState().generalConversations.map(c => c.uuid), ['second', 'first']);
  assert.equal(store.getState().generalConversations[1].title, 'Delayed final title');
});

test('sending to an opened chat beyond the loaded page inserts it using the fetched tab title', () => {
  links = { root: ['loaded', 'not-loaded'] };
  tabs = [{ type: 'chat', conversationUuid: 'not-loaded', title: 'Older chat title' }];
  store.setState({ generalHistoryProjectId: 'root', generalConversations: [chat('loaded')] });
  store.getState().setConversationTitle('not-loaded', 'Older chat title', { insertIfMissing: false });
  assert.deepEqual(store.getState().generalConversations, [chat('loaded')]);
  store.getState().moveConversationToTop('not-loaded');
  assert.deepEqual(store.getState().generalConversations, [chat('not-loaded', 'Older chat title'), chat('loaded')]);
});
