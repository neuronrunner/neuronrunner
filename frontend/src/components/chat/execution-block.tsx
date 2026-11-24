"use client";

import { useEffect, useId, useMemo, useRef, useState, memo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import i18n from "@/i18n";
import {
  LuBrain,
  LuWrench,
  LuCircleX,
  LuChevronDown,
  LuTerminal,
  LuSearch,
  LuGlobe,
  LuFileCode,
  LuFileText,
  LuImage,
  LuVideo,
  LuMusic,
  LuBookmark,
  LuDatabase,
  LuBot,
  LuMonitor,
  LuLoader as LuLoader2,
} from "react-icons/lu";
import ShellTerminal from "./shell-terminal";
import AnimatedCollapse from "@/components/chat/animated-collapse";
import MarkdownRenderer from "@/components/markdown-renderer";
import MarkdownImage from "@/components/markdown-image";
import type { StreamSegment, StreamToolCall } from "@/components/chat/stream-types";
import { ToolOutputCard, normalizeMediaUrl, type ContentItem } from "@/components/content-renderer";
import { cn } from "@/lib/utils";
import { summarizeExecution } from "./execution-summary";
import { viewedImages } from "./view-image";
import DiffView, { DiffContentBlock } from "./diff-view";
import { extractToolDiff } from "./tool-diff";
import type { FileDiffData } from "@/stores/chat";

interface ExecutionBlockProps {
  segments: StreamSegment[];
  status: "streaming" | "done" | "error" | "calling";
  isRunning: boolean;
  fileDiff?: FileDiffData;
  messageUuid?: string;
}

export const formatToolName = (name: string): string => {
  if (!name) return i18n.t("chat:execution.defaultTool");
  return name
    .replace(/^mcp__/, "")
    .split("_")
    .filter(Boolean)
    .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
};

const getToolIcon = (name: string = "", size = 13): ReactNode => {
  const lower = name.toLowerCase();
  if (lower === "desktop") return <LuMonitor size={size} />;
  if (lower === "view_image" || lower === "image_search") return <LuImage size={size} />;
  if (lower.includes("search") || lower.includes("find") || lower.includes("grep") || lower.includes("query"))
    return <LuSearch size={size} />;
  if (lower.includes("fetch") || lower.includes("browse") || lower.includes("url") || lower.includes("http") || lower.includes("web"))
    return <LuGlobe size={size} />;
  if (lower.includes("terminal") || lower.includes("command") || lower.includes("bash") || lower.includes("shell") || lower.includes("exec") || lower.includes("run") || lower.includes("python"))
    return <LuTerminal size={size} />;
  if (lower.includes("edit") || lower.includes("replace") || lower.includes("write") || lower.includes("patch") || lower.includes("code"))
    return <LuFileCode size={size} />;
  if (lower.includes("file") || lower.includes("read") || lower.includes("view") || lower.includes("list") || lower.includes("dir"))
    return <LuFileText size={size} />;
  if (lower.includes("image") || lower.includes("draw") || lower.includes("paint") || lower.includes("flux") || lower.includes("dalle") || lower.includes("canvas"))
    return <LuImage size={size} />;
  if (lower.includes("video"))
    return <LuVideo size={size} />;
  if (lower.includes("music") || lower.includes("audio") || lower.includes("speech") || lower.includes("sound") || lower.includes("tts") || lower.includes("stt"))
    return <LuMusic size={size} />;
  if (lower.includes("note") || lower.includes("memory") || lower.includes("remember"))
    return <LuBookmark size={size} />;
  if (lower.includes("db") || lower.includes("database") || lower.includes("sql"))
    return <LuDatabase size={size} />;
  if (lower.includes("subagent") || lower.includes("agent"))
    return <LuBot size={size} />;
  return <LuWrench size={size} />;
};

export function extractStreamingJsonField(
  raw: string | Record<string, unknown> | undefined,
  targetKeys: string[]
): string {
  if (!raw) return "";
  if (typeof raw === "object") {
    for (const key of targetKeys) {
      const val = (raw as Record<string, unknown>)[key];
      if (typeof val === "string" && val.length > 0) return val;
      if (typeof val === "number" || typeof val === "boolean") return String(val);
    }
    return "";
  }
  if (typeof raw !== "string") return "";
  const trimmed = raw.trimStart();
  if (!trimmed) return "";

  // 1. Try complete JSON parsing first
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        for (const key of targetKeys) {
          const val = parsed[key];
          if (typeof val === "string" && val.length > 0) return val;
          if (typeof val === "number" || typeof val === "boolean") return String(val);
        }
      }
    } catch {}
  }

  // 2. If it's a plain string that doesn't start with JSON structure
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return trimmed;
  }

  // 3. Streaming/incomplete JSON extraction for targetKeys
  for (const key of targetKeys) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const keyRegex = new RegExp(`(?:["'\`]?)` + escapedKey + `(?:["'\`]?)\\s*:\\s*"`, "i");
    const match = trimmed.match(keyRegex);
    if (!match || match.index == null) continue;

    const start = match.index + match[0].length;
    let extracted = "";
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === "\\" && i + 1 < trimmed.length) {
        const next = trimmed[i + 1];
        if (next === '"') extracted += '"';
        else if (next === "\\") extracted += "\\";
        else if (next === "/") extracted += "/";
        else if (next === "n") extracted += "\n";
        else if (next === "r") extracted += "\r";
        else if (next === "t") extracted += "\t";
        else extracted += next;
        i++;
      } else if (ch === '"') {
        return extracted;
      } else {
        extracted += ch;
      }
    }
    return extracted;
  }

  return "";
}

