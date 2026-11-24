"use client";

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LuArrowRight, LuGitBranch, LuGitMerge, LuGitPullRequest, LuInbox } from "react-icons/lu";
import { Skeleton } from "@/components/ui/skeleton";
import type { PullRequest } from "@/lib/repository-api";
import { cn } from "@/lib/utils";

export function PullStatus({ state }: { state: PullRequest["state"] }) {
  const { t } = useTranslation("git");
  const Icon = state === "merged" ? LuGitMerge : LuGitPullRequest;
  const label =
    state === "open"
      ? t("status.open")
      : state === "merged"
        ? t("status.merged")
        : state === "closed"
          ? t("status.closed")
          : state;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium capitalize",
      state === "open" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" :
      state === "merged" ? "bg-violet-500/10 text-violet-700 dark:text-violet-400" :
      state === "closed" ? "bg-rose-500/10 text-rose-700 dark:text-rose-400" : "bg-muted text-muted-foreground")}
    >
      <Icon aria-hidden className="h-3.5 w-3.5" />{label}
    </span>
  );
}

export function BranchComparison({ head, base }: { head: string; base: string }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-[11px] text-muted-foreground" title={`${head} → ${base}`}>
      <LuGitBranch aria-hidden className="h-3 w-3 shrink-0" />
      <span className="min-w-0 truncate rounded bg-muted/70 px-1.5 py-0.5 font-mono">{head}</span>
      <LuArrowRight aria-hidden className="h-3 w-3 shrink-0" />
      <span className="min-w-0 truncate rounded bg-muted/70 px-1.5 py-0.5 font-mono">{base}</span>
    </span>
  );
}

export function RepositoryTimestamp({ value, prefix = "" }: { value: string; prefix?: string }) {
  const { i18n } = useTranslation("git");
  const locale = i18n.resolvedLanguage || "en";
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return null;
  return <time dateTime={value} title={date.toLocaleString(locale)}>{prefix}{date.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" })}</time>;
}

export function RepositoryEmptyState({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border bg-card/50 px-5 py-12 text-center">
      <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-border bg-background text-muted-foreground"><LuInbox aria-hidden className="h-5 w-5" /></span>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-2 max-w-xs text-xs leading-relaxed text-muted-foreground">{description}</p>
      {children && <div className="mt-5">{children}</div>}
    </div>
  );
}

export function RepositoryLoading({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="overflow-hidden rounded-xl border border-border bg-card">
      <span className="sr-only">{label}</span>
      {Array.from({ length: 3 }, (_, index) => <div key={index} aria-hidden className="flex gap-3 border-b border-border/60 p-5 last:border-0">
        <Skeleton className="h-8 w-8 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-3"><Skeleton className={cn("h-3.5", index === 1 ? "w-3/5" : "w-4/5")} /><Skeleton className="h-2.5 w-2/5" /></div>
      </div>)}
    </div>
  );
}
