const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

function compile(file, requireImpl = () => ({})) {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/lib', file), 'utf8');
  const out = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}}).outputText;
  const context = {exports: {}, require: requireImpl, URL};
  vm.runInNewContext(out, context);
  return context.exports;
}

const {issueBranchName, buildIssueAgentPrompt} = compile('issue-prompt.ts');

function apiSetup() {
  const calls = [];
  const reply = (data) => async (url, ...rest) => {
    calls.push({url, rest});
    return {data};
  };
  const axios = {
    get: reply({issues: [], has_next: false, issue: {number: 3}, comments: []}),
    post: reply({issue: {number: 3}, comment: {id: 'c'}, imported: 2}),
    patch: reply({issue: {number: 3}}),
    delete: reply({}),
  };
  const api = compile('issues-api.ts', (id) => {
    if (id === '@/lib/env') return {env: {API_URL: 'http://backend:8000'}};
    if (id === '@/lib/axios') return {authedAxios: axios};
    return {};
  });
  return {api, calls};
}

test('branch names are slugged, bounded and stable for non-latin titles', () => {
  assert.equal(issueBranchName({number: 12, title: 'Fix login: crash on  save!'}), 'issue-12-fix-login-crash-on-save');
  assert.equal(issueBranchName({number: 4, title: 'Çökme sorunu düzelt'}), 'issue-4-cokme-sorunu-duzelt');
  assert.equal(issueBranchName({number: 5, title: '你好'}), 'issue-5');
  const long = issueBranchName({number: 9, title: 'a'.repeat(200)});
  assert.ok(long.length <= 'issue-9-'.length + 40);
  assert.ok(!long.endsWith('-'));
});

test('agent prompt carries the issue, trims discussion and tells the agent how to report back', () => {
  const comments = [
    {author: 'System', author_type: 'system', body: 'Assigned to an agent.'},
    ...Array.from({length: 12}, (_, i) => ({author: 'sam', author_type: 'user', body: `note ${i}`})),
  ];
  const prompt = buildIssueAgentPrompt(
    {number: 7, title: 'Slow search', body: 'Search takes 10s.', labels: [{name: 'perf'}]},
    comments,
    {branch: 'issue-7-slow-search', environmentName: 'api'}
  );
  assert.ok(prompt.startsWith('Work on issue #7: Slow search'));
  assert.match(prompt, /Environment: api/);
  assert.match(prompt, /Labels: perf/);
  assert.match(prompt, /Search takes 10s\./);
  assert.match(prompt, /`issue-7-slow-search`/);
  assert.match(prompt, /status to "in_review"/);
  assert.ok(!prompt.includes('Assigned to an agent.'), 'system comments are not discussion');
  assert.ok(!prompt.includes('note 0') && !prompt.includes('note 1\n') && prompt.includes('note 11'), 'only the latest comments are kept');
});

test('agent prompt copes with an empty issue and no branch', () => {
  const prompt = buildIssueAgentPrompt({number: 1, title: 'Empty', body: '  '}, []);
  assert.match(prompt, /\(no description\)/);
  assert.ok(!prompt.includes('## Discussion'));
  assert.ok(!prompt.includes('You are working on the branch'));
});

test('issues api targets the environment-scoped endpoints and only sends set filters', async () => {
  const {api, calls} = apiSetup();
  await api.listIssues('env-1', {state: 'open', q: '  crash ', page: 2});
  assert.equal(calls[0].url, 'http://backend:8000/issues/environments/env-1/');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].rest[0].params)), {state: 'open', q: 'crash', page: 2});

  await api.getIssue('env-1', 3);
  assert.equal(calls[1].url, 'http://backend:8000/issues/environments/env-1/3/');
  await api.listIssueComments('env-1', 3);
  assert.equal(calls[2].url, 'http://backend:8000/issues/environments/env-1/3/comments/');
  await api.assignIssueAgent('env-1', 3, {conversation_id: 'conv', branch: 'issue-3'});
  assert.equal(calls[3].url, 'http://backend:8000/issues/environments/env-1/3/assign-agent/');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[3].rest[0])), {conversation_id: 'conv', branch: 'issue-3'});
  await api.unassignIssueAgent('env-1', 3);
  assert.equal(calls[4].url, 'http://backend:8000/issues/environments/env-1/3/unassign-agent/');
  await api.importIssues('env-1', {provider: 'gitlab', state: 'all'});
  assert.equal(calls[5].url, 'http://backend:8000/issues/environments/env-1/import/');
});

test('issues errors prefer the server message and fall back otherwise', () => {
  const {api} = apiSetup();
  assert.equal(api.issuesError({response: {data: {error: 'Title is required.'}}}), 'Title is required.');
  assert.equal(api.issuesError({response: {data: {detail: 'Not found.'}}}), 'Not found.');
  assert.equal(api.issuesError(new Error('boom'), 'fallback'), 'fallback');
  assert.equal(api.issuesErrorCode({response: {data: {code: 'github_not_connected'}}}), 'github_not_connected');
});

test('list cache returns the last result per view, ignores empty keys and evicts the oldest entries', () => {
  const {readListCache, writeListCache, clearListCache} = compile('list-cache.ts');
  assert.equal(readListCache('issues:a:open:'), undefined);
  writeListCache('issues:a:open:', {issues: [1]});
  writeListCache('issues:a:open:', {issues: [1, 2]});
  assert.deepEqual(JSON.parse(JSON.stringify(readListCache('issues:a:open:'))), {issues: [1, 2]});
  writeListCache(null, {x: 1});
  assert.equal(readListCache(null), undefined);
  for (let i = 0; i < 120; i++) writeListCache(`k${i}`, i);
  assert.equal(readListCache('k0'), undefined, 'oldest entry is evicted past the cap');
  assert.equal(readListCache('k119'), 119);
  assert.equal(readListCache('issues:a:open:'), undefined);
  clearListCache();
  assert.equal(readListCache('k119'), undefined);
});
