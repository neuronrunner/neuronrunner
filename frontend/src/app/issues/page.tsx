"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  LuArrowLeft,
  LuArrowRight,
  LuCircleAlert,
  LuCircleCheck,
  LuCircleDot,
  LuCircleSlash,
  LuExternalLink,
  LuFolderOpen,
  LuGitBranch,
  LuLoaderCircle,
  LuMessageSquare,
  LuMilestone,
  LuPanelLeftOpen,
  LuPlus,
  LuRefreshCw,
  LuSearch,
  LuServer,
  LuSparkles,
  LuTerminal,
  LuUser,
  LuX,
} from "react-icons/lu";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { WorkspacePageHeader, WorkspacePageTitle } from "@/components/workspace-page-header";
import WorkspaceHeaderToolbar from "@/components/workspace-header-toolbar";
import { RepositoryPicker } from "@/components/git/repository-picker";
import { RepositoryEmptyState, RepositoryLoading, RepositoryTimestamp } from "@/components/git/repository-ui";
import { AIResolutionStudio, type AIStudioMode } from "@/components/git/ai-resolution-studio";
import { GitAISessionBadge } from "@/components/git/ai-session-badge";
import { useWorkspaceRepositories } from "@/hooks/use-workspace-repositories";
import useGitAISessionsStore, {
  buildGitAISessionKey,
  isGitAISessionActiveStatus,
  launchGitAISession,
  useSyncGitAISessions,
} from "@/stores/git-ai-sessions";
import {
  isNoActiveVM,
  repositoryError,
  repositoryUnavailable,
  repositoryRequest,
  type Issue,
  type IssueComment,
  type IssueCommentsResponse,
  type IssueDetailResponse,
  type IssuesResponse,
} from "@/lib/repository-api";
import { useRouter } from "@/lib/navigation";
import { useCloseRightPanelOnMount } from "@/hooks/use-close-right-panel";
import useSidebarStore from "@/stores/sidebar";
import useWorkspaceTabsStore from "@/stores/workspace-tabs";
import { cn } from "@/lib/utils";