const parseArgs = (
  args: string | Record<string, unknown> | undefined
): Record<string, unknown> | null => {
  if (!args) return null;
  if (typeof args === "object") return args;
  const trimmed = typeof args === "string" ? args.trim() : "";
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

const PRIMARY_KEYS = ["action", "query", "Query", "q", "path", "Path", "TargetFile", "file_path", "filepath", "file", "command", "CommandLine", "cmd", "script", "code", "input", "slug", "name", "url", "Url", "source", "prompt", "element", "target", "selector", "text", "expression", "function", "key"];

const getPrimaryArgument = (
  args: string | Record<string, unknown> | undefined
): string => {
  const extracted = extractStreamingJsonField(args, PRIMARY_KEYS);
  if (extracted) return extracted.slice(0, 120);

  const parsed = parseArgs(args);
  if (!parsed) {
    if (typeof args === "string" && args.length > 0 && !args.trim().startsWith("{")) return args.slice(0, 120);
    return "";
  }
  for (const key of PRIMARY_KEYS) {
    const value = parsed[key];
    if (typeof value === "string" && value.length > 0) return value.slice(0, 120);
  }
  return "";
};

export const isShellExecTool = (name?: string): boolean => {
  if (!name) return false;
  const lower = name.toLowerCase();
  return (
    lower === "shell_exec" ||
    lower === "run_command" ||
    lower === "bash" ||
    lower === "shell" ||
    lower === "exec" ||
    lower === "terminal" ||
    lower.includes("shell") ||
    lower.includes("exec")
  );
};

const SHELL_COMMAND_KEYS = ["command", "CommandLine", "cmd", "script", "code", "input"];

export const getShellCommand = (
  args: string | Record<string, unknown> | undefined
): string => {
  const extracted = extractStreamingJsonField(args, SHELL_COMMAND_KEYS);
  if (extracted) return extracted.trimStart();

  const parsed = parseArgs(args);
  if (parsed) {
    const cmd = parsed.command ?? parsed.CommandLine ?? parsed.cmd ?? parsed.script ?? parsed.code ?? parsed.input;
    if (typeof cmd === "string" && cmd.trim()) return cmd.trim();
    for (const key of Object.keys(parsed)) {
      if (typeof parsed[key] === "string" && (parsed[key] as string).trim()) {
        return (parsed[key] as string).trim();
      }
    }
  }
  if (typeof args === "string" && args.trim() && !args.trim().startsWith("{")) {
    return args.trim();
  }
  return "";
};

const tryParse = (val: any) => {
  if (typeof val !== "string") return val;
  const trimmed = val.trim();
  if ((!trimmed.startsWith("{") && !trimmed.startsWith("[")) || (!trimmed.endsWith("}") && !trimmed.endsWith("]"))) {
    return val;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}
  return val;
};

const extractMediaItem = (tool?: StreamToolCall): ContentItem | null => {
  if (!tool || !tool.result) return null;
  const parsed = tryParse(tool.result);
  if (!parsed || typeof parsed !== "object") return null;

  const rawUrl =
    parsed.content_url ||
    parsed.image_url ||
    parsed.url ||
    (parsed.b64_image ? `data:image/png;base64,${parsed.b64_image}` : undefined) ||
    (typeof parsed.image === "string" && (parsed.image.startsWith("http") || parsed.image.startsWith("data:image") || parsed.image.includes(".")) ? parsed.image : undefined);

  if (!rawUrl) return null;
  const contentUrl = normalizeMediaUrl(rawUrl);

  const parsedArgs = parseArgs(tool.arguments);

  return {
    content_url: contentUrl,
    mime: parsed.mime || (contentUrl.startsWith("data:image") ? "image/png" : undefined),
    return_type: parsed.return_type || (parsed.mime?.startsWith("video/") ? "video" : "image"),
    size_bytes: parsed.size_bytes,
    execution_id: parsed.execution_id,
    cost_usd: parsed.cost_usd,
    title: parsed.title || (tool.name ? formatToolName(tool.name) : i18n.t("chat:execution.generatedOutput")),
    duration_seconds: parsed.duration_seconds || (tool.durationMs ? tool.durationMs / 1000 : undefined),
    prompt: parsed.prompt || (parsedArgs?.prompt as string | undefined),
    seed: parsed.seed ?? (parsedArgs?.seed as number | undefined),
    width: parsed.width ?? (parsedArgs?.width as number | undefined),
    height: parsed.height ?? (parsedArgs?.height as number | undefined),
  };
};

const formatDuration = (ms?: number): string => {
  if (!ms || ms <= 0) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
};

const isEditTool = (name: string): boolean =>
  /edit|patch|write|replace|rename|delete|remove|upload|mkdir|create_file/.test(name.toLowerCase());

const toolLabel = (
  t: TFunction<"chat">,
  tool: StreamToolCall,
): string => {
  if (tool.name.startsWith("mcp__") && tool.title) return tool.title;
  const lower = tool.name.toLowerCase();
  if (isShellExecTool(lower)) return t("execution.shell");
  if (lower === "view_image") return t("execution.viewImage");
  if (/file_read|read_file|view_file|cat/.test(lower)) return t("execution.read");
  if (/glob|grep|find|search/.test(lower)) return t("execution.search");
  if (isEditTool(lower)) return t("execution.edit");
  if (tool.title) return tool.title;
  return formatToolName(tool.name);
};

type ActivityItem =
  | { kind: "thinking"; segment: StreamSegment }
  | { kind: "tool"; tool: StreamToolCall };

function buildActivityItems(segments: StreamSegment[], hideEditTools: boolean): ActivityItem[] {
  const items: ActivityItem[] = [];
  const toolIndices = new Map<string, number>();
  for (const segment of segments) {
    if (segment.kind === "thinking") {
      items.push({ kind: "thinking", segment });
      continue;
    }
    const tools = segment.tools || (segment.tool ? [segment.tool] : []);
    for (const tool of tools) {
      if (!tool?.name?.trim()) continue;
      if (hideEditTools && isEditTool(tool.name)) continue;
      const existingIndex = toolIndices.get(tool.id);
      if (existingIndex != null) {
        const existing = items[existingIndex];
        if (existing.kind === "tool") {
          existing.tool = {
            ...existing.tool,
            ...tool,
            result: tool.result ?? existing.tool.result,
            output: tool.output ?? existing.tool.output,
            durationMs: tool.durationMs ?? existing.tool.durationMs,
          };
        }
        continue;
      }
      toolIndices.set(tool.id, items.length);
      items.push({ kind: "tool", tool });
    }
  }
  return items;
}

function ActivityRow({
  label,
  detail,
  duration,
  additions,
  deletions,
  icon,
  error,
  expandable,
  open,
  onToggle,
  children,
}: {
  label: string;
  detail?: string;
  duration?: string;
  additions?: number;
  deletions?: number;
  icon: ReactNode;
  error?: boolean;
  expandable?: boolean;
  open?: boolean;
  onToggle?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={expandable ? onToggle : undefined}
        aria-expanded={expandable ? Boolean(open) : undefined}
        className={cn(
          "group flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
          expandable ? "cursor-pointer hover:bg-muted/40" : "cursor-default",
        )}
      >
        <span className={cn("mt-0.5 shrink-0", error ? "text-red-400" : "text-muted-foreground")}>{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={cn("truncate text-[11px] font-medium", error ? "text-red-400" : "text-foreground")}>{label}</span>
            {((additions ?? 0) > 0 || (deletions ?? 0) > 0) && (
              <span className="flex shrink-0 items-center gap-1 font-mono text-[10px]">
                {(additions ?? 0) > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>}
                {(deletions ?? 0) > 0 && <span className="text-rose-600 dark:text-rose-400">-{deletions}</span>}
              </span>
            )}
            {duration && <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">{duration}</span>}
          </span>
          {detail && (
            <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground/80" title={detail}>
              {detail}
            </span>
          )}
        </span>
        {expandable && (
          <LuChevronDown
            className={cn(
              "mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              open && "rotate-180",
            )}
          />
        )}
      </button>
      {expandable && (
        <AnimatedCollapse in={Boolean(open)}>
          <div className="mb-1 ml-6 mr-1 mt-1 min-w-0">{children}</div>
        </AnimatedCollapse>
      )}
    </div>
  );
}

const ThinkingActivity = memo(function ThinkingActivity({ segment }: { segment: StreamSegment }) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const streaming = segment.status === "streaming" || segment.status === "calling";
  const content = (segment.content || "").replace(/<\/?think>/gi, "").trim();
  if (!content && !streaming) return null;
  return (
    <ActivityRow
      label={t("execution.thought")}
      icon={streaming ? <LuLoader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" /> : <LuBrain size={13} />}
      duration={formatDuration(segment.durationMs)}
      expandable={Boolean(content)}
      open={open}
      onToggle={() => setOpen((value) => !value)}
    >
      <div className="rounded-xl border border-border/50 bg-muted/20 p-3 text-xs text-muted-foreground shadow-inner">
        <MarkdownRenderer markdown={content} />
      </div>
    </ActivityRow>
  );
});

const ShellActivity = memo(function ShellActivity({ tool }: { tool: StreamToolCall }) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const command = getShellCommand(tool.arguments);
  const error = tool.status === "error";
  return (
    <ActivityRow
      label={t("execution.shell")}
      detail={command}
      duration={formatDuration(tool.durationMs)}
      icon={error ? <LuCircleX size={13} className="text-red-400" /> : <LuTerminal size={13} />}
      error={error}
      expandable
      open={open}
      onToggle={() => setOpen((value) => !value)}
    >
      <ShellTerminal tool={tool} command={command} />
    </ActivityRow>
  );
});

const formatToolOutput = (tool: StreamToolCall): string => {
  const rawOutput = tool.output || tool.result || "";
  const parsed = tryParse(rawOutput);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const keys = Object.keys(parsed);
    const isWrapper =
      "output" in parsed &&
      keys.every((k) => k === "output" || k === "status" || k === "is_error");
    if (isWrapper) {
      const inner = typeof parsed.output === "string" ? parsed.output : "";
      if (inner.trim()) return inner;
      if (parsed.status === "error" || parsed.is_error) {
        return JSON.stringify(parsed, null, 2);
      }
      // Fall through to argument-based edit diff if output was empty
    } else {
      return JSON.stringify(parsed, null, 2);
    }
  } else if (typeof rawOutput === "string" && rawOutput.trim()) {
    return rawOutput;
  }

  if (isEditTool(tool.name)) {
    const args = parseArgs(tool.arguments);
    if (args) {
      const pairs: [string, string][] = [
        ["Target", "Replacement"],
        ["TargetContent", "ReplacementContent"],
        ["old_string", "new_string"],
        ["old_str", "new_str"],
      ];
      for (const [oldKey, newKey] of pairs) {
        const oldVal = args[oldKey];
        const newVal = args[newKey];
        if (typeof oldVal === "string" && typeof newVal === "string" && (oldVal || newVal)) {
          const path = String(args.Path ?? args.path ?? args.file_path ?? "file");
          const oldLines = oldVal.split("\n").map((l) => `-${l}`);
          const newLines = newVal.split("\n").map((l) => `+${l}`);
          return [`--- a/${path}`, `+++ b/${path}`, ...oldLines, ...newLines].join("\n");
        }
      }
      const content = args.Content ?? args.content ?? args.CodeContent;
      if (typeof content === "string" && content) {
        const path = String(args.Path ?? args.path ?? args.file_path ?? "file");
        const lines = content.split("\n").slice(0, 120).map((l) => `+${l}`);
        return [`--- /dev/null`, `+++ b/${path}`, ...lines].join("\n");
      }
    }
  }
  return "";
};

const isUnifiedDiffText = (text: string): boolean =>
  text.startsWith("--- ") || text.startsWith("@@ ") || text.startsWith("diff ");

const ToolActivity = memo(function ToolActivity({ tool }: { tool: StreamToolCall }) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const error = tool.status === "error";
  const detail = tool.primaryArg || getPrimaryArgument(tool.arguments);
  const isMedia = tool.name === "view_image" || tool.name === "desktop";
  const output = useMemo(() => (isMedia ? "" : formatToolOutput(tool)), [isMedia, tool]);
  const diffInfo = useMemo(() => (isEditTool(tool.name) ? extractToolDiff(tool) : null), [tool]);
  const hasDetails = Boolean(diffInfo?.rawDiff || (!isMedia && output.trim()));
  const isDiff = !diffInfo?.rawDiff && hasDetails && isUnifiedDiffText(output);
  return (
    <ActivityRow
      label={toolLabel(t, tool)}
      detail={detail}
      duration={formatDuration(tool.durationMs)}
      additions={diffInfo?.additions}
      deletions={diffInfo?.deletions}
      icon={error ? <LuCircleX size={13} className="text-red-400" /> : getToolIcon(tool.name, 13)}
      error={error}
      expandable={hasDetails}
      open={open}
      onToggle={() => setOpen((value) => !value)}
    >
      {diffInfo?.rawDiff ? (
        <div className="space-y-2">
          <DiffContentBlock rawDiff={diffInfo.rawDiff} />
          {error && output.trim() && output.trim() !== diffInfo.rawDiff && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-red-500/30 bg-red-500/10 p-3 font-mono text-[11px] leading-relaxed text-red-400">
              {output}
            </pre>
          )}
        </div>
      ) : isDiff ? (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border/50 bg-muted/20 p-3 font-mono text-[11px] leading-relaxed">
          {output.split("\n").map((line, idx) => {
            const cls =
              line.startsWith("+") && !line.startsWith("+++")
                ? "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 block"
                : line.startsWith("-") && !line.startsWith("---")
                  ? "text-rose-600 dark:text-rose-400 bg-rose-500/10 block"
                  : line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")
                    ? "text-muted-foreground/70 block"
                    : "text-muted-foreground block";
            return (
              <span key={idx} className={cls}>
                {line || " "}
              </span>
            );
          })}
        </pre>
      ) : (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border/50 bg-muted/20 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {output}
        </pre>
      )}
    </ActivityRow>
  );
});

