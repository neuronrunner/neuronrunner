const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const storage = new Map();
global.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => {
    storage.set(key, String(value));
    global.localStorage[key] = String(value);
  },
  removeItem: (key) => {
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
global.window = {
  localStorage: global.localStorage,
  setInterval: global.setInterval,
  clearInterval: global.clearInterval,
};

const enGit = require("../src/locales/en/git.json");
const t = (key, vars = {}) => {
  const pathKey = key.replace(/^git:/, "");
  const value = pathKey.split(".").reduce((acc, part) => acc?.[part], enGit);
  if (typeof value !== "string") return key;
  return value.replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars[name] ?? ""));
};

const chatListeners = new Set();
const chatState = {
  conversationId: null,
  activeRequestId: null,
  isStreaming: false,
  error: null,
  setChatMode: () => {},
  reset: () => {
    chatState.conversationId = null;
    chatState.activeRequestId = null;
    chatState.isStreaming = false;
    chatState.error = null;
    chatListeners.forEach((fn) => fn(chatState));
  },
  sendMessage: async () => chatState.conversationId,
  cancelGeneration: async () => {
    chatState.isStreaming = false;
    chatState.activeRequestId = null;
    chatListeners.forEach((fn) => fn(chatState));
  },
};

const mockChatStore = Object.assign(
  (selector) => selector(chatState),
  {
    getState: () => chatState,
    setState: (patch) => {
      Object.assign(chatState, typeof patch === "function" ? patch(chatState) : patch);
      chatListeners.forEach((fn) => fn(chatState));
    },
    subscribe: (listener) => {
      chatListeners.add(listener);
      return () => chatListeners.delete(listener);
    },
  }
);

let axiosResponses = new Map();
let cancelRequests = [];
const repoMutations = [];

function loadTs(relPath, extraMocks = {}) {
  const filename = path.resolve(__dirname, relPath);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = (id) => {
    if (id in extraMocks) return extraMocks[id];
    if (id === "@/lib/env") return { env: { API_URL: "https://api.example.com" } };
    if (id === "@/lib/axios") {
      return {
        authedAxios: {
          get: async (url) => {
            const handler = axiosResponses.get(url);
            if (!handler) throw new Error(`Unexpected GET ${url}`);
            return typeof handler === "function" ? handler(url) : handler;
          },
        },
        workspaceHeaders: () => ({ "X-Workspace-Id": "ws-1" }),
      };
    }
    if (id === "@/lib/repository-api") {
      return {
        repositoryError: (err) => err?.message || "error",
        repositoryMutation: async (vmUuid, endpoint, body) => {
          repoMutations.push({ vmUuid, endpoint, body });
          return { branch: body.branch || "main" };
        },
      };
    }
    if (id === "@/stores/chat") {
      return { __esModule: true, default: mockChatStore };
    }
    if (id === "@/i18n") {
      return { __esModule: true, default: { t } };
    }
    if (id === "@/lib/utils") {
      return { cn: (...values) => values.filter(Boolean).join(" ") };
    }
    if (id === "react-i18next") {
      return { useTranslation: () => ({ t }) };
    }
    if (id.startsWith("react-icons/")) {
      return new Proxy({}, { get: () => () => null });
    }
    return Module.prototype.require.call(loaded, id);
  };
  loaded._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    }).outputText,
    filename
  );
  return loaded.exports;
}

const sessionStoreModule = loadTs("../src/stores/git-ai-sessions.ts");
const useGitAISessionsStore = sessionStoreModule.default;
const {
  buildGitAISessionKey,
  isGitAISessionActiveStatus,
  launchGitAISession,
  cancelGitAISession,
  reconcileGitAISessions,
} = sessionStoreModule;

const { GitAISessionBadge } = loadTs("../src/components/git/ai-session-badge.tsx", {
  "@/stores/git-ai-sessions": sessionStoreModule,
});

global.fetch = async (url, options = {}) => {
  cancelRequests.push({ url, options });
  return { ok: true, json: async () => ({}) };
};

beforeEach(() => {
  global.localStorage.clear();
  useGitAISessionsStore.setState({ sessions: {} });
  axiosResponses = new Map();
  cancelRequests = [];
  repoMutations.length = 0;
  chatState.conversationId = null;
  chatState.activeRequestId = null;
  chatState.isStreaming = false;
  chatState.error = null;
});

