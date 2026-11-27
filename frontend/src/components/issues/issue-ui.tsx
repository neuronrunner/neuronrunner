"use client";

import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import {
  LuArrowDown,
  LuArrowUp,
  LuChevronsUp,
  LuCircle,
  LuCircleCheck,
  LuCircleDot,
  LuCircleSlash,
  LuExternalLink,
  LuGitBranch,
  LuGitPullRequest,
  LuMinus,
  LuServer,
} from "react-icons/lu";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { IssueLabel, IssuePriority, IssueStatus } from "@/lib/issues-api";
import { cn } from "@/lib/utils";

type IconType = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

export const STATUS_STYLE: Record<IssueStatus, { icon: IconType; chip: string; tile: string }> = {
  todo: {
    icon: LuCircle,
    chip: "bg-muted text-muted-foreground",
    tile: "bg-muted text-muted-foreground",
  },
  in_progress: {
    icon: LuCircleDot,
    chip: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    tile: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  in_review: {
    icon: LuGitPullRequest,
    chip: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
    tile: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
  },
  done: {
    icon: LuCircleCheck,
    chip: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    tile: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  cancelled: {
    icon: LuCircleSlash,
    chip: "bg-muted text-muted-foreground",
    tile: "bg-muted text-muted-foreground",
  },
};

export const PRIORITY_STYLE: Record<IssuePriority, { icon: IconType; className: string }> = {
  none: { icon: LuMinus, className: "text-muted-foreground/60" },
  low: { icon: LuArrowDown, className: "text-sky-600 dark:text-sky-400" },
  medium: { icon: LuMinus, className: "text-amber-600 dark:text-amber-400" },
  high: { icon: LuArrowUp, className: "text-orange-600 dark:text-orange-400" },
  urgent: { icon: LuChevronsUp, className: "text-red-600 dark:text-red-400" },
};

export function IssueStatusChip({ status, className }: { status: IssueStatus; className?: string }) {
  const { t } = useTranslation("git");
  const { icon: Icon, chip } = STATUS_STYLE[status];
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium", chip, className)}
    >
      <Icon aria-hidden className="h-3.5 w-3.5" />
      {t(`issues.statusNames.${status}`)}
    </span>
  );
}

export function IssuePriorityMark({ priority, withLabel = false }: { priority: IssuePriority; withLabel?: boolean }) {
  const { t } = useTranslation("git");
  const { icon: Icon, className } = PRIORITY_STYLE[priority];
  const label = t(`issues.priorityNames.${priority}`);
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] font-medium", className)} title={label}>
      <Icon aria-hidden className="h-3.5 w-3.5" />
      {withLabel && label}
    </span>
  );
}

export function IssueLabelChip({
  label,
  onRemove,
  size = "sm",
}: {
  label: IssueLabel;
  onRemove?: () => void;
  size?: "sm" | "xs";
}) {
  const color = label.color ? `#${label.color}` : null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border font-medium",
        size === "xs" ? "px-2 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs",
        !color && "border-border bg-muted/50 text-muted-foreground"
      )}
      style={color ? { backgroundColor: `${color}15`, borderColor: `${color}35`, color } : undefined}
    >
      {label.name}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${label.name}`}
          onClick={onRemove}
          className="-mr-0.5 rounded px-0.5 leading-none opacity-70 hover:opacity-100"
        >
          ×
        </button>
      )}
    </span>
  );
}

const MARKDOWN_CLASSES =
  "min-w-0 break-words text-sm leading-7 [&_a]:text-primary [&_a]:underline [&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/30 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mb-3 [&_h2]:mt-5 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:font-semibold [&_li]:my-1 [&_ol]:mb-4 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-4 [&_p:last-child]:mb-0 [&_pre]:my-4 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border [&_pre]:bg-muted/50 [&_pre]:p-4 [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-5 [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_th]:border [&_th]:border-border [&_th]:bg-muted/50 [&_th]:px-3 [&_th]:py-2 [&_hr]:my-5 [&_hr]:border-border";

/** Safe markdown for user/agent authored issue text (no raw HTML, no remote images). */
export function IssueMarkdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn(MARKDOWN_CLASSES, className)}>
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={{
          img: () => null,
          a: ({ children: content, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {content}
            </a>
          ),
          table: ({ children: content }) => (
            <div className="my-4 max-w-full overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">{content}</table>
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

/** Browser URL for a clone URL (https or scp-style ssh); null when it isn't a recognisable remote. */
export function repositoryWebUrl(repoUrl?: string | null): string | null {
  const value = (repoUrl || "").trim();
  if (!value) return null;
  const ssh = value.match(/^git@([^:]+):(.+)$/);
  const web = ssh ? `https://${ssh[1]}/${ssh[2]}` : value;
  if (!/^https:\/\//i.test(web)) return null;
  try {
    const url = new URL(web);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\.git\/?$/, "").replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** Which environment (and repository) an issue belongs to; the repo links out when it has a web URL. */
export function EnvironmentChip({
  name,
  repository,
  repoUrl,
  className,
}: {
  name?: string;
  repository?: string | null;
  repoUrl?: string | null;
  className?: string;
}) {
  const href = repositoryWebUrl(repoUrl);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2 text-xs", className)}>
      {name && (
        <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 font-medium text-foreground">
          <LuServer aria-hidden className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{name}</span>
        </span>
      )}
      {repository &&
        (href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-w-0 items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
          >
            <LuGitBranch aria-hidden className="h-3 w-3 shrink-0" />
            <span className="truncate">{repository}</span>
            <LuExternalLink aria-hidden className="h-3 w-3 shrink-0" />
          </a>
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1 font-mono text-[11px] text-muted-foreground">
            <LuGitBranch aria-hidden className="h-3 w-3 shrink-0" />
            <span className="truncate">{repository}</span>
          </span>
        ))}
    </span>
  );
}

/** "bug, ui" -> [{ name: "bug" }, { name: "ui" }] for plain-text label entry. */
export function parseLabelInput(value: string): IssueLabel[] {
  const seen = new Set<string>();
  const labels: IssueLabel[] = [];
  for (const raw of value.split(",")) {
    const name = raw.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    labels.push({ name, color: "" });
  }
  return labels;
}
