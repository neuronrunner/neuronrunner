const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');

function mountTerminal(t, postTicket) {
  const effects = [], refs = [], terminals = [], sockets = [], requests = [], states = [];
  const globals = ['WebSocket', 'document', 'requestAnimationFrame', 'ResizeObserver'];
  const previous = Object.fromEntries(globals.map(key => [key, global[key]]));
  global.document = { activeElement: null };
  global.requestAnimationFrame = callback => { callback(); return 1; };
  global.ResizeObserver = class { observe() {} disconnect() {} };
  class FakeSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    open(ready = true) { this.readyState = 1; this.onopen?.(); if (ready) this.message({ type: 'ready' }); }
    close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
    message(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
  }
  global.WebSocket = FakeSocket;
  class FakeTerminal {
    constructor() { this.cols = 80; this.rows = 24; this.output = []; terminals.push(this); }
    loadAddon() {} open() {} focus() {} clear() {}
    dispose() { this.disposed = true; }
    writeln(data) { this.output.push(data); }
    write(data) { this.output.push(data); }
    attachCustomKeyEventHandler(handler) { this.keyHandler = handler; }
    onData(handler) { (this.dataHandlers ??= []).push(handler); }
    key(key, repeat = false) {
      const event = { type: 'keydown', key, repeat, preventDefault() { this.defaultPrevented = true; } };
      if (this.keyHandler(event)) this.dataHandlers?.forEach(handler => handler(key));
      return event;
    }
  }
  const react = {
    ...React, memo: component => component,
    useRef: value => { const ref = { current: value }; refs.push(ref); return ref; },
    useState: value => [value, next => states.push(next)],
    useEffect: effect => effects.push(effect),
    useCallback: callback => callback,
  };
  const tabs = { tabs: [], splitTabs: [], setActiveTab() {}, setActiveSplitTab() {}, openTerminalTab() {}, closeTab() {} };
  const filename = path.resolve(__dirname, '../src/components/workspace-tabs/views/TerminalTabView.tsx');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = id => {
    if (id === "@/lib/env") return { env: { API_URL: process.env.VITE_API_URL || "", GOOGLE_CLIENT_ID: "", ENABLE_STUDIO: false } };
    if (id === 'react') return react;
    if (id === 'react-i18next') return { useTranslation: () => ({ t: tWorkspace, i18n: { resolvedLanguage: 'en' } }) };
    if (id === '@/i18n') return { __esModule: true, default: { t: tWorkspace } };
    if (id === 'next-themes') return { useTheme: () => ({ resolvedTheme: 'dark' }) };
    if (id === '@xterm/xterm') return { Terminal: FakeTerminal };
    if (id === '@xterm/addon-fit') return { FitAddon: class { fit() {} } };
    if (id === '@/stores/workspace-tabs') return { __esModule: true, default: selector => selector(tabs) };
    if (id === '@/stores/sandbox-projects') return { __esModule: true, default: selector => selector({ workspaceSandbox: { uuid: 'workspace-one' } }) };
    if (id === '@/stores/auth') return { __esModule: true, default: selector => selector({ token: 'access-token' }) };
    if (id === '@/lib/utils') return { cn: () => '' };
    if (id === '@/lib/axios') return { authedAxios: { post: async (...args) => {
      requests.push(args);
      return postTicket ? postTicket(requests.length) : { data: { ticket: `ticket-${requests.length}` } };
    } } };
    if (id === 'react-icons/lu' || id === '@/components/ui/dropdown-menu') return new Proxy({}, { get: () => () => null });
    return Module.prototype.require.call(loaded, id);
  };
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, filename);
  const tree = loaded.exports.default({ tab: { id: 'terminal-one', title: 'Terminal', type: 'terminal' } });
  function reconnectFromMenu(node = tree) {
    if (!node?.props) return false;
    if (node.props.title === 'Reconnect') { node.props.onSelect(); return true; }
    return React.Children.toArray(node.props.children).some(child => reconnectFromMenu(child));
  }
  // The third ref is the terminal viewport attached by React before effects.
  refs[2].current = { clientWidth: 800, offsetParent: {} };
  const cleanups = effects.map(effect => effect()).filter(cleanup => typeof cleanup === 'function');
  let cleaned = false;
  function unmount() {
    if (cleaned) return;
    cleaned = true;
    cleanups.reverse().forEach(cleanup => cleanup());
  }
  t.after(() => {
    unmount();
    for (const key of globals) {
      if (previous[key] === undefined) delete global[key];
      else global[key] = previous[key];
    }
  });
  return { terminals, sockets, requests, states, unmount, reconnectFromMenu };
}