function ViewImagePreview({ tool, showLabel = false }: { tool: StreamToolCall; showLabel?: boolean }) {
  const { t } = useTranslation("chat");
  const images = viewedImages(tool.result);
  if (!images.length) return null;
  return <div className="ml-6 mt-1.5 mr-1" data-view-image-preview>
    {showLabel && <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium"><LuImage size={13} />{t("execution.viewImage")}</div>}
    <div className="flex flex-wrap gap-2">
      {images.map((image, index) => <MarkdownImage key={`${tool.id}-${index}`} source={image.url} alt={image.source} title={image.source} thumbnail />)}
    </div>
  </div>;
}

const ExecutionBlock = memo(function ExecutionBlock({ segments, status, isRunning: running, fileDiff, messageUuid }: ExecutionBlockProps) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(running);
  const userToggled = useRef(false);
  const detailsId = useId();
  const summary = useMemo(() => summarizeExecution(segments), [segments]);
  const activity = useMemo(() => buildActivityItems(segments, Boolean(fileDiff?.files?.length)), [segments, fileDiff]);
  const mediaItems = useMemo(() => summary.tools.flatMap(tool => {
    if (tool.name === "view_image" || tool.name === "desktop") return [];
    const item = extractMediaItem(tool);
    return item ? [{ id: tool.id, item, markdown: tool.name === "display_image" }] : [];
  }), [summary.tools]);
  const imageTools = useMemo(
    () => summary.tools.filter(tool => tool.name === "view_image" || tool.name === "desktop"),
    [summary.tools],
  );
  const hasError = summary.errorCount > 0 || status === "error";
  const count = summary.tools.length;

  useEffect(() => {
    if (!userToggled.current) setOpen(running);
  }, [running]);

  const toggle = () => {
    userToggled.current = true;
    setOpen((value) => !value);
  };

  const summaryKeys = {
    files: "execution.summary.files",
    commands: "execution.summary.commands",
    changes: "execution.summary.changes",
    searches: "execution.summary.searches",
    agents: "execution.summary.agents",
    other: "execution.summary.other",
  } as const;
  const completedTitle = summary.categories.length
    ? summary.categories
        .map((category) => {
          const key = summaryKeys[category.label.toLowerCase() as keyof typeof summaryKeys];
          return t(key, { count: category.count });
        })
        .join(" · ")
    : t(summary.thinkingCount === 1 ? "execution.stepsOne" : "execution.stepsOther", { count: summary.thinkingCount });
  const title = running
    ? t("execution.working")
    : count
      ? completedTitle
      : summary.thinkingCount
        ? t(summary.thinkingCount === 1 ? "execution.stepsOne" : "execution.stepsOther", { count: summary.thinkingCount })
        : t("execution.responseDetails");
  const activeArg = summary.activeTool ? getPrimaryArgument(summary.activeTool.arguments) : "";
  const subtitle = running
    ? summary.activeTool
      ? `${toolLabel(t, summary.activeTool)}${activeArg ? ` · ${activeArg}` : ""}`
      : t("execution.preparingNextStep")
    : "";
  const Icon = running ? LuLoader2 : hasError ? LuCircleX : count ? LuWrench : LuBrain;
  const markdownImages = mediaItems.filter(media => media.markdown).map(({ item }) => `![${(item.title || t("execution.imageFallback")).replace(/[\\\[\]]/g, "\\$&")}](<${item.content_url.replace(/>/g, "%3E")}>)`).join("\n\n");

  if (segments.length === 0) return null;
  if (markdownImages && summary.thinkingCount === 0 && summary.tools.every(tool => tool.name === "display_image")) return <MarkdownRenderer markdown={markdownImages} />;

  return (
    <div className="my-2 min-w-0 pl-1 relative isolate" data-execution-group data-status={running ? "running" : hasError ? "error" : "done"}>
      <button type="button" onClick={toggle} aria-expanded={open} aria-controls={detailsId}
        aria-label={open ? t("execution.hideActivityDetails") : t("execution.showActivityDetails")}
        className="group flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/60", hasError ? "text-red-500" : "text-muted-foreground")}>
          <Icon className={cn("h-3.5 w-3.5", running && "animate-spin motion-reduce:animate-none")} />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 text-xs font-medium text-foreground">{title}</span>
          {subtitle && <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={subtitle}>{subtitle}</span>}
        </span>
        {hasError && <span className="shrink-0 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-500">{summary.errorCount ? t("execution.failedCount", { count: summary.errorCount }) : t("execution.error")}</span>}
        <LuChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-180")} />
      </button>
      <AnimatedCollapse in={open}>
        <div id={detailsId} role="region" aria-label={t("execution.activityDetails")} className="mt-2 space-y-1">
          {activity.map((item) =>
            item.kind === "thinking" ? (
              <ThinkingActivity
                key={item.segment.key || `thinking-${item.segment.segIdx}`}
                segment={item.segment}
              />
            ) : isShellExecTool(item.tool.name) ? (
              <ShellActivity key={item.tool.id} tool={item.tool} />
            ) : (
              <ToolActivity key={item.tool.id} tool={item.tool} />
            ),
          )}
        </div>
      </AnimatedCollapse>
      {fileDiff && (
        <div className="mt-2">
          <DiffView diff={fileDiff} messageUuid={messageUuid} compact />
        </div>
      )}
      {/* Generated artifacts and viewed screenshots stay visible when collapsed. */}
      {imageTools.map(tool => <ViewImagePreview key={tool.id} tool={tool} showLabel={tool.name === "view_image"} />)}
      {mediaItems.filter(media => !media.markdown).map(({ id, item }) => <div key={id} className="my-2.5"><ToolOutputCard item={item} /></div>)}
      {markdownImages && <MarkdownRenderer markdown={markdownImages} />}
    </div>
  );
});

export default ExecutionBlock;
