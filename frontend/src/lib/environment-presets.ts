export interface EnvironmentPreset {
  id: string;
  label: string;
  setupScript: string;
  maintenanceScript: string;
}

export const ENVIRONMENT_PRESETS: EnvironmentPreset[] = [
  {
    id: "node-npm",
    label: "Node / npm",
    setupScript: "npm ci || npm install",
    maintenanceScript: "npm ci --prefer-offline || true",
  },
  {
    id: "pnpm",
    label: "pnpm",
    setupScript: "corepack enable && pnpm install --frozen-lockfile || pnpm install",
    maintenanceScript: "pnpm install --prefer-offline || true",
  },
  {
    id: "python-uv",
    label: "Python / uv",
    setupScript: "uv sync || (uv venv .venv && uv pip install -r requirements.txt)",
    maintenanceScript: "uv sync --offline || true",
  },
  {
    id: "go",
    label: "Go",
    setupScript: "go mod download",
    maintenanceScript: "go mod download",
  },
  {
    id: "rust",
    label: "Rust",
    setupScript: "cargo fetch",
    maintenanceScript: "cargo fetch --offline || true",
  },
];

export function formatBytesCompact(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function setupStatusDotClass(status?: string): string | null {
  switch (status) {
    case "ready":
      return "bg-emerald-500";
    case "running":
      return "bg-amber-500 animate-pulse";
    case "failed":
      return "bg-destructive";
    default:
      return null;
  }
}