const enWorkspace = require('../src/locales/en/workspace.json');
const tWorkspace = (key, vars = {}) => {
  const pathKey = key.replace(/^workspace:/, '');
  const val = pathKey.split('.').reduce((acc, part) => acc?.[part], enWorkspace);
  if (typeof val !== 'string') return key;
  return val.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
};
const settle = () => new Promise(resolve => setImmediate(resolve));

function openDirect(h) {
  const control = h.sockets.at(-1);
  control.open(false);
  control.message({ type: 'direct', url: 'wss://vm.example.com/terminal', ticket: 'vm-ticket', session: 'session-1', expires_in: 10 });
  const direct = h.sockets.at(-1);
  direct.open(false);
  return { control, direct };
}

function proveDirect(control, direct) {
  direct.message({ type: 'challenge', challenge: 'a'.repeat(43), session: 'session-1' });
  control.message({ type: 'consumed', receipt: 'signed-consumption-receipt', session: 'session-1' });
  direct.message({ type: 'ready' });
}

test('direct terminal consumes a socket-bound ticket then releases the backend connection', async t => {
  const h = mountTerminal(t);
  await settle();
  const { control, direct } = openDirect(h);
  assert.equal(direct.url, 'wss://vm.example.com/terminal');
  assert.equal(direct.binaryType, 'arraybuffer');
  assert.ok(!direct.url.includes('ticket') && !direct.url.includes('access-token'));
  assert.deepEqual(direct.sent, [{ type: 'auth', ticket: 'vm-ticket' }]);
  h.terminals[0].key('x');
  assert.equal(direct.sent.length, 1);
  proveDirect(control, direct);
  assert.deepEqual(control.sent, [{ type: 'auth', ticket: 'ticket-1' }, { type: 'consume', challenge: 'a'.repeat(43) }]);
  assert.equal(control.readyState, 3);
  assert.equal(h.states.at(-1), 'connected');
  h.terminals[0].key('echo direct\r');
  assert.deepEqual(direct.sent.at(-1), { type: 'input', data: 'echo direct\r' });
  assert.ok(direct.sent.some(message => message.type === 'proof'));
  const output = new TextEncoder().encode('doğrudan çıktı');
  direct.onmessage({ data: output.buffer });
  assert.deepEqual(h.terminals[0].output.at(-1), output);
  assert.ok(!direct.sent.some(message => message.type === 'lease'));
  h.unmount();
  assert.equal(direct.readyState, 3);
});

test('membership denial during startup closes the direct socket and reconnect gets a new ticket', async t => {
  const h = mountTerminal(t);
  await settle();
  const { control, direct } = openDirect(h);
  control.close(4003);
  assert.equal(direct.readyState, 3);
  assert.match(h.terminals[0].output.join(''), /Permission Error/);
  h.terminals[0].key('Enter');
  await settle();
  assert.equal(h.requests.length, 2);
  h.sockets.at(-1).open(false);
  assert.deepEqual(h.sockets.at(-1).sent, [{ type: 'auth', ticket: 'ticket-2' }]);
});

test('a direct socket cannot bypass the consumption proof by sending ready early', async t => {
  const h = mountTerminal(t);
  await settle();
  const { control, direct } = openDirect(h);
  direct.message({ type: 'ready' });
  assert.equal(direct.readyState, 3);
  assert.equal(control.readyState, 3);
  assert.notEqual(h.states.at(-1), 'connected');
});