test("launchGitAISession tracks pr-review lifecycle and persists to localStorage", async () => {
  const key = buildGitAISessionKey("pr", "acme/app", 42);
  assert.equal(key, "pr:acme/app:42");

  let resolveSend;
  chatState.sendMessage = async () => {
    mockChatStore.setState({
      conversationId: "conv-pr-42",
      activeRequestId: "req-pr-42",
      isStreaming: true,
    });
    await new Promise((resolve) => {
      resolveSend = resolve;
    });
    mockChatStore.setState({
      isStreaming: false,
      activeRequestId: null,
    });
    return "conv-pr-42";
  };

  const runPromise = launchGitAISession({
    kind: "pr",
    repoKey: "acme/app",
    number: 42,
    title: "Refactor auth",
    mode: "pr-review",
    vmUuid: "vm-1",
    repoPath: "/workspace/app",
    initialPrompt: "Review PR #42",
    targetBranch: "feature/auth",
    baseBranch: "main",
    defaultCommitMessage: "fix: review PR #42",
  });

  await new Promise((r) => setTimeout(r, 0));
  const inProgress = useGitAISessionsStore.getState().sessions[key];
  assert.equal(inProgress.status, "generating");
  assert.equal(inProgress.studioOpen, true);
  assert.equal(inProgress.conversationId, "conv-pr-42");
  assert.equal(inProgress.activeRequestId, "req-pr-42");
  assert.equal(isGitAISessionActiveStatus(inProgress.status), true);
  assert.equal(repoMutations.length, 0);

  const persistedRaw = global.localStorage.getItem("git-ai-sessions-storage");
  assert.ok(persistedRaw && persistedRaw.includes("conv-pr-42"));

  resolveSend();
  await runPromise;

  const completed = useGitAISessionsStore.getState().sessions[key];
  assert.equal(completed.status, "completed");
  assert.equal(completed.activeRequestId, null);
  assert.equal(isGitAISessionActiveStatus(completed.status), false);
});

test("reconcileGitAISessions recovers active, completed, failed, and 404 sessions after reload", async () => {
  const activeKey = buildGitAISessionKey("pr", "acme/app", 10);
  const doneKey = buildGitAISessionKey("issue", "acme/app", 11);
  const errKey = buildGitAISessionKey("issue", "acme/app", 12);
  const orphanKey = buildGitAISessionKey("pr", "acme/app", 13);

  useGitAISessionsStore.setState({
    sessions: {
      [activeKey]: {
        key: activeKey,
        kind: "pr",
        repoKey: "acme/app",
        number: 10,
        mode: "pr-review",
        studioOpen: true,
        conversationId: "conv-10",
        activeRequestId: "req-old",
        status: "generating",
        initialPrompt: "p",
        defaultCommitMessage: "c",
        startedAt: 1,
        updatedAt: 1,
      },
      [doneKey]: {
        key: doneKey,
        kind: "issue",
        repoKey: "acme/app",
        number: 11,
        mode: "issue-review",
        studioOpen: true,
        conversationId: "conv-11",
        activeRequestId: "req-11",
        status: "generating",
        initialPrompt: "p",
        defaultCommitMessage: "c",
        startedAt: 1,
        updatedAt: 1,
      },
      [errKey]: {
        key: errKey,
        kind: "issue",
        repoKey: "acme/app",
        number: 12,
        mode: "issue-solve",
        studioOpen: true,
        conversationId: "conv-12",
        activeRequestId: "req-12",
        status: "generating",
        initialPrompt: "p",
        defaultCommitMessage: "c",
        startedAt: 1,
        updatedAt: 1,
      },
      [orphanKey]: {
        key: orphanKey,
        kind: "pr",
        repoKey: "acme/app",
        number: 13,
        mode: "pr-review",
        studioOpen: true,
        conversationId: null,
        activeRequestId: null,
        status: "preparing",
        initialPrompt: "p",
        defaultCommitMessage: "c",
        startedAt: 1,
        updatedAt: 1,
      },
    },
  });

  axiosResponses.set("https://api.example.com/conversations/conv-10/", {
    data: { conversation: { active_request: { uuid: "req-10-live", status: "processing" }, messages: [] } },
  });
  axiosResponses.set("https://api.example.com/conversations/conv-11/", {
    data: { conversation: { active_request: null, messages: [{ role: "assistant", content: "Review done" }] } },
  });
  axiosResponses.set("https://api.example.com/conversations/conv-12/", {
    data: { conversation: { active_request: null, messages: [{ role: "assistant", error: "VM offline" }] } },
  });

  await reconcileGitAISessions("acme/app");

  const next = useGitAISessionsStore.getState().sessions;
  assert.equal(next[activeKey].status, "generating");
  assert.equal(next[activeKey].activeRequestId, "req-10-live");
  assert.equal(next[doneKey].status, "completed");
  assert.equal(next[doneKey].activeRequestId, null);
  assert.equal(next[errKey].status, "error");
  assert.equal(next[errKey].errorMessage, "VM offline");
  assert.equal(next[orphanKey].status, "canceled");
});

