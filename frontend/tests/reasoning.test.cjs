const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

global.localStorage = {
  _map: new Map(),
  getItem(key) {
    return this._map.has(key) ? this._map.get(key) : null;
  },
  setItem(key, val) {
    this._map.set(key, String(val));
  },
  removeItem(key) {
    this._map.delete(key);
  },
};
global.window = { localStorage: global.localStorage };

const sidebar = { conversations: [], setConversationTitle() {}, moveConversationToTop() {} };
const projects = { currentSandbox: null, workspaceSandbox: null, linkConversationToSandbox() {}, fetchFiles() {} };

const cache = new Map();
function load(filename) {
  const abs = path.resolve(filename);
  if (cache.has(abs)) return cache.get(abs).exports;
  const loaded = new Module(abs, module);
  loaded.filename = abs;
  loaded.paths = Module._nodeModulePaths(path.dirname(abs));
  cache.set(abs, loaded);

  loaded.require = (id) => {
    if (id === "@/lib/env") {
      return { env: { API_URL: "http://localhost:8000", GOOGLE_CLIENT_ID: "", ENABLE_STUDIO: false } };
    }
    if (id === "@/lib/reasoning") {
      return load(path.resolve(__dirname, "../src/lib/reasoning.ts"));
    }
    if (id === "@/lib/default-models") {
      return load(path.resolve(__dirname, "../src/lib/default-models.ts"));
    }
    if (id === "@/types/model") {
      return load(path.resolve(__dirname, "../src/types/model.ts"));
    }
    if (id === "@/lib/recent-models") {
      return { clearRecentModelsCache() {}, fetchRecentModels: async () => [] };
    }
    if (id === "@/components/ui/toaster") {
      return { toaster: { create() {} } };
    }
    if (id === "@/lib/axios") {
      return {
        workspaceHeaders: () => ({ "X-Workspace-ID": "test-ws" }),
        authedAxios: { get: async () => ({ data: { results: [] } }) },
      };
    }
    if (id === "@/i18n") {
      return { __esModule: true, default: { t: (k) => k } };
    }
    if (id === "openai") {
      return { __esModule: true, default: class {} };
    }
    if (id === "./sidebar") return { __esModule: true, default: { getState: () => sidebar } };
    if (id === "./sandbox-projects") return { __esModule: true, default: { getState: () => projects } };
    if (id === "./workspace-tabs") return { __esModule: true, default: { getState: () => ({ openChatTab() {} }) } };
    if (id === "./vms") return { __esModule: true, default: { getState: () => ({ selectedVMUuid: null }) } };
    if (id === "./search-models") return load(path.resolve(__dirname, "../src/stores/search-models.ts"));
    if (id === "./recent-models") return load(path.resolve(__dirname, "../src/stores/recent-models.ts"));
    if (id === "@/stores/chat-branch") return { useChatBranchStore: { getState: () => ({ pending: null, setPending() {} }) } };
    if (id === "@cloud") return load(path.resolve(__dirname, "../src/extensions/noop/index.ts"));
    if (id.startsWith("@/components/chat/")) {
      return load(path.resolve(__dirname, "../src/components/chat/", id.split("/").at(-1) + ".ts"));
    }
    return Module.prototype.require.call(loaded, id);
  };

  loaded._compile(
    ts.transpileModule(fs.readFileSync(abs, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    }).outputText,
    abs
  );
  return loaded.exports;
}

const reasoning = load(path.resolve(__dirname, "../src/lib/reasoning.ts"));
const { DEFAULT_PLATFORM_MODELS } = load(path.resolve(__dirname, "../src/lib/default-models.ts"));
const useChatStore = load(path.resolve(__dirname, "../src/stores/chat.ts")).default;

beforeEach(() => {
  global.localStorage._map.clear();
  useChatStore.setState({
    selectedModel: "deepseek-v4.1-flash-1017",
    selectedModelType: "text",
    selectedModelIsReasoning: true,
    selectedModelReasoningMode: "effort",
    selectedModelReasoningTiers: ["none", "low", "high", "max"],
    selectedModelDefaultReasoningEffort: "high",
    reasoningLevel: "high",
    reasoningLevelByModel: { "deepseek-v4.1-flash-1017": "high" },
  });
});

test("DEFAULT_PLATFORM_MODELS covers all 15 models with consistent reasoning specs", () => {
  assert.equal(DEFAULT_PLATFORM_MODELS.length, 15);

  for (const model of DEFAULT_PLATFORM_MODELS) {
    assert.equal(model.is_reasoning, true, `${model.name} should be reasoning`);
    const spec = reasoning.getModelReasoningSpec(model);
    assert.equal(spec.isReasoning, true);
    assert.equal(spec.hasExplicitTiers, true, `${model.name} should declare explicit tiers`);
    assert.ok(spec.tiers.includes(spec.defaultTier), `${model.name} default must be in tiers`);
  }

  assert.deepEqual(
    DEFAULT_PLATFORM_MODELS.find((m) => m.name === "deepseek-v4.1-flash-1017").reasoning_tiers,
    ["none", "low", "high", "max"]
  );
  assert.deepEqual(
    DEFAULT_PLATFORM_MODELS.find((m) => m.name === "glm-5.3-flash").reasoning_tiers,
    ["low", "high", "max"]
  );
  assert.deepEqual(
    DEFAULT_PLATFORM_MODELS.find((m) => m.name === "qwen3.8-max").reasoning_tiers,
    ["minimal", "low", "medium", "high", "xhigh"]
  );
  assert.deepEqual(
    DEFAULT_PLATFORM_MODELS.find((m) => m.name === "gpt-6-luna").reasoning_tiers,
    ["none", "low", "medium", "high", "xhigh", "max"]
  );

  const toggleModel = DEFAULT_PLATFORM_MODELS.find((m) => m.name === "mimo-v2.6-flash");
  assert.equal(toggleModel.reasoning_mode, "toggle");
  assert.deepEqual(toggleModel.reasoning_tiers, ["none", "on"]);
});

