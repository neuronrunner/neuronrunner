import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../tests/", import.meta.url));
// Each file uses its own browser/storage mocks, so run them in separate processes.
for (const name of readdirSync(directory).filter(name => name.endsWith(".test.cjs")).sort()) {
  const result = spawnSync(process.execPath, ["--test", `${directory}${name}`], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
