import type { StreamToolCall } from "@/components/chat/stream-types";

export interface ToolDiffInfo {
  rawDiff: string;
  additions: number;
  deletions: number;
}

const EDIT_PAIRS: ReadonlyArray<[string, string]> = [
  ["find", "replace"],
  ["old_string", "new_string"],
  ["old_str", "new_str"],
  ["Target", "Replacement"],
  ["TargetContent", "ReplacementContent"],
  ["old", "new"],
  ["search", "replace"],
];

const MAX_WRITE_PREVIEW_LINES = 200;
const MAX_LCS_CELLS = 250_000;

function parseArgs(raw: StreamToolCall["arguments"]): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function getFilePath(args: Record<string, unknown> | null): string {
  if (!args) return "file";
  const candidate =
    args.path ??
    args.file_path ??
    args.filepath ??
    args.Path ??
    args.TargetFile ??
    args.target_file;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : "file";
}

function countDiffStats(rawDiff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of rawDiff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

function looksLikeUnifiedDiff(text: string): boolean {
  if (!text) return false;
  const lines = text.split("\n");
  const hasHunk = lines.some((line) => line.startsWith("@@ "));
  const hasChange = lines.some(
    (line) =>
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---")),
  );
  return hasHunk && hasChange;
}

function extractDiffFromOutput(tool: StreamToolCall): string | null {
  const candidates: string[] = [];
  if (typeof tool.output === "string" && tool.output.trim()) {
    candidates.push(tool.output);
  }
  if (typeof tool.result === "string" && tool.result.trim()) {
    candidates.push(tool.result);
    try {
      const parsed = JSON.parse(tool.result);
      if (parsed && typeof parsed === "object" && typeof parsed.diff === "string") {
        candidates.unshift(parsed.diff);
      }
    } catch {
      // Not JSON; keep raw string candidate.
    }
  } else if (tool.result && typeof tool.result === "object") {
    const maybeDiff = (tool.result as Record<string, unknown>).diff;
    if (typeof maybeDiff === "string" && maybeDiff.trim()) {
      candidates.unshift(maybeDiff);
    }
  }

  for (const candidate of candidates) {
    if (looksLikeUnifiedDiff(candidate)) {
      return candidate.trimEnd();
    }
  }
  return null;
}

function computeLineDiffOps(
  oldLines: string[],
  newLines: string[],
): Array<{ type: " " | "-" | "+"; text: string }> {
  const m = oldLines.length;
  const n = newLines.length;

  if (m * n > MAX_LCS_CELLS) {
    return [
      ...oldLines.map((text) => ({ type: "-" as const, text })),
      ...newLines.map((text) => ({ type: "+" as const, text })),
    ];
  }

  // Standard DP LCS table for clean inline diff hunks.
  const dp = new Uint32Array((m + 1) * (n + 1));
  const width = n + 1;
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i * width + j] = dp[(i + 1) * width + (j + 1)] + 1;
      } else {
        const down = dp[(i + 1) * width + j];
        const right = dp[i * width + (j + 1)];
        dp[i * width + j] = down >= right ? down : right;
      }
    }
  }

  const ops: Array<{ type: " " | "-" | "+"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: " ", text: oldLines[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      ops.push({ type: "-", text: oldLines[i] });
      i++;
    } else {
      ops.push({ type: "+", text: newLines[j] });
      j++;
    }
  }
  while (i < m) {
    ops.push({ type: "-", text: oldLines[i++] });
  }
  while (j < n) {
    ops.push({ type: "+", text: newLines[j++] });
  }
  return ops;
}

function buildHunk(oldText: string, newText: string): string[] {
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  const ops = computeLineDiffOps(oldLines, newLines);
  const header = `@@ -1,${oldLines.length} +1,${newLines.length} @@`;
  return [header, ...ops.map((op) => `${op.type}${op.text}`)];
}

function findOldNewPair(obj: Record<string, unknown>): [string, string] | null {
  for (const [oldKey, newKey] of EDIT_PAIRS) {
    const oldVal = obj[oldKey];
    const newVal = obj[newKey];
    if (typeof oldVal === "string" && typeof newVal === "string" && (oldVal || newVal)) {
      return [oldVal, newVal];
    }
  }
  return null;
}

/**
 * Extract or synthesize a unified diff for an edit/write tool call so the UI
 * can render a color-coded diff preview even when backend git diffs are absent.
 */
export function extractToolDiff(tool: StreamToolCall): ToolDiffInfo | null {
  const existing = extractDiffFromOutput(tool);
  if (existing) {
    const stats = countDiffStats(existing);
    return { rawDiff: existing, ...stats };
  }

  const args = parseArgs(tool.arguments);
  if (!args) return null;

  const filePath = getFilePath(args);
  const hunks: string[] = [];

  const multiEdits = Array.isArray(args.edits)
    ? args.edits
    : Array.isArray(args.ReplacementChunks)
      ? args.ReplacementChunks
      : null;

  if (multiEdits) {
    for (const entry of multiEdits) {
      if (!entry || typeof entry !== "object") continue;
      const pair = findOldNewPair(entry as Record<string, unknown>);
      if (pair) {
        hunks.push(...buildHunk(pair[0], pair[1]));
      }
    }
  } else {
    const pair = findOldNewPair(args);
    if (pair) {
      hunks.push(...buildHunk(pair[0], pair[1]));
    }
  }

  if (hunks.length > 0) {
    const rawDiff = [`--- a/${filePath}`, `+++ b/${filePath}`, ...hunks].join("\n");
    return { rawDiff, ...countDiffStats(rawDiff) };
  }

  const lowerName = (tool.name || "").toLowerCase();
  if (/write|create_file/.test(lowerName)) {
    const content = args.content ?? args.Content ?? args.CodeContent ?? args.text;
    if (typeof content === "string" && content.length > 0) {
      const lines = content.split(/\r?\n/);
      const truncated = lines.length > MAX_WRITE_PREVIEW_LINES;
      const previewLines = lines.slice(0, MAX_WRITE_PREVIEW_LINES);
      const diffLines = [
        "--- /dev/null",
        `+++ b/${filePath}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...previewLines.map((line) => `+${line}`),
      ];
      if (truncated) {
        diffLines.push(`... (${lines.length - MAX_WRITE_PREVIEW_LINES} more lines)`);
      }
      return {
        rawDiff: diffLines.join("\n"),
        additions: lines.length,
        deletions: 0,
      };
    }
  }

  return null;
}
