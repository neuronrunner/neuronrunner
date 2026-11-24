import i18n from "@/i18n";

export function cleanPhaseLabel(label: string): string {
  if (!label) return "";
  return label.replace(/ - (?:Done|Failed)$/, "").replace(/:\s*\d+(\.\d+)?s$/, "");
}

export function formatToolName(name: string): string {
  if (!name) return i18n.t("chat:execution.defaultTool");
  if (name.startsWith("mcp__")) {
    const parts = name.slice(5).split("__");
    if (parts.length >= 2) {
      const serverPart = parts[0];
      const toolPart = parts.slice(1).join("__");
      const cleanServer = serverPart
        .replace(/^(?:io|com|org|net|app|dev|ai|co)_github_[^_]+_/i, "")
        .replace(/^(?:io|com|org|net|app|dev|ai|co)_[^_]+_/i, "")
        .replace(/^npm__?[^_]+_/i, "")
        .replace(/^npm_/i, "")
        .replace(/^(?:mcp[-_]|server[-_])+/i, "")
        .replace(/(?:[-_]mcp|[-_]server)+$/i, "")
        .split(/[_-]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");

      let cleanTool = toolPart
        .split(/[_-]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");

      if (cleanServer && cleanTool.toLowerCase().startsWith(cleanServer.toLowerCase() + " ")) {
        cleanTool = cleanTool.slice(cleanServer.length).trimStart();
      }

      if (cleanServer && cleanTool && cleanServer.toLowerCase() !== cleanTool.toLowerCase()) {
        return `${cleanServer} · ${cleanTool}`;
      }
      return cleanTool || cleanServer || i18n.t("chat:execution.defaultTool");
    }
  }
  return name
    .split("_")
    .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function hasToolResult(result: unknown): boolean {
  return result !== null && result !== undefined;
}

export function toolResultStatus(result: unknown): "calling" | "done" | "error" {
  if (!hasToolResult(result)) return "calling";
  let value = result;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return "done"; }
  }
  if (!value || typeof value !== "object") return "done";
  const record = value as Record<string, unknown>;

  // Shell execution that completed with an exit code >= 0 is a successful tool execution.
  // Process output (like git ref errors or non-zero return codes) is normal output, not a sandbox/tool failure.
  if (typeof record.exit_code === "number") {
    return record.exit_code < 0 || Boolean(record.error && !record.command) ? "error" : "done";
  }
  if (typeof record.status_code === "number") {
    return Boolean(record.error) ? "error" : "done";
  }
  if (record.isError === true || record.error || record.success === false) {
    return "error";
  }
  if (["error", "failed", "canceled"].includes(String(record.status))) {
    return "error";
  }
  return "done";
}

export function serializeToolResult(result: unknown): string | undefined {
  if (!hasToolResult(result)) return undefined;
  return typeof result === "string" ? result : JSON.stringify(result);
}
