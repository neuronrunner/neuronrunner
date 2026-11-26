const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { MemoryRouter } = require("react-router-dom");

const srcDir = path.resolve(__dirname, "../src");

let authState = { user: null, token: null, setUser: (u) => { authState.user = u; }, setToken: (t) => { authState.token = t; } };
let sidebarState = { isOpen: false, setOpen: () => {}, toggle: () => {} };
let navbarState = { isNotFound: false, setIsNotFound: () => {} };
let workspaceTabsState = {
  tabs: [{ id: "chat-default", type: "chat", title: "New Chat" }],
  activeTabId: "chat-default",
  splitTabs: [],
  activeSplitTabId: null,
  isSplit: false,
  setActiveSplitTab: () => {},
  openFilesTab: () => {},
  openGitTab: () => {},
  openBrowserTab: () => {},
  openDesktopTab: () => {},
  openTerminalTab: () => {},
  closeTab: () => {},
};
let currentPathname = "/";

const stubComponent = (name) => (props) => React.createElement("div", { "data-stub": name }, props?.children);

function createAuthHook() {
  const hook = (selector) => (selector ? selector(authState) : authState);
  hook.getState = () => authState;
  hook.setState = (patch) => { authState = { ...authState, ...patch }; };
  return hook;
}

function createStoreHook(getState) {
  const hook = (selector) => (selector ? selector(getState()) : getState());
  hook.getState = getState;
  hook.setState = () => {};
  return hook;
}

const useAuthHook = createAuthHook();
const useSidebarHook = createStoreHook(() => sidebarState);
const useNavbarHook = createStoreHook(() => navbarState);
const useWorkspaceTabsHook = createStoreHook(() => workspaceTabsState);
const useChatHook = createStoreHook(() => ({ conversationId: null, reset: () => {} }));
const useSandboxProjectsHook = createStoreHook(() => ({ sidebarWidth: 360, setSidebarWidth: () => {}, isSidebarResizing: false, setSidebarResizing: () => {}, currentSandbox: null, workspaceSandbox: null }));
const useWorkspacesHook = createStoreHook(() => ({ currentWorkspace: null, currentWorkspaceUuid: null, setWorkspaceSettingsDialogOpen: () => {} }));
const useVMsHook = createStoreHook(() => ({ vms: [], selectedVMUuid: null, selectVM: () => {}, setCreateModalOpen: () => {}, fetchVMs: async () => {}, loadedWorkspaceUuid: null }));
const useSigninHook = createStoreHook(() => ({ setOpen: () => {} }));
const useSignupHook = createStoreHook(() => ({ setOpen: () => {} }));

const cache = new Map();
function loadTs(relPath) {
  const filename = path.resolve(srcDir, relPath);
  if (cache.has(filename)) return cache.get(filename).exports;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  cache.set(filename, loaded);

  loaded.require = (id) => {
    if (id === "@/lib/env") return { env: { API_URL: "http://test-api", GOOGLE_CLIENT_ID: "", ENABLE_DOCS: true } };
    if (id === "@/lib/navigation") {
      return {
        usePathname: () => currentPathname,
        useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
        isKnownRoute: (p) => ["/", "/new", "/chat", "/pricing", "/integrations", "/docs", "/hello"].includes(p) || p.startsWith("/chat/"),
      };
    }
    if (id === "@/lib/utils") return { cn: (...args) => args.filter(Boolean).join(" ") };
    if (id === "@/lib/lazy-view") return { lazyView: () => stubComponent("LazyView") };
    if (id === "@/stores/auth") return { __esModule: true, default: useAuthHook };
    if (id === "@/stores/sidebar") return { __esModule: true, default: useSidebarHook };
    if (id === "@/stores/navbar") return { __esModule: true, default: useNavbarHook };
    if (id === "@/stores/workspace-tabs") return { __esModule: true, default: useWorkspaceTabsHook, detectFileType: () => "code" };
    if (id === "@/stores/chat") return { __esModule: true, default: useChatHook };
    if (id === "@/stores/sandbox-projects") return { __esModule: true, default: useSandboxProjectsHook };
    if (id === "@/stores/workspaces") return { __esModule: true, default: useWorkspacesHook };
    if (id === "@/stores/vms") return { __esModule: true, default: useVMsHook };
    if (id === "@/stores/signin") return { __esModule: true, default: useSigninHook };
    if (id === "@/stores/signup") return { __esModule: true, default: useSignupHook };
    if (id === "@/components/background") return { __esModule: true, default: stubComponent("Background") };
    if (id === "@/components/sidebar") return { __esModule: true, default: stubComponent("Sidebar") };
    if (id === "@/components/signin-dialog" || id === "./signin-dialog") return { __esModule: true, default: stubComponent("SigninDialog") };
    if (id === "@/components/signup-dialog" || id === "./signup-dialog") return { __esModule: true, default: stubComponent("SignupDialog") };
    if (id === "@/components/settings/dialog") return { __esModule: true, default: stubComponent("SettingsDialog") };
    if (id === "@/components/vm/create-vm-dialog") return { __esModule: true, default: stubComponent("CreateVMDialog") };
    if (id === "@/components/billing/insufficient-balance-dialog") return { __esModule: true, default: stubComponent("InsufficientBalanceDialog") };
    if (id === "@/components/ui/toaster") return { Toaster: stubComponent("Toaster") };
    if (id === "@/components/ui/button") return { Button: (p) => React.createElement("button", p) };
    if (id === "@/components/neuron-logo") return { __esModule: true, default: stubComponent("NeuronLogo"), NeuronLogo: stubComponent("NeuronLogo") };
    if (id === "@/components/language-switcher") return { LanguageSwitcher: stubComponent("LanguageSwitcher") };
    if (id === "@/components/vm/vm-header-control") return { __esModule: true, default: stubComponent("VMHeaderControl") };
    if (id === "@/components/conversation-title-input") return { __esModule: true, default: stubComponent("ConversationTitleInput") };
    if (id === "@/components/fading-text") return { __esModule: true, default: ({ text }) => React.createElement("span", null, text) };
    if (id === "@/components/workspace-header-toolbar") return { __esModule: true, default: () => React.createElement("div", { "data-testid": "workspace-header-toolbar" }, "WorkspaceHeaderToolbar") };
    if (id === "@/components/landing-page") return { __esModule: true, default: () => React.createElement("div", { "data-testid": "landing-page" }, "LandingPage") };
    if (id === "next-themes") return { ThemeProvider: ({ children }) => children };
    if (id === "@react-oauth/google") return { GoogleOAuthProvider: ({ children }) => children };
    if (id === "react-i18next") return { useTranslation: () => ({ t: (k) => k }) };
    if (id === "axios") return { __esModule: true, default: { post: async () => ({ status: 200, data: {} }) } };
    if (id === "@cloud") return loadTs("extensions/noop/index.ts");
    if (id.startsWith("@/")) return loadTs(id.slice(2) + ".tsx");
    return Module.prototype.require.call(loaded, id);
  };

  const source = fs.readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  });
  loaded._compile(outputText, filename);
  return loaded.exports;
}

