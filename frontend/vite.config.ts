import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const frontendRoot = fileURLToPath(new URL(".", import.meta.url));
// Markdown docs live at the repository root and are read by src/app/docs/docs-source.ts.
const docsDir = path.resolve(frontendRoot, "..", "docs");
const cloudFrontendDir = process.env.CLOUD_FRONTEND_DIR
  ? path.resolve(process.env.CLOUD_FRONTEND_DIR)
  : fileURLToPath(new URL("./src/extensions/noop", import.meta.url));

function resolveFromCoreNodeModules(): Plugin {
  const coreEntry = path.join(frontendRoot, "package.json");
  return {
    name: "resolve-extension-deps-from-core",
    async resolveId(source, importer, options) {
      if (
        !importer ||
        !process.env.CLOUD_FRONTEND_DIR ||
        source.startsWith(".") ||
        source.startsWith("/") ||
        source.startsWith("@/") ||
        source.startsWith("@cloud")
      ) {
        return null;
      }
      if (path.resolve(importer).startsWith(cloudFrontendDir)) {
        return this.resolve(source, coreEntry, { ...options, skipSelf: true });
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [resolveFromCoreNodeModules(), react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@cloud": cloudFrontendDir,
    },
    dedupe: ["react", "react-dom", "react-router-dom", "zustand"],
  },
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    fs: { allow: [frontendRoot, docsDir, cloudFrontendDir] },
  },
  preview: { host: "0.0.0.0", port: 3000, strictPort: true },
});
