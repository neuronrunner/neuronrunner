const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

function compileTs(relPath, customRequire) {
  const filename = path.resolve(__dirname, relPath);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = (id) => {
    if (customRequire) {
      const resolved = customRequire(id);
      if (resolved !== undefined) return resolved;
    }
    return Module.prototype.require.call(loaded, id);
  };
  loaded._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        jsx: ts.JsxEmit.React,
      },
    }).outputText,
    filename,
  );
  return loaded.exports;
}

test("useRepositoryStatus requests repository status when sandbox and path are provided", () => {
  let requestMade = false;

  const repoApiMock = {
    repositoryRequest: async () => {
      requestMade = true;
      return { branch: "main", branches: [{ name: "main" }] };
    },
    isNoActiveVM: () => false,
    repositoryError: () => "Error",
    repositoryMutation: async () => ({}),
  };

  const reactMock = {
    useEffect: (fn) => fn(),
    useRef: (val) => ({ current: val }),
    useState: (val) => [typeof val === "function" ? val() : val, () => {}],
  };

  const zustandMock = {
    create: (fn) => {
      const state = fn(() => {});
      const storeHook = (selector) => (selector ? selector(state) : state);
      storeHook.getState = () => state;
      return storeHook;
    },
  };

  const customRequire = (id) => {
    if (id === "react") return reactMock;
    if (id === "@/lib/repository-api") return repoApiMock;
    if (id === "@/stores/sandbox-projects") return { default: { getState: () => ({}) } };
    if (id === "zustand") return zustandMock;
    return undefined;
  };

  const repoStatusModule = compileTs("../src/hooks/use-repository-status.ts", customRequire);
  const result = repoStatusModule.useRepositoryStatus("sandbox-1", "/workspace/project");

  assert.equal(requestMade, true, "Should make repositoryRequest for workspace sandbox");
  assert.equal(result.isVMRunning, true, "Docker sandbox is available by default");
});

test("useRepositoryStatus skips request when sandbox or path is missing", () => {
  let requestMade = false;

  const repoApiMock = {
    repositoryRequest: async () => {
      requestMade = true;
      return { branch: "main", branches: [] };
    },
    isNoActiveVM: () => false,
    repositoryError: () => "Error",
    repositoryMutation: async () => ({}),
  };

  const reactMock = {
    useEffect: (fn) => fn(),
    useRef: (val) => ({ current: val }),
    useState: (val) => [typeof val === "function" ? val() : val, () => {}],
  };

  const zustandMock = {
    create: (fn) => {
      const state = fn(() => {});
      const storeHook = (selector) => (selector ? selector(state) : state);
      storeHook.getState = () => state;
      return storeHook;
    },
  };

  const customRequire = (id) => {
    if (id === "react") return reactMock;
    if (id === "@/lib/repository-api") return repoApiMock;
    if (id === "@/stores/sandbox-projects") return { default: { getState: () => ({}) } };
    if (id === "zustand") return zustandMock;
    return undefined;
  };

  const repoStatusModule = compileTs("../src/hooks/use-repository-status.ts", customRequire);
  repoStatusModule.useRepositoryStatus(undefined, undefined);

  assert.equal(requestMade, false, "Should not make repositoryRequest without sandbox or path");
});
