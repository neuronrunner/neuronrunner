"use client";

import { useTranslation } from "react-i18next";
import { LuCircleAlert, LuLoaderCircle, LuSparkles } from "react-icons/lu";
import { isGitAISessionActiveStatus, type GitAISession } from "@/stores/git-ai-sessions";
import { cn } from "@/lib/utils";

/** Compact status pill displayed on PR and Issue rows to surface background or completed AI work. */
export function GitAISessionBadge({
  session,
  className,
}: {
  session?: GitAISession | null;
  className?: string;
}) {
  const { t } = useTranslation("git");
  if (!session) return null;

  const isActive = isGitAISessionActiveStatus(session.status);

  if (isActive) {
    const labelKey =
      session.mode === "pr-review" || session.mode === "issue-review"
        ? "aiStudio.badges.generatingReview"
        : session.mode === "pr-fix-ci"
          ? "aiStudio.badges.fixingCi"
          : session.mode === "pr-fix"
            ? "aiStudio.badges.fixingWithAi"
            : "aiStudio.badges.solvingWithAi";

    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-0.5 text-[11px] font-medium text-indigo-600 dark:text-indigo-400",
          className
        )}
      >
        <LuLoaderCircle aria-hidden className="h-3 w-3 animate-spin" />
        <span>{t(labelKey)}</span>
      </span>
    );
  }

  if (session.status === "completed") {
    const labelKey =
      session.mode === "pr-review" || session.mode === "issue-review"
        ? "aiStudio.badges.reviewReady"
        : session.mode === "pr-fix" || session.mode === "pr-fix-ci"
          ? "aiStudio.badges.fixReady"
          : "aiStudio.badges.solutionReady";

    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400",
          className
        )}
      >
        <LuSparkles aria-hidden className="h-3 w-3" />
        <span>{t(labelKey)}</span>
      </span>
    );
  }

  if (session.status === "error") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-600 dark:text-rose-400",
          className
        )}
      >
        <LuCircleAlert aria-hidden className="h-3 w-3" />
        <span>{t("aiStudio.badges.failed")}</span>
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground",
        className
      )}
    >
      <LuSparkles aria-hidden className="h-3 w-3" />
      <span>{t("aiStudio.badges.stopped")}</span>
    </span>
  );
}