test("resolveModelReasoningTier clamps unsupported levels safely", () => {
  const glmFlash = reasoning.getModelReasoningSpec(
    DEFAULT_PLATFORM_MODELS.find((m) => m.name === "glm-5.3-flash")
  );
  assert.equal(reasoning.resolveModelReasoningTier(glmFlash, "none"), "low");
  assert.equal(reasoning.resolveModelReasoningTier(glmFlash, "medium"), "high");
  assert.equal(reasoning.resolveModelReasoningTier(glmFlash, "xhigh"), "max");
  assert.equal(reasoning.resolveModelReasoningTier(glmFlash, "high"), "high");

  const toggleSpec = reasoning.getModelReasoningSpec(
    DEFAULT_PLATFORM_MODELS.find((m) => m.name === "qwen3.8-flash")
  );
  assert.equal(reasoning.resolveModelReasoningTier(toggleSpec, "high"), "on");
  assert.equal(reasoning.resolveModelReasoningTier(toggleSpec, "none"), "none");
  assert.equal(reasoning.resolveModelReasoningTier(toggleSpec, "off"), "none");

  const fixedSpec = reasoning.getModelReasoningSpec({
    name: "fixed-reasoning-model",
    is_reasoning: true,
    reasoning_mode: "fixed",
    reasoning_tiers: ["on"],
    default_reasoning_effort: "on",
  });
  assert.equal(reasoning.resolveModelReasoningTier(fixedSpec, "none"), "on");
  assert.equal(reasoning.resolveModelReasoningTier(fixedSpec, "low"), "on");
});

test("editable reasoning config helpers maintain valid invariant states", () => {
  const toggled = reasoning.toggleEffortTierSelection(["low", "medium", "high"], "medium", "medium");
  assert.deepEqual(toggled.tiers, ["low", "high"]);
  assert.equal(toggled.defaultTier, "high");

  // Cannot remove the only active non-"none" effort tier
  const guarded = reasoning.toggleEffortTierSelection(["none", "high"], "high", "high");
  assert.deepEqual(guarded.tiers, ["none", "high"]);
  assert.equal(guarded.defaultTier, "high");

  const modeToggle = reasoning.normalizeEditableModeChange("toggle", ["low", "high"], "high");
  assert.deepEqual(modeToggle, { mode: "toggle", tiers: ["none", "on"], defaultTier: "on" });

  const modeFixed = reasoning.normalizeEditableModeChange("fixed", ["none", "on"], "none");
  assert.deepEqual(modeFixed, { mode: "fixed", tiers: ["on"], defaultTier: "on" });

  const offPayload = reasoning.buildReasoningConfigPayload(false, "effort", ["low", "high"], "high");
  assert.deepEqual(offPayload, {
    is_reasoning: false,
    reasoning_mode: "none",
    supported_reasoning_efforts: [],
    default_reasoning_effort: "none",
  });
});

test("useChatStore tracks per-model reasoning specs and tiers across switches", async () => {
  useChatStore.getState().setSelectedModel("qwen3.8-flash");
  let state = useChatStore.getState();
  assert.equal(state.selectedModelIsReasoning, true);
  assert.equal(state.selectedModelReasoningMode, "toggle");
  assert.deepEqual(state.selectedModelReasoningTiers, ["none", "on"]);
  assert.equal(state.reasoningLevel, "on");

  useChatStore.getState().setReasoningLevel("none");
  assert.equal(useChatStore.getState().reasoningLevel, "none");
  assert.equal(useChatStore.getState().reasoningLevelByModel["qwen3.8-flash"], "none");

  useChatStore.getState().setSelectedModel("qwen3.8-max");
  state = useChatStore.getState();
  assert.equal(state.selectedModelReasoningMode, "effort");
  assert.deepEqual(state.selectedModelReasoningTiers, ["minimal", "low", "medium", "high", "xhigh"]);
  assert.equal(state.reasoningLevel, "xhigh");

  useChatStore.getState().setSelectedModel("glm-5.3-flash");
  useChatStore.getState().setReasoningLevel("low");
  assert.equal(useChatStore.getState().reasoningLevel, "low");

  // Switching back to qwen3.8-flash restores its stored "none" toggle setting
  useChatStore.getState().setSelectedModel("qwen3.8-flash");
  assert.equal(useChatStore.getState().reasoningLevel, "none");

  // fetchModelDetails reads backend model metadata directly without being clobbered by /tags/
  global.fetch = async (url) => {
    assert.ok(url.endsWith("/models/glm-5.3/"));
    return new Response(
      JSON.stringify({
        name: "glm-5.3",
        model_type: "text",
        is_reasoning: true,
        reasoning_mode: "effort",
        reasoning_tiers: ["low", "high", "max"],
        default_reasoning_effort: "max",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  useChatStore.getState().setSelectedModel("glm-5.3:high");
  await useChatStore.getState().fetchModelDetails("glm-5.3");
  state = useChatStore.getState();
  assert.equal(state.selectedModel, "glm-5.3");
  assert.equal(state.selectedModelReasoningMode, "effort");
  assert.deepEqual(state.selectedModelReasoningTiers, ["low", "high", "max"]);
  assert.equal(state.reasoningLevel, "high");
});
