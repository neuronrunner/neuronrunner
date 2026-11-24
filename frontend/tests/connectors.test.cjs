const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const snapshot = require('../src/data/connectors.json');
const source = fs.readFileSync(path.resolve(__dirname, '../src/lib/connectors.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
const enConnectors = require('../src/locales/en/connectors.json');
const translateEn = (key, vars = {}) => {
  const pathKey = key.replace(/^connectors:/, '');
  let val = pathKey.split('.').reduce((acc, part) => acc?.[part], enConnectors);
  if (typeof val !== 'string') return key;
  return val.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ''));
};
const context = {
  exports: {},
  require: (id) => id === '@/i18n' ? { __esModule: true, default: { t: translateEn } } : snapshot,
};
vm.runInNewContext(compiled, context);
const { connectors, connectableConnectors, recommendedConnectors, connectorRemotes, connectorHasUsableRemote, connectorRemoteSuffix, connectorCategories, connectorServerName, packageCommand, connectorError, connectorCanConnect } = context.exports;

test('the public directory exposes only remote-capable MCP servers', () => {
  assert.equal(connectors.length, 99);
  assert.equal(connectableConnectors.length, 37);
  assert.equal(recommendedConnectors.length, 12);
  assert.ok(connectableConnectors.every((connector) => connector.thirdPartyGateway !== true));
  assert.ok(connectableConnectors.every(connectorHasUsableRemote));
  assert.ok(connectableConnectors.every((connector) => connector.remotes.some((remote) => !/[{}<>]/.test(remote.url))));
  assert.ok(recommendedConnectors.every((connector) => connector.curated === true));
  const cloudflare = connectableConnectors.find((connector) => connector.id === "com.cloudflare.mcp/mcp");
  assert.equal(connectorRemotes(cloudflare).length, 15);
  assert.ok(connectorRemotes(cloudflare).every((remote) => remote.deprecated !== true));
  assert.ok(connectorRemotes(cloudflare).every((remote) => (remote.headers || []).every((h) => h.name !== 'Authentication')));
  const newlyEnabledIds = [
    'chatgpt/plugin_asdk_app_6939e86417648191b7bda087d872685b', // Hugging Face
    'io.github.pipeworx-io/posthog',
    'io.github.pipeworx-io/intercom',
    'io.github.pipeworx-io/dropbox',
    'io.github.pipeworx-io/jina-reader',
    'io.github.tavily-ai/tavily-mcp',
    'io.github.taazkareem/clickup',
    'io.github.olgasafonova/miro-mcp-server',
    'io.github.jtalk22/asana-mcp-server',
    'io.github.cyanheads/coingecko-mcp-server',
    'io.github.ohneben/hubspot-mcp',
    'chatgpt/plugin_asdk_app_695bfc98071c8191bac7bc479aa27de7', // Box
  ];
  for (const id of newlyEnabledIds) {
    assert.ok(connectableConnectors.some((connector) => connector.id === id), `Expected ${id} to be connectable`);
  }
  assert.equal(connectableConnectors.some((connector) => connector.id === 'io.github.pipeworx-io/airtable'), false);
  assert.equal(connectableConnectors.some((connector) => connector.id === 'chatgpt/plugin_asdk_app_69386058272881919c348f5c7ef2fb76'), false);
  assert.equal(new Set(connectors.map((item) => item.id)).size, connectors.length);
  assert.equal(new Set(connectors.map((item) => item.name)).size, connectors.length);
  assert.equal(new Set(connectors.map(connectorServerName)).size, connectors.length);
  for (const item of connectors) {
    assert.ok(item.description.length > 0);
    assert.ok(item.id.includes('/'));
    assert.ok(item.version);
    if (item.availability === 'provider-setup') {
      assert.equal(connectorCanConnect(item), false);
      assert.equal(item.remotes.length + item.packages.length, 0);
      assert.ok(item.chatgptDirectory);
    } else assert.ok(connectorCanConnect(item));
    assert.ok(connectorCategories.includes(item.category));
    assert.ok(item.website.startsWith('https://'));
    assert.match(item.logo, /^\/integrations\/[a-z0-9-]+\.(svg|png|jpg|ico)$/);
    assert.ok(item.logoSource.startsWith('https://'));
    const asset = fs.readFileSync(path.resolve(__dirname, '../public', item.logo.slice(1)));
    assert.ok(asset.length > 100, `${item.name} needs a real logo asset`);
    if (item.logo.endsWith('.svg')) {
      assert.match(asset.toString(), /<svg/);
      assert.doesNotMatch(asset.toString(), /<script|<foreignObject|(?:href|src)=["']https?:/i);
    }
    assert.match(connectorServerName(item), /^[a-zA-Z0-9_-]{1,100}$/);
  }
  for (const category of connectorCategories) assert.ok(connectors.some((item) => item.category === category));
});

test('directory provenance maps only to retained catalog entries', () => {
  const directory = require('../src/data/chatgpt-apps.json');
  assert.equal(directory.apps.length, 40);
  assert.equal(new Set(directory.apps.map((app) => app.pluginId)).size, directory.apps.length);
  for (const app of directory.apps) {
    const entry = connectors.find((connector) => connector.id === app.connectorId);
    assert.ok(entry, app.name);
    assert.equal(entry.chatgptDirectory.pluginId, app.pluginId);
    assert.equal(entry.chatgptDirectory.name, app.name);
  }
});

test('Codebase Memory MCP uses the original publisher and a pinned executable package', () => {
  const memory = connectors.find((item) => item.id === 'io.github.DeusData/codebase-memory-mcp');
  assert.ok(memory);
  assert.equal(memory.name, 'Codebase Memory MCP');
  assert.equal(memory.category, 'Development');
  assert.equal(memory.website, 'https://deusdata.github.io/codebase-memory-mcp/');
  assert.equal(packageCommand(memory.packages[0]), 'npx -y codebase-memory-mcp@0.12.1');
});

test('local package commands pin published versions and retain required arguments', () => {
  assert.equal(packageCommand({ registryType: 'npm', identifier: '@example/tools', version: '1.2.3', packageArguments: [{ type: 'positional', name: 'path', isRequired: true }] }), "npx -y @example/tools@1.2.3 '<path>'");
  assert.equal(packageCommand({ registryType: 'pypi', identifier: 'example-tools', version: '1.2.3' }), 'uvx example-tools==1.2.3');
  assert.equal(packageCommand({ registryType: 'oci', identifier: 'ghcr.io/example/tools:1.2.3', version: '1.2.3', environmentVariables: [{ name: 'API_KEY' }] }), 'docker run --rm -i -e API_KEY ghcr.io/example/tools:1.2.3');
});

test('package arguments are quoted instead of interpreted as shell commands', () => {
  const command = packageCommand({ registryType: 'npm', identifier: '@example/tools', version: '1.0.0', packageArguments: [{ type: 'positional', value: "folder with 'quotes' $(touch /tmp/should-not-execute)" }] });
  assert.ok(command.includes("'folder with '"));
  assert.ok(command.includes("'\"'\"'quotes'\"'\"'"));
  assert.ok(command.endsWith("/tmp/should-not-execute)'"));
});

test('Docker MCP starts with its missing AJV runtime dependency installed', () => {
  const docker = connectors.find((item) => item.id === 'io.github.alisaitteke/docker-mcp');
  assert.equal(packageCommand(docker.packages[0]), 'npx -y --package=@alisaitteke/docker-mcp@0.2.4 --package=ajv@8.17.1 -- docker-mcp-server');
});

test('intentional MCP startup errors retain their phase and diagnostic output', () => {
  const message = 'MCP startup and initialization timed out inside the workspace sandbox.\nServer output: installing dependencies';
  assert.equal(connectorError({ response: { status: 504, data: { error_code: 'mcp_timeout', error: message } } }), message);
  const dependency = "MCP server exited before responding.\nServer output: Cannot find module 'ajv'";
  assert.equal(connectorError({ response: { status: 500, data: { error_code: 'mcp_connection_failed', error: dependency } } }), dependency);
});

test('connectorError never exposes raw HTML or spaced characters on server errors', () => {
  const djangoHtmlError = {
    response: {
      status: 500,
      data: '<!DOCTYPE html><html lang="en"><head><title>ProgrammingError at /mcp/</title><style>body{font:12px}</style></head><body><h1>ProgrammingError</h1></body></html>',
    },
  };
  const message = connectorError(djangoHtmlError);
  assert.equal(message, 'An unexpected server error occurred. Please try again later.');
  assert.ok(!message.includes('<'));
  assert.ok(!message.includes('<! D O C T Y P E'));
  assert.ok(!message.includes('ProgrammingError'));
});

test('connectorError handles backend being stopped or unreachable', () => {
  const networkError = {
    name: 'AxiosError',
    message: 'Network Error',
    code: 'ECONNREFUSED',
  };
  assert.equal(connectorError(networkError), "We couldn't reach the server. Check your connection and try again.");
});

test('connectorError handles gateway errors cleanly', () => {
  for (const status of [502, 503, 504]) {
    const gatewayError = {
      response: {
        status,
        data: '<html><body>502 Bad Gateway</body></html>',
      },
    };
    assert.equal(connectorError(gatewayError), 'The server is temporarily unavailable. Please try again later.');
  }
});

test('connectorError extracts clean validation and business errors', () => {
  const validationError = {
    response: {
      status: 400,
      data: { command: ['Command is required for stdio transport.'] },
    },
  };
  assert.equal(connectorError(validationError), 'Command is required for stdio transport.');

  const explicitError = {
    response: {
      status: 404,
      data: { error: 'MCP server not found' },
    },
  };
  assert.equal(connectorError(explicitError), 'MCP server not found');
});

test('connectorRemoteSuffix provides readable endpoint names instead of numeric indices', () => {
  const cloudflare = connectableConnectors.find((c) => c.id === 'com.cloudflare.mcp/mcp');
  const cfRemotes = connectorRemotes(cloudflare);
  const cfSuffixes = cfRemotes.map((item, idx) => connectorRemoteSuffix(item, idx, cfRemotes));
  assert.deepEqual(cfSuffixes, [
    ' (Docs)',
    ' (Observability)',
    ' (Workers Bindings)',
    ' (Workers Builds)',
    ' (Radar)',
    ' (Containers)',
    ' (Browser Rendering)',
    ' (Logpush)',
    ' (AI Gateway)',
    ' (AutoRAG)',
    ' (Audit Logs)',
    ' (DNS Analytics)',
    ' (DEX)',
    ' (CASB)',
    ' (GraphQL)',
  ]);

  const notion = connectableConnectors.find((c) => c.id === 'com.notion/mcp');
  const notionRemotes = connectorRemotes(notion);
  assert.deepEqual(notionRemotes.map((item, idx) => connectorRemoteSuffix(item, idx, notionRemotes)), ['', '']);

  const postman = connectableConnectors.find((c) => c.id === 'com.postman/postman-mcp-server');
  const postmanRemotes = connectorRemotes(postman);
  assert.deepEqual(postmanRemotes.map((item, idx) => connectorRemoteSuffix(item, idx, postmanRemotes)), [
    ' (US · Full)',
    ' (US · Minimal)',
    ' (EU · Full)',
    ' (EU · Minimal)',
  ]);

  const posthog = connectableConnectors.find((c) => c.id === 'io.github.pipeworx-io/posthog');
  const posthogRemotes = connectorRemotes(posthog);
  assert.deepEqual(posthogRemotes.map((item, idx) => connectorRemoteSuffix(item, idx, posthogRemotes)), [' (US)', ' (EU)']);

  const coingecko = connectableConnectors.find((c) => c.id === 'io.github.cyanheads/coingecko-mcp-server');
  const cgRemotes = connectorRemotes(coingecko);
  assert.deepEqual(cgRemotes.map((item, idx) => connectorRemoteSuffix(item, idx, cgRemotes)), [' (Public)', ' (Pro)']);
});