test('network loss automatically fetches fresh credentials and unmount cancels retry timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = mountTerminal(t);
  await settle();
  const { control, direct } = openDirect(h);
  proveDirect(control, direct);
  direct.close(1006);
  assert.equal(h.requests.length, 1);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(h.requests.length, 2);
  h.sockets.at(-1).open(false);
  assert.deepEqual(h.sockets.at(-1).sent, [{ type: 'auth', ticket: 'ticket-2' }]);
  h.unmount();
  t.mock.timers.tick(10000);
  await settle();
  assert.equal(h.requests.length, 2);
});

test('an open websocket waits for terminal readiness before allowing input or resize', async t => {
  const h = mountTerminal(t);
  await settle();
  const socket = h.sockets[0];
  socket.open(false);
  h.terminals[0].key('x');
  assert.equal(h.states.at(-1), 'connecting');
  assert.deepEqual(socket.sent, [{ type: 'auth', ticket: 'ticket-1' }]);
  socket.message({ type: 'ready' });
  assert.equal(h.states.at(-1), 'connected');
  h.terminals[0].key('x');
  assert.deepEqual(socket.sent.slice(1), [
    { type: 'resize', cols: 80, rows: 24 }, { type: 'input', data: 'x' },
  ]);
});

test('connection-lost message permits a key to reconnect even while the old socket is open', async t => {
  const h = mountTerminal(t);
  await settle();
  const oldSocket = h.sockets[0];
  oldSocket.open();
  oldSocket.message({ type: 'output', data: '$ echo previous output\r\nprevious output\r\n' });
  oldSocket.message({ type: 'error', data: 'Terminal connection lost.' });
  assert.match(h.terminals[0].output.join(''), /Press any key to reconnect/);
  const history = [...h.terminals[0].output];
  const event = h.terminals[0].key('Enter');
  assert.equal(event.defaultPrevented, true);
  await settle();
  assert.equal(h.requests.length, 2);
  assert.equal(oldSocket.readyState, 3);
  assert.equal(h.terminals.length, 1);
  assert.ok(!h.terminals[0].disposed);
  assert.deepEqual(h.terminals[0].output, history);
  const replacement = h.sockets[1];
  replacement.open();
  assert.deepEqual(replacement.sent[0], { type: 'auth', ticket: 'ticket-2' });
  assert.ok(!replacement.url.includes('access-token'));
  assert.equal(replacement.sent.filter(message => message.type === 'input').length, 0);
  replacement.message({ type: 'output', data: 'new shell prompt' });
  assert.deepEqual(h.terminals[0].output, [...history, 'new shell prompt']);
  h.terminals[0].key('a');
  assert.deepEqual(replacement.sent.at(-1), { type: 'input', data: 'a' });
});

test('a reported startup failure closes without appending a second disconnect error', async t => {
  const h = mountTerminal(t);
  await settle();
  const socket = h.sockets[0];
  socket.open(false);
  socket.message({ type: 'error', data: 'Sandbox connection failed. Please reconnect.' });
  socket.close(4500);
  const output = h.terminals[0].output.join('');
  assert.equal(output.match(/Sandbox connection failed/g)?.length, 1);
  assert.equal(output.match(/Press any key to reconnect/g)?.length, 1);
  assert.doesNotMatch(output, /\[Disconnected\]/);
  assert.equal(h.states.at(-1), 'error');
  h.terminals[0].key('Enter');
  await settle();
  assert.equal(h.requests.length, 2);
});

test('rapid keys after disconnect request only one new ticket and websocket', async t => {
  const h = mountTerminal(t);
  await settle();
  h.sockets[0].open();
  h.sockets[0].close(1006);
  for (let i = 0; i < 20; i++) h.terminals.at(-1).key('Enter');
  await settle();
  assert.equal(h.requests.length, 2);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.states.at(-1), 'connecting');
  assert.equal(h.sockets[1].sent.length, 0);
});

