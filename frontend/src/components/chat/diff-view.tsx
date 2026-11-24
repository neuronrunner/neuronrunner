"use client";

import { useState, useMemo, memo } from "react";
import { useTranslation } from "react-i18next";
import {
  LuGitCompare,
  LuUndo2,
  LuCheck,
  LuFileCode,
  LuFilePlus,
  LuFileMinus,
  LuFileText,
  LuChevronDown,
  LuChevronRight,
  LuLoader as LuLoader2,
  LuCopy,
} from "react-icons/lu";
import useChatStore, { type FileDiffData, type FileChangeItem } from "@/stores/chat";
import useSandboxProjectsStore from "@/stores/sandbox-projects";
import { toaster } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";

interface DiffViewProps {
  diff: FileDiffData;
  messageUuid?: string;
  compact?: boolean;
}

const FileStatusBadge = memo(function FileStatusBadge({
  status,
}: {
  status: FileChangeItem["status"];
}) {
  const { t } = useTranslation("chat");

  if (status === "added") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
        <LuFilePlus className="h-3 w-3" />
        {t("diff.status.added")}
      </span>
    );
  }
  if (status === "deleted") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/20">
        <LuFileMinus className="h-3 w-3" />
        {t("diff.status.deleted")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20">
      <LuFileCode className="h-3 w-3" />
      {t("diff.status.modified")}
    </span>
  );
});

export const DiffContentBlock = memo(function DiffContentBlock({
  rawDiff,
}: {
  rawDiff: string;
}) {
  const { t } = useTranslation("chat");
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(rawDiff);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toaster.create({ title: t("diff.copiedToClipboard"), type: "success" });
  };

  const lines = useMemo(() => rawDiff.split("\n"), [rawDiff]);

  return (
    <div className="relative mt-2 rounded-lg border border-border/60 bg-zinc-950 font-mono text-[12px] leading-5 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1 bg-zinc-900 border-b border-border/40 text-zinc-400 text-[11px]">
        <span>{t("diff.preview")}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 hover:text-zinc-200 transition-colors"
          title={t("diff.copyDiff")}
        >
          {copied ? <LuCheck className="h-3 w-3 text-emerald-400" /> : <LuCopy className="h-3 w-3" />}
          <span>{copied ? t("diff.copied") : t("diff.copy")}</span>
        </button>
      </div>
      <div className="max-h-72 overflow-y-auto overflow-x-auto p-2">
        {lines.map((line, idx) => {
          let lineCls = "text-zinc-400";
          if (line.startsWith("+") && !line.startsWith("+++")) {
            lineCls = "bg-emerald-950/60 text-emerald-300 font-medium";
          } else if (line.startsWith("-") && !line.startsWith("---")) {
            lineCls = "bg-rose-950/60 text-rose-300 font-medium";
          } else if (line.startsWith("@@")) {
            lineCls = "text-cyan-400 font-semibold bg-cyan-950/30";
          } else if (
            line.startsWith("diff ") ||
            line.startsWith("index ") ||
            line.startsWith("--- ") ||
            line.startsWith("+++ ")
          ) {
            lineCls = "text-zinc-500 font-semibold";
          }
          return (
            <div key={idx} className={cn("px-2 py-0.5 whitespace-pre rounded-sm", lineCls)}>
              {line || " "}
            </div>
          );
        })}
      </div>
    </div>
  );
});

