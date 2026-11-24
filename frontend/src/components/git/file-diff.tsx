"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuLoaderCircle } from "react-icons/lu";
import { repositoryError, repositoryUnavailable, repositoryRequest } from "@/lib/repository-api";
import { cn } from "@/lib/utils";

export function FileDiff({ uuid, path, file, revision, mode = "all", onRepositoryUnavailable }: { uuid: string; path: string; file: string; revision: number; mode?: "all" | "staged" | "unstaged"; onRepositoryUnavailable: (path: string) => void }) {
  const { t } = useTranslation("git");
  const [result, setResult] = useState<{ diff: string; message?: string; truncated?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    setError(null);
    repositoryRequest<{ diff: string; message?: string; truncated?: boolean }>(uuid, "git/file-diff", { path, file, mode }, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setResult(data); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (repositoryUnavailable(cause)) onRepositoryUnavailable(path);
        else setError(repositoryError(cause));
      });
    return () => controller.abort();
  }, [uuid, path, file, revision, mode, onRepositoryUnavailable]);
  if (error) return <p role="alert" className="p-3 text-xs text-destructive">{error}</p>;
  if (!result) return <p role="status" className="flex items-center gap-2 p-4 text-xs text-muted-foreground"><LuLoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />{t("fileDiff.loading")}</p>;
  if (!result.diff) return <p className="p-3 text-xs text-muted-foreground">{result.message || t("fileDiff.noChanges")}</p>;
  const lines = result.diff.split("\n");
  const additions = lines.filter(line => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = lines.filter(line => line.startsWith("-") && !line.startsWith("---")).length;
  return <div className="border-t border-border bg-muted/10">
    <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-[10px] text-muted-foreground"><span>{t("fileDiff.preview")}</span><span className="flex gap-2 font-mono"><span className="text-emerald-700 dark:text-emerald-400">+{additions}</span><span className="text-rose-700 dark:text-rose-400">−{deletions}</span></span></div>
    <div tabIndex={0} role="region" aria-label={t("fileDiff.diffForFile", { file })} className="max-h-80 overflow-auto"><pre className="min-w-max py-2 font-mono text-[11px] leading-5">{lines.map((line, index) => <div key={index} className={cn("px-3", line.startsWith("+") && !line.startsWith("+++") && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", line.startsWith("-") && !line.startsWith("---") && "bg-rose-500/10 text-rose-700 dark:text-rose-300", line.startsWith("@@") && "bg-indigo-500/10 text-indigo-600 dark:text-indigo-300")}>{line || " "}</div>)}</pre></div>
    {result.truncated && <p className="border-t border-border p-3 text-xs text-muted-foreground">{t("fileDiff.truncated")}</p>}
  </div>;
}