test('expired sessions and normal shell exits can reconnect with a new single-use ticket', async t => {
  const h = mountTerminal(t);
  await settle();
  for (const code of [4001, 1000]) {
    const socket = h.sockets.at(-1);
    socket.open();
    socket.close(code);
    h.terminals.at(-1).key(' ');
    await settle();
  }
  assert.equal(h.requests.length, 3);
  h.sockets.at(-1).open();
  assert.deepEqual(h.sockets.at(-1).sent[0], { type: 'auth', ticket: 'ticket-3' });
  assert.equal(h.terminals.length, 1);
  h.terminals[0].key('a');
  assert.deepEqual(h.sockets.at(-1).sent.filter(message => message.type === 'input'), [{ type: 'input', data: 'a' }]);
  h.unmount();
  assert.equal(h.terminals[0].disposed, true);
});

test('history survives a failed reconnect ticket and the next retry', async t => {
  const h = mountTerminal(t, attempt => {
    if (attempt === 2) throw new Error('Reconnect unavailable');
    return { data: { ticket: `ticket-${attempt}` } };
  });
  await settle();
  h.sockets[0].open();
  h.sockets[0].message({ type: 'output', data: 'output before disconnect' });
  h.sockets[0].close(1006);
  h.terminals[0].key('Enter');
  await settle();
  assert.equal(h.states.at(-1), 'error');
  const history = [...h.terminals[0].output];
  assert.match(history.join(''), /output before disconnect/);
  h.terminals[0].key('Enter');
  await settle();
  h.sockets.at(-1).open();
  assert.equal(h.terminals.length, 1);
  assert.deepEqual(h.terminals[0].output, history);
  assert.equal(h.requests.length, 3);
});

test('menu reconnect keeps history and ignores tickets from superseded attempts', async t => {
  const tickets = [];
  const h = mountTerminal(t, () => new Promise(resolve => tickets.push(resolve)));
  tickets[0]({ data: { ticket: 'initial-ticket' } });
  await settle();
  const oldSocket = h.sockets[0];
  oldSocket.open();
  oldSocket.message({ type: 'output', data: 'existing history' });
  const staleOutput = oldSocket.onmessage;
  assert.equal(h.reconnectFromMenu(), true);
  assert.equal(h.reconnectFromMenu(), true);
  tickets[2]({ data: { ticket: 'latest-ticket' } });
  await settle();
  tickets[1]({ data: { ticket: 'stale-ticket' } });
  await settle();
  assert.equal(h.sockets.length, 2);
  h.sockets[1].open();
  staleOutput({ data: JSON.stringify({ type: 'output', data: 'stale output' }) });
  assert.deepEqual(h.sockets[1].sent[0], { type: 'auth', ticket: 'latest-ticket' });
  assert.equal(h.terminals.length, 1);
  assert.deepEqual(h.terminals[0].output, ['existing history']);
});

test('ticket startup failures can also be retried by pressing a key', async t => {
  const h = mountTerminal(t, attempt => {
    if (attempt === 1) throw new Error('Network unavailable');
    return { data: { ticket: 'retry-ticket' } };
  });
  await settle();
  assert.equal(h.states.at(-1), 'error');
  assert.equal(h.sockets.length, 0);
  h.terminals[0].key('r');
  await settle();
  assert.equal(h.requests.length, 2);
  h.sockets[0].open();
  assert.deepEqual(h.sockets[0].sent[0], { type: 'auth', ticket: 'retry-ticket' });
});

test('a held key does not start repeated reconnections after failure', async t => {
  const h = mountTerminal(t);
  await settle();
  h.sockets[0].open();
  h.sockets[0].close(1006);
  h.terminals[0].key('a', true);
  await settle();
  assert.equal(h.requests.length, 1);
  h.terminals[0].key('a');
  await settle();
  assert.equal(h.requests.length, 2);
});

test('a ticket arriving after the tab unmounts cannot create a websocket', async t => {
  let resolveTicket;
  const h = mountTerminal(t, () => new Promise(resolve => { resolveTicket = resolve; }));
  h.unmount();
  resolveTicket({ data: { ticket: 'late-ticket' } });
  await settle();
  assert.equal(h.sockets.length, 0);
});