export const DiffView = memo(function DiffView({
  diff,
  messageUuid,
  compact = false,
}: DiffViewProps) {
  const { t } = useTranslation("chat");
  const undoSandboxChanges = useChatStore((state) => state.undoSandboxChanges);
  const conversationId = useChatStore((state) => state.conversationId);
  const currentSandbox = useSandboxProjectsStore((state) => state.currentSandbox);
  const sandboxes = useSandboxProjectsStore((state) => state.sandboxes);
  const sandboxConversations = useSandboxProjectsStore((state) => state.sandboxConversations);

  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
  const [isUndoing, setIsUndoing] = useState(false);
  const [showAllFiles, setShowAllFiles] = useState(true);

  const effectiveSandboxUuid = useMemo(() => {
    if (currentSandbox?.uuid) return currentSandbox.uuid;
    if (conversationId) {
      const matched = sandboxes.find(
        (s) => s.conversation === conversationId || (sandboxConversations[s.uuid] || []).includes(conversationId)
      );
      if (matched) return matched.uuid;
    }
    return sandboxes[0]?.uuid || null;
  }, [currentSandbox, sandboxes, sandboxConversations, conversationId]);

  const toggleFile = (path: string) => {
    setExpandedFiles((prev) => ({
      ...prev,
      [path]: !prev[path],
    }));
  };

  const handleUndo = async () => {
    if (!effectiveSandboxUuid) {
      toaster.create({
        title: t("diff.undoFailed"),
        description: t("diff.noSandboxError"),
        type: "error",
      });
      return;
    }

    setIsUndoing(true);
    try {
      const res = await undoSandboxChanges(effectiveSandboxUuid, messageUuid);
      if (res.ok) {
        toaster.create({
          title: t("diff.changesUndone"),
          description: t("diff.changesUndoneDescription"),
          type: "success",
        });
      } else {
        toaster.create({
          title: t("diff.undoFailed"),
          description: res.error || t("diff.revertError"),
          type: "error",
        });
      }
    } catch (err: any) {
      toaster.create({
        title: t("diff.undoFailed"),
        description: err?.message || t("diff.unexpectedRevertError"),
        type: "error",
      });
    } finally {
      setIsUndoing(false);
    }
  };

  if (!diff || (!diff.has_changes && (!diff.files || diff.files.length === 0))) {
    return null;
  }

  const isUndone = Boolean(diff.undone);
  const files = diff.files || [];
  const fileCount = files.length;

  if (compact) {
    return (
      <div className="mb-2 space-y-1.5" data-compact-diff>
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
            <LuGitCompare className="h-3 w-3 shrink-0" />
            <span className="truncate">
              {fileCount === 1 ? t("diff.filesModifiedOne") : t("diff.filesModifiedOther", { count: fileCount })}
            </span>
            <span className="flex shrink-0 items-center gap-1 font-mono">
              {diff.total_additions > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{diff.total_additions}</span>}
              {diff.total_deletions > 0 && <span className="text-rose-600 dark:text-rose-400">-{diff.total_deletions}</span>}
            </span>
          </div>
          {isUndone ? (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <LuCheck className="h-3 w-3 text-emerald-500" />
              {t("diff.undone")}
            </span>
          ) : (
            <button
              type="button"
              onClick={handleUndo}
              disabled={isUndoing}
              title={t("diff.undoTooltip")}
              aria-label={t("diff.undo")}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-50 disabled:pointer-events-none"
            >
              {isUndoing ? <LuLoader2 className="h-3 w-3 animate-spin" /> : <LuUndo2 className="h-3 w-3" />}
            </button>
          )}
        </div>
        {files.map((file) => {
          const isExpanded = Boolean(expandedFiles[file.path]);
          const fileDiff = file.diff || diff.raw_diff || "";
          return (
            <div key={file.path} className="overflow-hidden rounded-lg border border-border/60 bg-card/40">
              <button
                type="button"
                onClick={() => toggleFile(file.path)}
                aria-expanded={isExpanded}
                className="flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-muted/30"
              >
                {isExpanded ? (
                  <LuChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                ) : (
                  <LuChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                )}
                <LuFileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/90" title={file.path}>
                  {file.path}
                </span>
                <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px]">
                  {file.additions > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>}
                  {file.deletions > 0 && <span className="text-rose-600 dark:text-rose-400">-{file.deletions}</span>}
                </span>
              </button>
              {isExpanded && fileDiff && (
                <div className="px-2 pb-2"><DiffContentBlock rawDiff={fileDiff} /></div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="mt-3 w-full rounded-xl border border-border/70 bg-card/60 backdrop-blur-sm shadow-sm overflow-hidden text-sm">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3.5 py-2.5 bg-muted/40 border-b border-border/50">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center justify-center h-6 w-6 rounded-md bg-primary/10 text-primary">
            <LuGitCompare className="h-3.5 w-3.5" />
          </div>
          <span className="font-medium text-xs text-foreground truncate">
            {fileCount === 1 ? t("diff.filesModifiedOne") : t("diff.filesModifiedOther", { count: fileCount })}
          </span>
          <div className="flex items-center gap-1.5 text-xs font-mono">
            {diff.total_additions > 0 && (
              <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                +{diff.total_additions}
              </span>
            )}
            {diff.total_deletions > 0 && (
              <span className="text-rose-600 dark:text-rose-400 font-medium">
                -{diff.total_deletions}
              </span>
            )}
          </div>
        </div>

        {/* Undo Action */}
        <div className="flex items-center gap-2">
          {isUndone ? (
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-muted text-muted-foreground border border-border/50">
              <LuCheck className="h-3 w-3 text-emerald-500" />
              <span>{t("diff.undone")}</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleUndo}
              disabled={isUndoing}
              className={cn(
                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors shadow-sm",
                "bg-zinc-800 text-zinc-100 hover:bg-zinc-700 dark:bg-zinc-700 dark:hover:bg-zinc-600",
                "disabled:opacity-50 disabled:pointer-events-none"
              )}
              title={t("diff.undoTooltip")}
            >
              {isUndoing ? (
                <>
                  <LuLoader2 className="h-3 w-3 animate-spin" />
                  <span>{t("diff.reverting")}</span>
                </>
              ) : (
                <>
                  <LuUndo2 className="h-3 w-3" />
                  <span>{t("diff.undo")}</span>
                </>
              )}
            </button>
          )}

          <button
            type="button"
            onClick={() => setShowAllFiles((v) => !v)}
            className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
            title={showAllFiles ? t("diff.collapseFileList") : t("diff.expandFileList")}
          >
            {showAllFiles ? (
              <LuChevronDown className="h-3.5 w-3.5" />
            ) : (
              <LuChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Files list */}
      {showAllFiles && (
        <div className="divide-y divide-border/30">
          {files.map((file) => {
            const isExpanded = Boolean(expandedFiles[file.path]);
            const fileDiff = file.diff || diff.raw_diff || "";

            return (
              <div key={file.path} className="px-3.5 py-2 hover:bg-muted/20 transition-colors">
                <div
                  className="flex items-center justify-between gap-2 cursor-pointer select-none"
                  onClick={() => toggleFile(file.path)}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {isExpanded ? (
                      <LuChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
                    ) : (
                      <LuChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                    )}
                    <LuFileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="font-mono text-xs text-foreground/90 truncate">
                      {file.path}
                    </span>
                    <FileStatusBadge status={file.status} />
                  </div>

                  <div className="flex items-center gap-1.5 text-xs font-mono shrink-0">
                    {file.additions > 0 && (
                      <span className="text-emerald-600 dark:text-emerald-400">
                        +{file.additions}
                      </span>
                    )}
                    {file.deletions > 0 && (
                      <span className="text-rose-600 dark:text-rose-400">
                        -{file.deletions}
                      </span>
                    )}
                  </div>
                </div>

                {isExpanded && fileDiff && (
                  <DiffContentBlock rawDiff={fileDiff} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

export default DiffView;
