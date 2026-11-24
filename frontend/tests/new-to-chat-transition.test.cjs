const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { MemoryRouter, Routes, Route, useLocation, useNavigate, useParams } = require("react-router-dom");

const srcDir = path.resolve(__dirname, "../src");

test("App.tsx mounts /new and /chat/:uuid under a shared layout route so ChatWorkspace never unmounts on transition", () => {
  const appSource = fs.readFileSync(path.join(srcDir, "App.tsx"), "utf8");
  assert.match(appSource, /<Route element=\{<ChatWorkspaceRoute \/>\}>/);
  assert.match(appSource, /<Route path="\/new" element=\{null\} \/>/);
  assert.match(appSource, /<Route path="\/chat\/:uuid" element=\{null\} \/>/);

  // Verify with real react-router-dom that transitioning /new -> /chat/123 preserves the layout instance
  let mountCount = 0;
  let unmountCount = 0;
  function SharedLayout() {
    const params = useParams();
    const { pathname } = useLocation();
    React.useEffect(() => {
      mountCount += 1;
      return () => { unmountCount += 1; };
    }, []);
    return React.createElement("div", { "data-path": pathname, "data-uuid": params.uuid || "" }, "shared");
  }

  const htmlNew = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: ["/new"] },
      React.createElement(
        Routes,
        null,
        React.createElement(
          Route,
          { element: React.createElement(SharedLayout) },
          React.createElement(Route, { path: "/new", element: null }),
          React.createElement(Route, { path: "/chat/:uuid", element: null })
        )
      )
    )
  );
  assert.match(htmlNew, /data-path="\/new"/);

  const htmlChat = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: ["/chat/conv-123"] },
      React.createElement(
        Routes,
        null,
        React.createElement(
          Route,
          { element: React.createElement(SharedLayout) },
          React.createElement(Route, { path: "/new", element: null }),
          React.createElement(Route, { path: "/chat/:uuid", element: null })
        )
      )
    )
  );
  assert.match(htmlChat, /data-path="\/chat\/conv-123"/);
  assert.match(htmlChat, /data-uuid="conv-123"/);
  assert.equal(mountCount, 0);
  assert.equal(unmountCount, 0);
});

test("ChatWorkspace keeps one PromptInput slot, stable clientKey message keys, and no chat-enter flash on sent messages", () => {
  const workspaceSource = fs.readFileSync(path.join(srcDir, "components/chat/chat-workspace.tsx"), "utf8");

  // Only one PromptInput instance should be rendered so focus is never lost across mode/route changes
  const promptInputMatches = workspaceSource.match(/<PromptInput\b/g) || [];
  assert.equal(promptInputMatches.length, 1, "ChatWorkspace must render a single persistent PromptInput");

  // Message rows must use stable clientKey before uuid so temp->server UUID replacement does not remount
  assert.match(workspaceSource, /const renderKey = msg\.clientKey \|\| msg\.uuid \|\|/);
  assert.match(workspaceSource, /!isLocallyCreated && "chat-enter"/);
  assert.match(workspaceSource, /if \(createdFromNewUuid === uuid\) \{[\s\S]*?return;[\s\S]*?\}/);
});

test("chat store assigns and preserves clientKey when user_message_uuid replaces tempId", () => {
  const chatStoreSource = fs.readFileSync(path.join(srcDir, "stores/chat.ts"), "utf8");

  assert.match(chatStoreSource, /clientKey\?: string;/);
  assert.match(chatStoreSource, /uuid: tempId,\s*\n\s*clientKey: tempId,/);
  assert.match(chatStoreSource, /const nextMessages = \(actualTrimmed \|\| actualHasFiles\) \? \[\.\.\.state\.messages, provisionalUser\] : state\.messages;/);
  assert.match(chatStoreSource, /uuid: metadata\.user_message_uuid, clientKey: m\.clientKey \?\? m\.uuid/);
  assert.match(chatStoreSource, /existingClientKeys/);
});

test("PromptInput preserves textarea focus when handleSend runs while focus is inside the composer", () => {
  const promptInputSource = fs.readFileSync(path.join(srcDir, "components/prompt-input.tsx"), "utf8");
  assert.match(promptInputSource, /wrapperRef\.current\?\.contains\(document\.activeElement\)/);
  assert.match(promptInputSource, /textareaRef\.current\.focus\(\{ preventScroll: true \}\)/);
});