test("cancelGitAISession sends REST cancel when conversation is not active in chat store", async () => {
  global.localStorage.setItem("token", "jwt-abc");
  const key = buildGitAISessionKey("pr", "acme/app", 77);
  useGitAISessionsStore.getState().setSession({
    key,
    kind: "pr",
    repoKey: "acme/app",
    number: 77,
    mode: "pr-review",
    studioOpen: true,
    conversationId: "conv-remote-77",
    activeRequestId: "req-77",
    status: "generating",
    initialPrompt: "p",
    defaultCommitMessage: "c",
    startedAt: 1,
    updatedAt: 1,
  });

  await cancelGitAISession(key);

  const updated = useGitAISessionsStore.getState().sessions[key];
  assert.equal(updated.status, "canceled");
  assert.equal(updated.activeRequestId, null);
  assert.equal(cancelRequests.length, 1);
  assert.equal(cancelRequests[0].url, "https://api.example.com/conversations/conv-remote-77/cancel/");
});

test("GitAISessionBadge surfaces generating review and ready labels cleanly", () => {
  const generatingHtml = renderToStaticMarkup(
    React.createElement(GitAISessionBadge, {
      session: {
        key: "pr:acme/app:1",
        kind: "pr",
        repoKey: "acme/app",
        number: 1,
        mode: "pr-review",
        studioOpen: true,
        conversationId: "c1",
        activeRequestId: "r1",
        status: "generating",
        initialPrompt: "",
        defaultCommitMessage: "",
        startedAt: 1,
        updatedAt: 1,
      },
    })
  );
  assert.ok(generatingHtml.includes("Generating review…"));

  const readyHtml = renderToStaticMarkup(
    React.createElement(GitAISessionBadge, {
      session: {
        key: "issue:acme/app:2",
        kind: "issue",
        repoKey: "acme/app",
        number: 2,
        mode: "issue-solve",
        studioOpen: false,
        conversationId: "c2",
        activeRequestId: null,
        status: "completed",
        initialPrompt: "",
        defaultCommitMessage: "",
        startedAt: 1,
        updatedAt: 1,
      },
    })
  );
  assert.ok(readyHtml.includes("Solution ready"));
});

test("all 10 git locale bundles include new AI session and issue review keys", () => {
  const localesDir = path.resolve(__dirname, "../src/locales");
  const langs = fs.readdirSync(localesDir).sort();
  assert.equal(langs.length, 10);

  const requiredPaths = [
    "aiStudio.title.issueReview",
    "aiStudio.rerun",
    "aiStudio.rerunTitle",
    "aiStudio.generatingReview",
    "aiStudio.loadingSession",
    "aiStudio.badges.generatingReview",
    "aiStudio.badges.fixingWithAi",
    "aiStudio.badges.fixingCi",
    "aiStudio.badges.solvingWithAi",
    "aiStudio.badges.reviewReady",
    "aiStudio.badges.fixReady",
    "aiStudio.badges.solutionReady",
    "aiStudio.badges.failed",
    "aiStudio.badges.stopped",
    "issues.aiReview",
    "issues.generatingReview",
    "issues.solvingWithAi",
    "pullRequests.generatingReview",
    "pullRequests.fixingWithAi",
  ];

  for (const lang of langs) {
    const bundle = JSON.parse(fs.readFileSync(path.join(localesDir, lang, "git.json"), "utf8"));
    for (const keyPath of requiredPaths) {
      const value = keyPath.split(".").reduce((acc, part) => acc?.[part], bundle);
      assert.equal(typeof value, "string", `${lang}/git.json missing ${keyPath}`);
      assert.ok(value.trim().length > 0, `${lang}/git.json empty ${keyPath}`);
    }
  }
});