export default function IssuesPage() {
  const { t } = useTranslation("git");
  const router = useRouter();
  useCloseRightPanelOnMount();
  const browser = useWorkspaceRepositories();
  const removeRepository = browser.removeRepository;
  const isSidebarOpen = useSidebarStore((state) => state.isOpen);
  const isSplit = useWorkspaceTabsStore((state) => state.isSplit);
  const vms: Array<{ uuid: string; name: string; status: string }> = [];
  const selectVM = async (_uuid: string) => {};
  const setCreateModalOpen = (_open: boolean) => {};
  const selectedVM = null as { uuid: string; name: string; status: string } | null;
  const isVMRunning = true;
  const isVMStarting = false;

  const [searchParams, setSearchParams] = useSearchParams();
  const urlState = searchParams.get("state");
  const urlFilter: "open" | "closed" = urlState === "closed" ? "closed" : "open";
  const urlIssueParam = searchParams.get("issue");
  const parsedUrlIssue = urlIssueParam ? Number.parseInt(urlIssueParam, 10) : NaN;
  const targetIssueNumber = Number.isFinite(parsedUrlIssue) && parsedUrlIssue > 0 ? parsedUrlIssue : null;

  const [filter, setFilter] = useState<"open" | "closed">(urlFilter);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Issue | null>(null);
  const [dataLoaded, setDataLoaded] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const prevRepoRef = useRef<string | null>(null);

  const path = browser.repository?.path;
  const repoKey = browser.repository?.github_repository || path || "";
  const aiSessions = useGitAISessionsStore((state) => state.sessions);

  useSyncGitAISessions(repoKey || undefined);

  const selectIssue = useCallback(
    (issue: Issue | null, nextState?: "open" | "closed") => {
      setSelected(issue);
      const next = new URLSearchParams(searchParams);
      if (nextState) {
        next.set("state", nextState);
      } else if (!next.get("state")) {
        next.set("state", filter);
      }
      if (issue) {
        next.set("issue", String(issue.number));
      } else {
        next.delete("issue");
      }
      setSearchParams(next, { replace: false });
    },
    [filter, searchParams, setSearchParams]
  );

  // Sync filter & selected when user navigates with browser back/forward buttons
  useEffect(() => {
    if (urlState === "open" || urlState === "closed") {
      setFilter(urlState);
    }
    if (targetIssueNumber === null) {
      setSelected((prev) => (prev ? null : prev));
    }
  }, [urlState, targetIssueNumber]);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setLoadMoreError(null);
    setLoading(false);

    const currentRepoId = `${browser.uuid || ""}:${path || ""}:${browser.repository?.github_repository || ""}`;
    if (prevRepoRef.current !== null && prevRepoRef.current !== currentRepoId) {
      setSelected(null);
      if (searchParams.get("issue")) {
        const next = new URLSearchParams(searchParams);
        next.delete("issue");
        setSearchParams(next, { replace: true });
      }
    }
    prevRepoRef.current = currentRepoId;

    if (!isVMRunning || !browser.uuid || !path || !browser.repository?.github_repository) {
      setIssues([]);
      setHasNext(false);
      setDataLoaded(false);
      return;
    }
    setLoading(true);
    setPage(1);
    repositoryRequest<IssuesResponse>(
      browser.uuid,
      "github/issues",
      { path, state: filter, page: 1, per_page: 50 },
      controller.signal
    )
      .then((response) => {
        if (!controller.signal.aborted) {
          const list = response.issues || [];
          setIssues(list);
          setHasNext(Boolean(response.has_next));
          setDataLoaded(true);
          setSelected((prev) => {
            if (!prev) return prev;
            const updated = list.find((item) => item.number === prev.number);
            return updated || prev;
          });
        }
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (repositoryUnavailable(cause)) removeRepository(path);
        else if (!isNoActiveVM(cause)) setError(repositoryError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    isVMRunning,
    browser.uuid,
    path,
    browser.repository?.github_repository,
    filter,
    revision,
    removeRepository,
  ]);

  // Restore selected issue from URL param (?issue=123) on page load/reload
  useEffect(() => {
    if (!targetIssueNumber) return;
    if (selected?.number === targetIssueNumber) return;

    const fromList = issues.find((item) => item.number === targetIssueNumber);
    if (fromList) {
      setSelected(fromList);
      return;
    }

    if (!isVMRunning || !browser.uuid || !path || !browser.repository?.github_repository) return;
    const controller = new AbortController();
    repositoryRequest<IssueDetailResponse>(
      browser.uuid,
      `github/issues/${targetIssueNumber}`,
      { path },
      controller.signal
    )
      .then((res) => {
        if (!controller.signal.aborted && res.issue) {
          setSelected(res.issue);
        }
      })
      .catch(() => {
        // Leave unselected if issue cannot be resolved
      });
    return () => controller.abort();
  }, [
    targetIssueNumber,
    selected?.number,
    issues,
    isVMRunning,
    browser.uuid,
    path,
    browser.repository?.github_repository,
  ]);

  useEffect(() => {
    if (
      !hasNext ||
      loading ||
      loadingMore ||
      loadMoreError ||
      !isVMRunning ||
      !browser.uuid ||
      !path ||
      !browser.repository?.github_repository ||
      selected ||
      !loadMoreRef.current
    )
      return;

    const controller = new AbortController();
    let isPending = false;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || isPending) return;
        isPending = true;
        setLoadingMore(true);
        const nextPage = page + 1;
        repositoryRequest<IssuesResponse>(
          browser.uuid!,
          "github/issues",
          { path, state: filter, page: nextPage, per_page: 50 },
          controller.signal
        )
          .then((response) => {
            if (controller.signal.aborted) return;
            setIssues((prev) => {
              const existing = new Set(prev.map((i) => i.number));
              const additions = (response.issues || []).filter((i) => !existing.has(i.number));
              return [...prev, ...additions];
            });
            setPage(nextPage);
            setHasNext(Boolean(response.has_next));
          })
          .catch((cause) => {
            if (controller.signal.aborted) return;
            if (repositoryUnavailable(cause)) removeRepository(path);
            else if (!isNoActiveVM(cause)) setLoadMoreError(repositoryError(cause));
          })
          .finally(() => {
            if (!controller.signal.aborted) {
              setLoadingMore(false);
              isPending = false;
            }
          });
      },
      { root: scrollContainerRef.current, rootMargin: "200px" }
    );

    observer.observe(loadMoreRef.current);
    return () => {
      observer.disconnect();
      controller.abort();
      setLoadingMore(false);
    };
  }, [
    hasNext,
    loading,
    loadingMore,
    loadMoreError,
    isVMRunning,
    browser.uuid,
    path,
    browser.repository?.github_repository,
    filter,
    page,
    selected,
    removeRepository,
  ]);

  const filteredIssues = issues.filter((issue) => {
    const labelNames = (issue.labels || []).map((l) => l.name).join(" ");
    const searchTarget = `${issue.title} #${issue.number} ${issue.author} ${labelNames}`.toLocaleLowerCase();
    return searchTarget.includes(query.trim().toLocaleLowerCase());
  });

  const refreshing = browser.isLoading || loading;
  const refresh = () => {
    browser.refresh();
    setRevision((value) => value + 1);
  };

  const changeRepository = (nextPath: string) => {
    browser.selectRepository(nextPath);
    setQuery("");
    selectIssue(null);
  };

  const openTool = (tool: "files" | "git") => {
    const store = useWorkspaceTabsStore.getState();
    if (tool === "files") store.openFilesTab();
    else store.openGitTab();
  };

  return (
    <main className="workspace-page flex h-full min-h-0 min-w-0 flex-col bg-background">
      <WorkspacePageHeader actions={<WorkspaceHeaderToolbar />}>
        <div className="flex min-w-0 flex-1 items-center">
          {!isSidebarOpen && (
            <button
              type="button"
              aria-label={t("common.openSidebar")}
              onClick={() => useSidebarStore.getState().toggle()}
              className="mr-2 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <LuPanelLeftOpen className="h-5 w-5" />
            </button>
          )}
          <WorkspacePageTitle icon={LuCircleDot}>
            <span className="title-fade-in block truncate px-1">{t("issues.title")}</span>
          </WorkspacePageTitle>
        </div>
      </WorkspacePageHeader>

      <div ref={scrollContainerRef} className="workspace-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 sm:px-8 sm:py-9">
          <div className="workspace-page-enter flex items-start justify-between gap-4">
            <div>
              <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                {t("issues.eyebrow")}
              </p>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t("issues.title")}</h1>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                {t("issues.subtitle")}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={refreshing || !isVMRunning}
              onClick={refresh}
              aria-label={t("issues.refreshAriaLabel")}
              className="mt-1 shrink-0 rounded-lg"
            >
              <LuRefreshCw className={cn(refreshing && "animate-spin")} />
              <span className="hidden sm:inline">{t("common.refresh")}</span>
            </Button>
          </div>

          {!isVMRunning ? (
            <div
              className="workspace-page-enter flex flex-col items-center rounded-xl border border-dashed border-border bg-card/50 px-5 py-12 text-center"
              style={{ animationDelay: "90ms" }}
              role="status"
            >
              <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-border bg-background text-muted-foreground">
                {isVMStarting ? <LuLoaderCircle className="h-5 w-5 motion-safe:animate-spin" /> : <LuServer className="h-5 w-5" />}
              </span>
              <h3 className="text-sm font-semibold">
                {isVMStarting ? t("common.startingVm", { name: selectedVM?.name || "" }) : t("issues.vmSelectTitle")}
              </h3>
              <p className="mt-2 max-w-sm text-xs leading-relaxed text-muted-foreground">
                {isVMStarting
                  ? t("issues.vmStartingDesc")
                  : vms.length > 0
                    ? t("issues.vmAvailableDesc")
                    : t("issues.vmNoneDesc")}
              </p>
              {!isVMStarting && (
                <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                  {vms.map((vm) => (
                    <Button
                      key={vm.uuid}
                      variant="outline"
                      size="sm"
                      onClick={() => void selectVM(vm.uuid)}
                      className="gap-1.5 text-xs"
                    >
                      <LuServer className="h-3.5 w-3.5" />
                      <span>{t("common.connectVm", { name: vm.name })}</span>
                    </Button>
                  ))}
                  <Button
                    size="sm"
                    onClick={() => setCreateModalOpen(true)}
                    className="gap-1.5 text-xs"
                  >
                    <LuPlus className="h-3.5 w-3.5" />
                    <span>{t("common.createMachine")}</span>
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <>
              {browser.repositories.length > 0 && (
                <div
                  className="workspace-page-enter flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3 sm:p-4"
                  style={{ animationDelay: "90ms" }}
                >
                  <div className="min-w-0 flex-1 sm:max-w-sm">
                    <RepositoryPicker repositories={browser.repositories} value={path} onChange={changeRepository} />
                  </div>
                  {browser.repository?.github_repository && (
                    <a
                      href={`https://github.com/${browser.repository.github_repository}/issues`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      aria-label={t("issues.viewOnGithubAriaLabel")}
                    >
                      <span className="hidden sm:inline">{t("common.viewOnGithub")}</span>
                      <LuExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
              )}

              {(browser.error || error) && !isNoActiveVM(browser.error) && !isNoActiveVM(error) && (
                <div role="alert" className="flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/5 p-4">
                  <LuCircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{t("issues.loadErrorTitle")}</p>
                    <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">
                      {browser.error || error}
                    </p>
                    <Button variant="outline" size="sm" disabled={refreshing} className="mt-3" onClick={refresh}>
                      {t("common.tryAgain")}
                    </Button>
                  </div>
                </div>
              )}

              {browser.isLoading && browser.repositories.length === 0 ? (
                <RepositoryLoading label={t("common.loadingRepositories")} />
              ) : !browser.repositories.length && !browser.error ? (
                <RepositoryEmptyState
                  title={t("issues.emptyNoReposTitle")}
                  description={t("issues.emptyNoReposDesc")}
                >
                  <Button variant="outline" size="sm" onClick={() => openTool("files")}>
                    <LuFolderOpen />
                    {t("common.openFiles")}
                  </Button>
                </RepositoryEmptyState>
              ) : browser.repository && !browser.repository.github_repository ? (
                <RepositoryEmptyState
                  title={t("common.connectGithubTitle")}
                  description={t("issues.emptyNoGithubDesc")}
                >
                  <Button variant="outline" size="sm" onClick={() => openTool("git")}>
                    <LuGitBranch />
                    {t("common.openGit")}
                  </Button>
                </RepositoryEmptyState>
              ) : browser.repository && (
                <>
                  {!selected && (
                    <div className="workspace-page-enter space-y-3" style={{ animationDelay: "130ms" }}>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div
                          className="inline-flex gap-1 rounded-lg border border-border bg-muted/40 p-1"
                          role="group"
                          aria-label={t("issues.statusFilterAriaLabel")}
                        >
                          {(["open", "closed"] as const).map((state) => (
                            <button
                              key={state}
                              type="button"
                              aria-pressed={filter === state}
                              onClick={() => {
                                setFilter(state);
                                setQuery("");
                                selectIssue(null, state);
                              }}
                              className={cn(
                                "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors",
                                filter === state
                                  ? "bg-card text-foreground shadow-sm"
                                  : "text-muted-foreground hover:text-foreground"
                              )}
                            >
                              {state === "open" ? (
                                <LuCircleDot
                                  aria-hidden
                                  className={cn(
                                    "h-3.5 w-3.5",
                                    filter === state && "text-emerald-600 dark:text-emerald-400"
                                  )}
                                />
                              ) : (
                                <LuCircleCheck
                                  aria-hidden
                                  className={cn(
                                    "h-3.5 w-3.5",
                                    filter === state && "text-violet-600 dark:text-violet-400"
                                  )}
                                />
                              )}
                              {state === "open" ? t("status.open") : t("status.closed")}
                            </button>
                          ))}
                        </div>
                        <div className="relative w-full sm:w-64">
                          <LuSearch
                            aria-hidden
                            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                          />
                          <input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            aria-label={t("issues.searchPlaceholder")}
                            placeholder={t("issues.searchPlaceholder")}
                            className="h-9 w-full rounded-lg border border-border bg-card pl-9 pr-9 text-xs outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                          />
                          {query && (
                            <button
                              type="button"
                              aria-label={t("common.clearSearch")}
                              onClick={() => setQuery("")}
                              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground hover:bg-muted"
                            >
                              <LuX className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                      {dataLoaded && !loading && !error && (
                        <p aria-live="polite" className="text-[11px] text-muted-foreground">
                          {query.trim()
                            ? t("common.matchingCount", { count: filteredIssues.length })
                            : `${filter === "open" ? (issues.length === 1 ? t("issues.countOpenOne", { count: issues.length }) : t("issues.countOpenOther", { count: issues.length })) : (issues.length === 1 ? t("issues.countClosedOne", { count: issues.length }) : t("issues.countClosedOther", { count: issues.length }))}${hasNext ? t("common.scrollForMoreSuffix") : ""}`}
                        </p>
                      )}
                    </div>
                  )}

                  {loading && !selected ? (
                    <RepositoryLoading label={t("issues.loading")} />
                  ) : !error && (dataLoaded || Boolean(selected)) && (
                    <div className="workspace-page-enter" style={{ animationDelay: "170ms" }}>
                      {selected ? (
                        <IssueDetail
                          issue={selected}
                          vmUuid={browser.uuid}
                          repoPath={path}
                          repoKey={repoKey}
                          repoName={browser.repository?.github_repository || browser.repository?.name || t("common.repositoryFallback")}
                          onBack={() => selectIssue(null)}
                        />
                      ) : !filteredIssues.length ? (
                        <RepositoryEmptyState
                          title={query.trim() ? t("issues.noMatchingTitle") : filter === "open" ? t("issues.noOpenTitle") : t("issues.noClosedTitle")}
                          description={
                            query.trim()
                              ? t("issues.noMatchingDesc")
                              : filter === "open"
                                ? t("issues.noOpenDesc")
                                : t("issues.noClosedDesc")
                          }
                        >
                          {query.trim() && (
                            <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                              {t("common.clearSearch")}
                            </Button>
                          )}
                        </RepositoryEmptyState>
                      ) : (
                        <ul className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border bg-card shadow-xs">
                          {filteredIssues.map((issue) => {
                            const aiSession = repoKey
                              ? aiSessions[buildGitAISessionKey("issue", repoKey, issue.number)]
                              : undefined;
                            return (
                            <li key={issue.number}>
                              <button
                                type="button"
                                onClick={() => selectIssue(issue)}
                                className="group relative flex w-full min-w-0 items-start gap-3 px-4 py-4 text-left transition-colors before:absolute before:inset-y-3 before:left-0 before:w-0.5 before:rounded-full before:bg-indigo-500 before:opacity-0 before:transition-opacity hover:bg-muted/40 hover:before:opacity-100 focus-visible:bg-muted/40 focus-visible:before:opacity-100 focus-visible:outline-offset-[-2px] sm:gap-4 sm:px-5"
                              >
                                <span
                                  className={cn(
                                    "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
                                    issue.state === "open"
                                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                      : issue.state_reason === "not_planned"
                                        ? "bg-muted text-muted-foreground"
                                        : "bg-violet-500/10 text-violet-600 dark:text-violet-400"
                                  )}
                                >
                                  {issue.state === "open" ? (
                                    <LuCircleDot aria-hidden className="h-4 w-4" />
                                  ) : issue.state_reason === "not_planned" ? (
                                    <LuCircleSlash aria-hidden className="h-4 w-4" />
                                  ) : (
                                    <LuCircleCheck aria-hidden className="h-4 w-4" />
                                  )}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="line-clamp-2 break-words text-sm font-semibold leading-6 transition-colors group-hover:text-primary">
                                    {issue.title}
                                  </span>
                                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                                    <span className="font-mono font-medium">#{issue.number}</span>
                                    <span className="inline-flex items-center gap-1.5 break-all">
                                      {issue.author_avatar ? (
                                        <img
                                          src={issue.author_avatar}
                                          alt={issue.author}
                                          className="h-3.5 w-3.5 rounded-full object-cover"
                                          loading="lazy"
                                        />
                                      ) : null}
                                      {t("common.byAuthor", { author: issue.author || t("common.unknownAuthor") })}
                                    </span>
                                    <span className="text-muted-foreground/50" aria-hidden>
                                      ·
                                    </span>
                                    <RepositoryTimestamp value={issue.updated_at} prefix={t("timestamps.updatedPrefix")} />
                                    {issue.closed_at && issue.state === "closed" && (
                                      <>
                                        <span className="text-muted-foreground/50" aria-hidden>
                                          ·
                                        </span>
                                        <RepositoryTimestamp value={issue.closed_at} prefix={t("timestamps.closedPrefix")} />
                                      </>
                                    )}
                                    {issue.milestone && (
                                      <>
                                        <span className="text-muted-foreground/50" aria-hidden>
                                          ·
                                        </span>
                                        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                                          <LuMilestone className="h-3 w-3" />
                                          {issue.milestone.title}
                                        </span>
                                      </>
                                    )}
                                  </span>

                                  {issue.labels && issue.labels.length > 0 && (
                                    <span className="mt-2.5 flex flex-wrap gap-1.5">
                                      {issue.labels.map((label) => (
                                        <span
                                          key={label.name}
                                          className="inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium border"
                                          style={{
                                            backgroundColor: `#${label.color}15`,
                                            borderColor: `#${label.color}35`,
                                            color: `#${label.color}`,
                                          }}
                                        >
                                          {label.name}
                                        </span>
                                      ))}
                                    </span>
                                  )}

                                  {aiSession && (
                                    <span className="mt-2 block sm:hidden">
                                      <GitAISessionBadge session={aiSession} />
                                    </span>
                                  )}
                                </span>

                                <div className="flex items-center gap-3 shrink-0 pt-1">
                                  {issue.assignees && issue.assignees.length > 0 && (
                                    <div className="hidden sm:flex -space-x-1.5 overflow-hidden">
                                      {issue.assignees.slice(0, 3).map((assignee) => (
                                        <img
                                          key={assignee.login}
                                          src={assignee.avatar_url}
                                          alt={assignee.login}
                                          title={t("common.assignedTo", { login: assignee.login })}
                                          className="inline-block h-5 w-5 rounded-full ring-2 ring-background object-cover"
                                          loading="lazy"
                                        />
                                      ))}
                                    </div>
                                  )}

                                  {issue.comments > 0 && (
                                    <span
                                      className="hidden sm:inline-flex items-center gap-1 text-[11px] text-muted-foreground shrink-0"
                                      title={t("common.commentsCount", { count: issue.comments })}
                                    >
                                      <LuMessageSquare className="h-3.5 w-3.5" />
                                      <span>{issue.comments}</span>
                                    </span>
                                  )}

                                  <GitAISessionBadge session={aiSession} className="hidden sm:inline-flex" />

                                  <LuArrowRight
                                    aria-hidden
                                    className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
                                  />
                                </div>
                              </button>
                            </li>
                            );
                          })}
                        </ul>
                      )}

                      {!selected && hasNext && (
                        <div
                          ref={loadMoreRef}
                          className="flex min-h-12 items-center justify-center gap-2 border-t border-border/40 py-4 text-xs text-muted-foreground"
                        >
                          {loadMoreError ? (
                            <div role="alert" className="text-center">
                              <p className="text-xs text-destructive">{loadMoreError}</p>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setLoadMoreError(null)}
                                className="mt-2 text-xs"
                              >
                                {t("common.retryLoadingMore")}
                              </Button>
                            </div>
                          ) : (
                            <span role="status" className="inline-flex items-center gap-2">
                              {loadingMore && <LuLoaderCircle aria-hidden className="h-4 w-4 animate-spin text-muted-foreground" />}
                              {loadingMore ? t("issues.loadingMore") : t("issues.scrollForMore")}
                            </span>
                          )}
                        </div>
                      )}
                      {!selected && !hasNext && issues.length > 5 && (
                        <p className="py-4 text-center text-xs text-muted-foreground/60">
                          {filter === "open" ? t("issues.allOpenLoaded") : t("issues.allClosedLoaded")}
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}

function IssueDetail({
  issue,
  vmUuid,
  repoPath,
  repoKey,
  repoName,
  onBack,
}: {
  issue: Issue;
  vmUuid?: string;
  repoPath?: string;
  repoKey: string;
  repoName: string;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation("git");
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [loadingComments, setLoadingComments] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);

  const sessionKey = buildGitAISessionKey("issue", repoKey || repoPath || "", issue.number);
  const aiSession = useGitAISessionsStore((state) => state.sessions[sessionKey]);
  const studioOpen = Boolean(aiSession?.studioOpen);
  const activeMode = aiSession?.mode || null;
  const isGeneratingAi = isGitAISessionActiveStatus(aiSession?.status);

  const fetchComments = () => {
    if (!vmUuid || !repoPath || !issue.number) return;
    const controller = new AbortController();
    setLoadingComments(true);
    setCommentsError(null);
    repositoryRequest<IssueCommentsResponse>(
      vmUuid,
      `github/issues/${issue.number}/comments`,
      { path: repoPath },
      controller.signal
    )
      .then((res) => {
        if (!controller.signal.aborted) {
          setComments(res.comments || []);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setCommentsError(repositoryError(err));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoadingComments(false);
        }
      });
  };

  useEffect(() => {
    fetchComments();
  }, [vmUuid, repoPath, issue.number]);

  const buildIssuePrompt = (mode: AIStudioMode) => {
    let commentsText = "";
    if (comments && comments.length > 0) {
      commentsText =
        "\n\n**Issue Comments & Activity:**\n" +
        comments
          .map(
            (c) =>
              `> **@${c.author}** commented:\n> ${c.body.replace(/\n/g, "\n> ")}`
          )
          .join("\n\n");
    }
    if (mode === "issue-review") {
      return (
        `Please analyze and review GitHub Issue #${issue.number} in the repository at \`${repoPath || "/workspace"}\` (${repoName}):\n\n` +
        `**Title:** ${issue.title}\n\n` +
        (issue.body ? `**Description:**\n${issue.body}\n\n` : "") +
        commentsText +
        `\n\nProvide a concise, actionable technical review covering:\n1. Root cause / likely affected modules in the codebase\n2. Potential edge cases, risks, or dependencies\n3. Proposed implementation plan & test strategy (without modifying files unless asked).`
      );
    }
    return (
      `Please resolve GitHub Issue #${issue.number} in the repository at \`${repoPath || "/workspace"}\` (${repoName}):\n\n` +
      `**Title:** ${issue.title}\n\n` +
      (issue.body ? `**Description:**\n${issue.body}\n\n` : "") +
      commentsText +
      `\n\nPlease inspect the relevant files in \`${repoPath || "/workspace"}\`, implement a clean fix directly in the workspace files, run any relevant tests or checks to verify your solution, and summarize the changes made.`
    );
  };

  const startIssueAISession = (mode: AIStudioMode, forceRerun = false) => {
    if (!vmUuid || !repoPath) return;
    if (!forceRerun && aiSession && aiSession.mode === mode) {
      if (isGitAISessionActiveStatus(aiSession.status) || !aiSession.studioOpen) {
        useGitAISessionsStore.getState().setStudioOpen(sessionKey, true);
        return;
      }
    }
    const isSolve = mode === "issue-solve";
    void launchGitAISession({
      kind: "issue",
      repoKey: repoKey || repoPath,
      number: issue.number,
      title: issue.title,
      mode,
      vmUuid,
      repoPath,
      initialPrompt: buildIssuePrompt(mode),
      targetBranch: isSolve ? `fix/issue-${issue.number}` : undefined,
      createBranchIfMissing: isSolve,
      defaultCommitMessage: `fix: resolve issue #${issue.number} - ${issue.title}`,
      defaultPrTitle: `fix: ${issue.title} (#${issue.number})`,
      defaultPrBodyPrefix: `Closes #${issue.number}`,
    });
  };

  return (
    <div className="workspace-page-enter space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 text-muted-foreground hover:text-foreground">
          <LuArrowLeft className="mr-1.5 h-4 w-4" />
          {t("issues.backToList")}
        </Button>

        <div className="flex flex-wrap items-center gap-2">
          <a
            href={issue.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            <span>{t("common.openOnGithub")}</span>
            <LuExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
          </a>

          <Button
            variant="outline"
            size="sm"
            onClick={() => startIssueAISession("issue-review")}
            disabled={isGeneratingAi && activeMode === "issue-review" && studioOpen}
            className="gap-1.5 border-indigo-500/30 bg-indigo-500/5 text-xs font-medium text-indigo-600 hover:bg-indigo-500/15 dark:text-indigo-400"
          >
            {isGeneratingAi && activeMode === "issue-review" ? (
              <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <LuSparkles className="h-3.5 w-3.5" />
            )}
            <span>
              {isGeneratingAi && activeMode === "issue-review"
                ? t("issues.generatingReview")
                : t("issues.aiReview")}
            </span>
          </Button>

          <Button
            size="sm"
            onClick={() => startIssueAISession("issue-solve")}
            disabled={isGeneratingAi && activeMode === "issue-solve" && studioOpen}
            className="gap-1.5 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white shadow-xs"
          >
            {isGeneratingAi && activeMode === "issue-solve" ? (
              <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <LuSparkles className="h-3.5 w-3.5" />
            )}
            <span>
              {isGeneratingAi && activeMode === "issue-solve"
                ? t("issues.solvingWithAi")
                : t("issues.solveWithAi")}
            </span>
          </Button>
        </div>
      </div>

      {studioOpen && aiSession && vmUuid && repoPath && (
        <AIResolutionStudio
          key={sessionKey}
          sessionKey={sessionKey}
          mode={aiSession.mode}
          vmUuid={vmUuid}
          repoPath={repoPath}
          repoName={repoName}
          initialPrompt={aiSession.initialPrompt}
          targetBranch={aiSession.mode === "issue-solve" ? `fix/issue-${issue.number}` : undefined}
          createBranchIfMissing={aiSession.mode === "issue-solve"}
          defaultCommitMessage={`fix: resolve issue #${issue.number} - ${issue.title}`}
          defaultPrTitle={`fix: ${issue.title} (#${issue.number})`}
          defaultPrBodyPrefix={`Closes #${issue.number}`}
          issueNumber={issue.number}
          onClose={() => useGitAISessionsStore.getState().setStudioOpen(sessionKey, false)}
          onRerun={() => startIssueAISession(aiSession.mode, true)}
        />
      )}

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="space-y-4 border-b border-border bg-muted/20 p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-2">
            {issue.state === "open" ? (
              <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 capitalize">
                <LuCircleDot className="h-3.5 w-3.5" />
                {t("status.open")}
              </span>
            ) : issue.state_reason === "not_planned" ? (
              <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium bg-muted text-muted-foreground capitalize">
                <LuCircleSlash className="h-3.5 w-3.5" />
                {t("issues.closedNotPlanned")}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium bg-violet-500/10 text-violet-600 dark:text-violet-400 capitalize">
                <LuCircleCheck className="h-3.5 w-3.5" />
                {issue.state_reason ? t("issues.closedWithReason", { reason: issue.state_reason }) : t("status.closed")}
              </span>
            )}
            <span className="text-xs text-muted-foreground/60">·</span>
            <span className="text-xs font-mono text-muted-foreground">{t("issues.issueNumber", { number: issue.number })}</span>
          </div>

          <h2 className="break-words text-xl font-semibold leading-snug tracking-tight sm:text-2xl">
            {issue.title}
          </h2>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 break-all font-medium text-foreground">
              {issue.author_avatar ? (
                <img
                  src={issue.author_avatar}
                  alt={issue.author}
                  className="h-4 w-4 rounded-full object-cover"
                />
              ) : (
                <LuUser className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              {issue.author || t("common.unknownAuthor")}
            </span>
            <span className="text-muted-foreground/40" aria-hidden>
              {t("common.openedThis")}
            </span>
            <RepositoryTimestamp value={issue.created_at} prefix={t("timestamps.createdPrefix")} />
            <span className="text-muted-foreground/40" aria-hidden>
              ·
            </span>
            <RepositoryTimestamp value={issue.updated_at} prefix={t("timestamps.updatedPrefix")} />
            {issue.closed_at && issue.state === "closed" && (
              <>
                <span className="text-muted-foreground/40" aria-hidden>
                  ·
                </span>
                <RepositoryTimestamp value={issue.closed_at} prefix={t("timestamps.closedPrefix")} />
              </>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 p-5 sm:p-6 lg:grid-cols-4">
          <div className="space-y-6 lg:col-span-3">
            <div>
              <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("common.description")}
              </h3>
              <div className="min-w-0 break-words rounded-xl border border-border/70 bg-card p-4 sm:p-5 text-sm leading-7 [&_a]:text-primary [&_a]:underline [&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/30 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mb-3 [&_h2]:mt-5 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:font-semibold [&_li]:my-1 [&_ol]:mb-4 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-4 [&_pre]:my-4 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border [&_pre]:bg-muted/50 [&_pre]:p-4 [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-5 [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_th]:border [&_th]:border-border [&_th]:bg-muted/50 [&_th]:px-3 [&_th]:py-2 [&_hr]:my-5 [&_hr]:border-border">
                <ReactMarkdown
                  skipHtml
                  remarkPlugins={[remarkGfm]}
                  components={{
                    img: () => null,
                    a: ({ children, href }) => (
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        {children}
                      </a>
                    ),
                    table: ({ children }) => (
                      <div className="my-4 max-w-full overflow-x-auto">
                        <table className="w-full border-collapse text-left text-xs">{children}</table>
                      </div>
                    ),
                  }}
                >
                  {issue.body || t("common.noDescription")}
                </ReactMarkdown>
              </div>
            </div>

            <div className="space-y-4 pt-2">
              <div className="flex items-center justify-between">
                <h3 className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <LuMessageSquare className="h-3.5 w-3.5" />
                  <span>{t("issues.commentsTitle")}</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-mono text-foreground">
                    {loadingComments ? "…" : comments.length}
                  </span>
                </h3>

                <Button
                  variant="ghost"
                  size="sm"
                  disabled={loadingComments}
                  onClick={fetchComments}
                  className="h-7 text-xs text-muted-foreground hover:text-foreground"
                >
                  <LuRefreshCw className={cn("mr-1 h-3 w-3", loadingComments && "animate-spin")} />
                  {t("common.refresh")}
                </Button>
              </div>

              {loadingComments ? (
                <div className="rounded-xl border border-border bg-card/50 p-6 text-center">
                  <RepositoryLoading label={t("common.loadingComments")} />
                </div>
              ) : commentsError ? (
                <div
                  role="alert"
                  className="flex items-center justify-between rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-xs text-destructive"
                >
                  <span>{commentsError}</span>
                  <Button variant="outline" size="sm" onClick={fetchComments} className="text-xs">
                    {t("common.retry")}
                  </Button>
                </div>
              ) : comments.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/80 bg-muted/10 px-4 py-8 text-center text-xs text-muted-foreground">
                  <LuMessageSquare className="mb-2 h-5 w-5 text-muted-foreground/40" />
                  <p>{t("issues.noComments")}</p>
                </div>
              ) : (
                <div className="space-y-3.5">
                  {comments.map((comment) => (
                    <div
                      key={comment.id}
                      className="overflow-hidden rounded-xl border border-border bg-card transition-shadow hover:shadow-xs"
                    >
                      <div className="flex items-center justify-between border-b border-border bg-muted/20 px-4 py-2.5 text-xs">
                        <div className="flex items-center gap-2 min-w-0">
                          {comment.author_avatar ? (
                            <img
                              src={comment.author_avatar}
                              alt={comment.author}
                              className="h-4 w-4 rounded-full object-cover shrink-0"
                            />
                          ) : (
                            <LuUser className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          )}
                          <span className="font-semibold text-foreground truncate">
                            @{comment.author}
                          </span>
                          <span className="text-muted-foreground/50" aria-hidden>
                            ·
                          </span>
                          <RepositoryTimestamp value={comment.created_at} prefix="" />
                        </div>
                        {comment.url && (
                          <a
                            href={comment.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground shrink-0 ml-2"
                            title={t("common.openCommentOnGithub")}
                          >
                            <span className="hidden sm:inline">GitHub</span>
                            <LuExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                      <div className="p-4 text-sm leading-relaxed min-w-0 break-words [&_a]:text-primary [&_a]:underline [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/30 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_pre]:my-3 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border [&_pre]:bg-muted/50 [&_pre]:p-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5">
                        <ReactMarkdown
                          skipHtml
                          remarkPlugins={[remarkGfm]}
                          components={{
                            img: () => null,
                            a: ({ children, href }) => (
                              <a href={href} target="_blank" rel="noopener noreferrer">
                                {children}
                              </a>
                            ),
                          }}
                        >
                          {comment.body || t("common.emptyComment")}
                        </ReactMarkdown>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-5 lg:border-l lg:border-border lg:pl-6">
            <div>
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("common.assignees")}
              </h4>
              {issue.assignees && issue.assignees.length > 0 ? (
                <ul className="space-y-1.5">
                  {issue.assignees.map((assignee) => (
                    <li key={assignee.login} className="flex items-center gap-2 text-xs">
                      {assignee.avatar_url ? (
                        <img
                          src={assignee.avatar_url}
                          alt={assignee.login}
                          className="h-4 w-4 rounded-full object-cover"
                        />
                      ) : (
                        <LuUser className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      <span className="font-medium text-foreground">@{assignee.login}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground/70">{t("common.noOneAssigned")}</p>
              )}
            </div>

            <div>
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("common.labels")}
              </h4>
              {issue.labels && issue.labels.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {issue.labels.map((label) => (
                    <span
                      key={label.name}
                      className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium border"
                      style={{
                        backgroundColor: `#${label.color}15`,
                        borderColor: `#${label.color}35`,
                        color: `#${label.color}`,
                      }}
                      title={label.description || label.name}
                    >
                      {label.name}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground/70">{t("common.noneYet")}</p>
              )}
            </div>

            <div>
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("common.milestone")}
              </h4>
              {issue.milestone ? (
                <div className="rounded-lg border border-border bg-muted/20 p-2.5 text-xs">
                  <div className="flex items-center gap-1.5 font-medium text-foreground">
                    <LuMilestone className="h-3.5 w-3.5 text-primary" />
                    <span>{issue.milestone.title}</span>
                  </div>
                  {issue.milestone.due_on && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {t("common.dueDate", {
                        date: new Date(issue.milestone.due_on).toLocaleDateString(i18n.resolvedLanguage || "en"),
                      })}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground/70">{t("common.noMilestone")}</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