const { Provider } = loadTs("app/provider.tsx");
const Navbar = loadTs("components/navbar.tsx").default;
const { WorkspaceTabContainer } = loadTs("components/workspace-tabs/WorkspaceTabContainer.tsx");
const Home = loadTs("app/page.tsx").default;

const storage = new Map();
global.window = {};
global.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, v),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear(),
};

beforeEach(() => {
  storage.clear();
  authState = { user: null, token: null, setUser: (u) => { authState.user = u; }, setToken: (t) => { authState.token = t; } };
  sidebarState = { isOpen: false, setOpen: () => {}, toggle: () => {} };
  navbarState = { isNotFound: false, setIsNotFound: () => {} };
  workspaceTabsState.tabs = [{ id: "chat-default", type: "chat", title: "New Chat" }];
  workspaceTabsState.activeTabId = "chat-default";
  currentPathname = "/";
});

test("landing page / never renders workspace shell or workspace header bar even with a dangling token in localStorage", () => {
  storage.set("token", "stale-token");
  authState.token = "stale-token";
  authState.user = null;
  currentPathname = "/";

  const html = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: ["/"] },
      React.createElement(Provider, null, React.createElement(Home))
    )
  );

  assert.match(html, /data-testid="landing-page"/);
  assert.doesNotMatch(html, /app-shell--workspace/);
  assert.doesNotMatch(html, /workspace-screen/);
  assert.doesNotMatch(html, /tabContainer\.newConversation/);
  assert.doesNotMatch(html, /workspace-header-toolbar/);
  assert.match(html, /<header/);
});

test("WorkspaceTabContainer never renders workspace header bar on / or when logged out", () => {
  storage.set("token", "stale-token");
  authState.token = "stale-token";
  authState.user = null;
  currentPathname = "/";

  const html = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: ["/"] },
      React.createElement(WorkspaceTabContainer, null, React.createElement("div", null, "Landing"))
    )
  );

  assert.doesNotMatch(html, /tabContainer\.newConversation/);
  assert.doesNotMatch(html, /workspace-header-toolbar/);
});

test("authenticated user on /new gets workspace shell and workspace header bar", () => {
  authState.user = { uuid: "u-1", username: "dev" };
  authState.token = "valid-token";
  storage.set("user", JSON.stringify(authState.user));
  storage.set("token", "valid-token");
  storage.set("refreshToken", "valid-refresh");
  currentPathname = "/new";

  const html = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: ["/new"] },
      React.createElement(
        Provider,
        null,
        React.createElement("div", { "data-testid": "new-chat-body" }, "Composer")
      )
    )
  );

  assert.match(html, /app-shell--workspace/);
  assert.match(html, /workspace-screen/);
  assert.match(html, /tabContainer\.newConversation/);
  assert.doesNotMatch(html, /workspace-header-toolbar/);
  assert.match(html, /data-testid="new-chat-body"/);
});

test("Navbar Go to Chat link points to /new when logged in on marketing pages", () => {
  authState.user = { uuid: "u-1", username: "dev" };
  authState.token = "valid-token";
  currentPathname = "/pricing";

  const html = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: ["/pricing"] },
      React.createElement(Navbar)
    )
  );

  assert.match(html, /href="\/new"/);
});

test("Navbar on /hello hides top nav links, Go to Chat, and Settings, and shows only Sign out", () => {
  authState.user = { uuid: "u-1", username: "dev" };
  authState.token = "valid-token";
  currentPathname = "/hello";

  const html = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: ["/hello"] },
      React.createElement(Navbar)
    )
  );

  assert.doesNotMatch(html, /href="\/pricing"/);
  assert.doesNotMatch(html, /href="\/integrations"/);
  assert.doesNotMatch(html, /href="\/docs"/);
  assert.doesNotMatch(html, /href="\/new"/);
  assert.doesNotMatch(html, /navbar\.actions\.goToChat/);
  assert.doesNotMatch(html, /navbar\.actions\.settings/);
  assert.match(html, /sidebarAvatar\.signOut/);
  assert.match(html, /data-stub="LanguageSwitcher"/);
});
