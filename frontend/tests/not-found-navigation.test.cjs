const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

function compileTs(relPath) {
  const filename = path.resolve(__dirname, relPath);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  // Mock react-router-dom for navigation.ts
  const origRequire = loaded.require.bind(loaded);
  loaded.require = function (id) {
    if (id === "react-router-dom") {
      return {
        useLocation: () => ({ pathname: "/" }),
        useNavigate: () => () => {},
        useSearchParams: () => [new URLSearchParams()],
        useParams: () => ({}),
      };
    }
    if (id === "react") {
      return { useMemo: (fn) => fn() };
    }
    if (id === "@cloud") {
      return { default: { routes: [] } };
    }
    return origRequire(id);
  };
  loaded._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    }).outputText,
    filename,
  );
  return loaded.exports;
}

const { isKnownRoute } = compileTs("../src/lib/navigation.ts");

test("isKnownRoute identifies valid app routes correctly", () => {
  const validRoutes = [
    "/",
    "/new",
    "/chat",
    "/chat/some-uuid-1234",
    "/projects",
    "/projects/my-project",
    "/workspaces",
    "/workspaces/invitations",
    "/workspaces/legacy-path",
    "/hello",
    "/issues",
    "/issues/123",
    "/pull-requests",
    "/pull-requests/456",
    "/integrations",
    "/integrations/oauth/callback",
    "/connectors",
    "/connectors/oauth/callback",
    "/terms-of-service",
    "/privacy-policy",
  ];

  for (const route of validRoutes) {
    assert.equal(isKnownRoute(route), true, `Route ${route} should be recognized as a valid known route`);
    assert.equal(isKnownRoute(route + "/"), true, `Route ${route}/ should also be recognized with trailing slash`);
  }
});

test("isKnownRoute identifies 404 / unknown routes correctly", () => {
  const unknownRoutes = [
    "/sandboxes",
    "/404",
    "/not-found",
    "/route-that-does-not-exist",
    "/random-page",
    "/pricing/extra-path",
    "/admin",
    "/admin/model-create",
    "/admin-unknown",
    "/billing/something-else",
    "/users/profile",
    "/settings/general",
    "",
  ];

  for (const route of unknownRoutes) {
    assert.equal(isKnownRoute(route), false, `Route '${route}' should NOT be recognized as a known route (it's 404)`);
  }
});