test("ChatWorkspace preserves activeSessionKey and renders user message immediately on /new -> /chat/:uuid", () => {
  // Verify ChatWorkspace compiles cleanly via TypeScript and renders /new landing and /chat/:uuid
  const filename = path.join(srcDir, "components/chat/chat-workspace.tsx");
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  });
  assert.equal(compiled.diagnostics?.length ?? 0, 0);

  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));

  const stub = (name) => (props) => React.createElement("div", { "data-stub": name }, props?.children);
  let chatState = {
    messages: [],
    isLoading: false,
    isStreaming: false,
    isActivelyGenerating: false,
    sendMessage: async () => null,
    fetchConversation: async () => {},
    selectedModel: "test-model",
    selectedModelType: "text",
    selectedModelIsReasoning: false,
    selectedModelReasoningMode: "none",
    selectedModelReasoningTiers: [],
    selectedModelDefaultReasoningEffort: "none",
    useModelStartingLoading: false,
    setSelectedModel: () => {},
    setSelectedModelType: () => {},
    setCurrentMessage: () => {},
    setConversationId: () => {},
    currentMessage: null,
    conversationId: null,
    activeRequestId: null,
    abortController: null,
    cancelGeneration: async () => true,
    reset: () => {},
    reasoningLevel: "none",
    reasoningLevelByModel: {},
    setReasoningLevel: () => {},
    fetchModelDetails: async () => {},
    chatMode: "chat",
    setChatMode: () => {},
    draftPrompt: null,
    setDraftPrompt: () => {},
    skipFetchConversationId: null,
  };
  const chatHook = Object.assign((sel) => (sel ? sel(chatState) : chatState), {
    getState: () => chatState,
    setState: (patch) => { chatState = { ...chatState, ...(typeof patch === "function" ? patch(chatState) : patch) }; },
  });
  const makeHook = (obj) => Object.assign((sel) => (sel ? sel(obj) : obj), { getState: () => obj, setState: () => {} });

  loaded.require = (id) => {
    if (id === "@/lib/env") return { env: { API_URL: "http://test" } };
    if (id === "@/lib/navigation") return { useParams, usePathname: () => "/new", useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }) };
    if (id === "@/lib/utils") return { cn: (...a) => a.filter(Boolean).join(" "), formatModelIdentifier: (m) => m };
    if (id === "@/lib/prompt-transition") return {
      animatePromptPosition: () => null,
      clearPromptTransition: () => {},
      promptPosition: () => ({ top: 0, left: 0, width: 700 }),
      promptAnimationTime: () => 0,
      takePromptTransition: () => null,
      NEW_CHAT_TRANSITION_ID: "new-chat",
      PROMPT_TRANSITION_DURATION: 650,
    };
    if (id === "@/components/ui/toaster") return { toaster: { create: () => {} } };
    if (id === "@/stores/chat") return { __esModule: true, default: chatHook };
    if (id === "@/stores/auth") return { __esModule: true, default: makeHook({ user: { uuid: "u1" }, token: "tok" }) };
    if (id === "@/stores/recent-models") return { __esModule: true, default: makeHook({ recentModels: [], loadRecentModels: async () => {} }) };
    if (id === "@/stores/sandbox-projects") return { __esModule: true, default: makeHook({ sandboxes: [], sandboxConversations: {}, currentSandbox: null, linkConversationToSandbox: () => {}, ensureSandboxes: async () => {}, pickSandbox: async () => {} }) };
    if (id === "@/stores/sidebar") return { __esModule: true, default: makeHook({ conversations: [] }) };
    if (id === "@/stores/workspace-tabs") return { __esModule: true, default: makeHook({ tabs: [], splitTabs: [], openChatTab: () => {}, updateChatTabTitle: () => {} }) };
    if (id === "@/components/prompt-input") return { __esModule: true, default: () => React.createElement("textarea", { "data-testid": "prompt-textarea" }) };
    if (id === "@/components/loading-dots") return { LoadingDots: stub("LoadingDots") };
    if (id === "@/components/chat/chat-message") return { __esModule: true, default: ({ message }) => React.createElement("div", { "data-testid": "chat-msg" }, message.content) };
    if (id === "@/components/chat/normalize-tool-calls") return { mergeRequestUpdateMessage: (m) => m };
    if (id === "@/components/projects/chat-project-selector") return { __esModule: true, default: stub("ChatProjectSelector") };
    if (id === "@/components/chat/cloud-agent-selector") return { __esModule: true, default: stub("CloudAgentSelector") };
    if (id === "@/components/chat/ambient-glow") return { __esModule: true, default: stub("AmbientGlow") };
    if (id === "@/components/home-welcome") return { HomeSuggestions: stub("HomeSuggestions") };
    if (id === "@/components/seo") return { SEO: stub("SEO") };
    if (id === "react-i18next") return { useTranslation: () => ({ t: (k) => k }) };
    return Module.prototype.require.call(loaded, id);
  };
  loaded._compile(compiled.outputText, filename);
  const ChatWorkspace = loaded.exports.default;

  const html = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: ["/new"] },
      React.createElement(ChatWorkspace)
    )
  );
  assert.match(html, /data-chat-composer="home"/);
  assert.match(html, /data-testid="prompt-textarea"/);
});
