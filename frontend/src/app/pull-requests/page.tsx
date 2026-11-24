"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import {
  LuArrowLeft,
  LuArrowRight,
  LuCheck,
  LuChevronDown,
  LuChevronRight,
  LuCircleAlert,
  LuCircleCheck,
  LuCircleDot,
  LuCopy,
  LuExternalLink,
  LuFileCode,
  LuFolderOpen,
  LuGitBranch,
  LuGitCommitHorizontal,
  LuGitMerge,
  LuGitPullRequest,
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
import { toaster } from "@/components/ui/toaster";
import { WorkspacePageHeader, WorkspacePageTitle } from "@/components/workspace-page-header";
import WorkspaceHeaderToolbar from "@/components/workspace-header-toolbar";
import { RepositoryPicker } from "@/components/git/repository-picker";
import { BranchComparison, PullStatus, RepositoryEmptyState, RepositoryLoading, RepositoryTimestamp } from "@/components/git/repository-ui";
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
  repositoryMutation,
  repositoryUnavailable,
  repositoryRequest,
  type RepositoryStatus,
  type PullRequest,
  type PullRequestsResponse,
  type PullRequestDetailResponse,
  type PullRequestDetailData,
  type PullRequestFilesResponse,
  type PullRequestFile,
  type PullRequestCommitsResponse,
  type PullRequestCommit,
  type PullRequestCommentsResponse,
  type PullRequestComment,
  type PullRequestChecksResponse,
  type PullRequestCheck,
} from "@/lib/repository-api";
import { useRouter } from "@/lib/navigation";
import { useCloseRightPanelOnMount } from "@/hooks/use-close-right-panel";
import useSidebarStore from "@/stores/sidebar";
import useWorkspaceTabsStore from "@/stores/workspace-tabs";
import { cn } from "@/lib/utils";

export default function PullRequestsPage() {
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
  const urlPrParam = searchParams.get("pr");
  const parsedUrlPr = urlPrParam ? Number.parseInt(urlPrParam, 10) : NaN;
  const targetPrNumber = Number.isFinite(parsedUrlPr) && parsedUrlPr > 0 ? parsedUrlPr : null;

  const [filter, setFilter] = useState<"open" | "closed">(urlFilter);
  const [pulls, setPulls] = useState<PullRequest[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<PullRequest | null>(null);
  const [dataLoaded, setDataLoaded] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const prevRepoRef = useRef<string | null>(null);

  const path = browser.repository?.path;
  const repoKey = browser.repository?.github_repository || path || "";
  const aiSessions = useGitAISessionsStore((state) => state.sessions);

  useSyncGitAISessions(repoKey || undefined);

  const selectPull = useCallback(
    (pull: PullRequest | null, nextState?: "open" | "closed") => {
      setSelected(pull);
      const next = new URLSearchParams(searchParams);
      if (nextState) {
        next.set("state", nextState);
      } else if (!next.get("state")) {
        next.set("state", filter);
      }
      if (pull) {
        next.set("pr", String(pull.number));
      } else {
        next.delete("pr");
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
    if (targetPrNumber === null) {
      setSelected((prev) => (prev ? null : prev));
    }
  }, [urlState, targetPrNumber]);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setLoadMoreError(null);
    setLoading(false);

    const currentRepoId = `${browser.uuid || ""}:${path || ""}:${browser.repository?.github_repository || ""}`;
    if (prevRepoRef.current !== null && prevRepoRef.current !== currentRepoId) {
      setSelected(null);
      if (searchParams.get("pr")) {
        const next = new URLSearchParams(searchParams);
        next.delete("pr");
        setSearchParams(next, { replace: true });
      }
    }
    prevRepoRef.current = currentRepoId;

    if (!isVMRunning || !browser.uuid || !path || !browser.repository?.github_repository) {
      setPulls([]);
      setHasNext(false);
      setDataLoaded(false);
      return;
    }
    setLoading(true);
    setPage(1);
    repositoryRequest<PullRequestsResponse>(
      browser.uuid,
      "github/pull-requests",
      { path, state: filter, page: 1, per_page: 30 },
      controller.signal
    )
      .then((response) => {
        if (!controller.signal.aborted) {
          const list = response.pull_requests || [];
          setPulls(list);
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

  // Restore selected PR from URL param (?pr=123) on page load/reload
  useEffect(() => {
    if (!targetPrNumber) return;
    if (selected?.number === targetPrNumber) return;

    const fromList = pulls.find((item) => item.number === targetPrNumber);
    if (fromList) {
      setSelected(fromList);
      return;
    }

    if (!isVMRunning || !browser.uuid || !path || !browser.repository?.github_repository) return;
    const controller = new AbortController();
    repositoryRequest<PullRequestDetailResponse>(
      browser.uuid,
      `github/pull-requests/${targetPrNumber}`,
      { path },
      controller.signal
    )
      .then((res) => {
        if (!controller.signal.aborted && res.pull_request) {
          setSelected(res.pull_request);
        }
      })
      .catch(() => {
        // Leave unselected if PR cannot be resolved
      });
    return () => controller.abort();
  }, [
    targetPrNumber,
    selected?.number,
    pulls,
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
        repositoryRequest<PullRequestsResponse>(
          browser.uuid!,
          "github/pull-requests",
          { path, state: filter, page: nextPage, per_page: 30 },
          controller.signal
        )
          .then((response) => {
            if (controller.signal.aborted) return;
            setPulls((prev) => {
              const existing = new Set(prev.map((p) => p.number));
              const additions = (response.pull_requests || []).filter((p) => !existing.has(p.number));
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

  const filteredPulls = pulls.filter((pull) => {
    const labelNames = (pull.labels || []).map((l) => l.name).join(" ");
    const searchTarget = `${pull.title} #${pull.number} ${pull.author} ${pull.head} ${pull.base} ${labelNames}`.toLocaleLowerCase();
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
    selectPull(null);
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
          <WorkspacePageTitle icon={LuGitPullRequest}>
            <span className="title-fade-in block truncate px-1">{t("pullRequests.title")}</span>
          </WorkspacePageTitle>
        </div>
      </WorkspacePageHeader>

      <div ref={scrollContainerRef} className="workspace-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 sm:px-8 sm:py-9">
          <div className="workspace-page-enter flex items-start justify-between gap-4">
            <div>
              <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                {t("pullRequests.eyebrow")}
              </p>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t("pullRequests.title")}</h1>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                {t("pullRequests.subtitle")}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={refreshing || !isVMRunning}
              onClick={refresh}
              aria-label={t("pullRequests.refreshAriaLabel")}
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
                {isVMStarting ? (
                  <LuLoaderCircle className="h-5 w-5 motion-safe:animate-spin" />
                ) : (
                  <LuServer className="h-5 w-5" />
                )}
              </span>
              <h3 className="text-sm font-semibold">
                {isVMStarting ? t("common.startingVm", { name: selectedVM?.name || "" }) : t("pullRequests.vmSelectTitle")}
              </h3>
              <p className="mt-2 max-w-sm text-xs leading-relaxed text-muted-foreground">
                {isVMStarting
                  ? t("pullRequests.vmStartingDesc")
                  : vms.length > 0
                    ? t("pullRequests.vmAvailableDesc")
                    : t("pullRequests.vmNoneDesc")}
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
                    <RepositoryPicker
                      repositories={browser.repositories}
                      value={path}
                      onChange={changeRepository}
                    />
                  </div>
                  {browser.repository?.github_repository && (
                    <a
                      href={`https://github.com/${browser.repository.github_repository}/pulls`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      aria-label={t("pullRequests.viewOnGithubAriaLabel")}
                    >
                      <span className="hidden sm:inline">{t("common.viewOnGithub")}</span>
                      <LuExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
              )}

              {(browser.error || error) && !isNoActiveVM(browser.error) && !isNoActiveVM(error) && (
                <div
                  role="alert"
                  className="flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/5 p-4"
                >
                  <LuCircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{t("pullRequests.loadErrorTitle")}</p>
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
                  title={t("pullRequests.emptyNoReposTitle")}
                  description={t("pullRequests.emptyNoReposDesc")}
                >
                  <Button variant="outline" size="sm" onClick={() => openTool("files")}>
                    <LuFolderOpen />
                    {t("common.openFiles")}
                  </Button>
                </RepositoryEmptyState>
              ) : browser.repository && !browser.repository.github_repository ? (
                <RepositoryEmptyState
                  title={t("common.connectGithubTitle")}
                  description={t("pullRequests.emptyNoGithubDesc")}
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
                          aria-label={t("pullRequests.statusFilterAriaLabel")}
                        >
                          {(["open", "closed"] as const).map((state) => (
                            <button
                              key={state}
                              type="button"
                              aria-pressed={filter === state}
                              onClick={() => {
                                setFilter(state);
                                setQuery("");
                                selectPull(null, state);
                              }}
                              className={cn(
                                "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors",
                                filter === state
                                  ? "bg-card text-foreground shadow-sm"
                                  : "text-muted-foreground hover:text-foreground"
                              )}
                            >
                              <LuGitPullRequest
                                aria-hidden
                                className={cn(
                                  "h-3.5 w-3.5",
                                  filter === state &&
                                    (state === "open"
                                      ? "text-emerald-600 dark:text-emerald-400"
                                      : "text-violet-600 dark:text-violet-400")
                                )}
                              />
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
                            aria-label={t("pullRequests.searchPlaceholder")}
                            placeholder={t("pullRequests.searchPlaceholder")}
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
                            ? t("common.matchingCount", { count: filteredPulls.length })
                            : `${filter === "open" ? (pulls.length === 1 ? t("pullRequests.countOpenOne", { count: pulls.length }) : t("pullRequests.countOpenOther", { count: pulls.length })) : (pulls.length === 1 ? t("pullRequests.countClosedOne", { count: pulls.length }) : t("pullRequests.countClosedOther", { count: pulls.length }))}${hasNext ? t("common.scrollForMoreSuffix") : ""}`}
                          {filter === "closed" && <span>{t("pullRequests.includesMerged")}</span>}
                        </p>
                      )}
                    </div>
                  )}

                  {loading && !selected ? (
                    <RepositoryLoading label={t("pullRequests.loading")} />
                  ) : !error && (dataLoaded || Boolean(selected)) && (
                    <div className="workspace-page-enter" style={{ animationDelay: "170ms" }}>
                      {selected ? (
                        <PullRequestDetail
                          pull={selected}
                          vmUuid={browser.uuid}
                          repoPath={path}
                          repoKey={repoKey}
                          repoName={browser.repository?.github_repository || browser.repository?.name || t("common.repositoryFallback")}
                          onBack={() => selectPull(null)}
                        />
                      ) : !filteredPulls.length ? (
                        <RepositoryEmptyState
                          title={query.trim() ? t("pullRequests.noMatchingTitle") : filter === "open" ? t("pullRequests.noOpenTitle") : t("pullRequests.noClosedTitle")}
                          description={
                            query.trim()
                              ? t("pullRequests.noMatchingDesc")
                              : filter === "open"
                                ? t("pullRequests.noOpenDesc")
                                : t("pullRequests.noClosedDesc")
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
                          {filteredPulls.map((pull) => {
                            const aiSession = repoKey
                              ? aiSessions[buildGitAISessionKey("pr", repoKey, pull.number)]
                              : undefined;
                            return (
                            <li key={pull.number}>
                              <button
                                type="button"
                                onClick={() => selectPull(pull)}
                                className="group relative flex w-full min-w-0 items-start gap-3 px-4 py-4 text-left transition-colors before:absolute before:inset-y-3 before:left-0 before:w-0.5 before:rounded-full before:bg-indigo-500 before:opacity-0 before:transition-opacity hover:bg-muted/40 hover:before:opacity-100 focus-visible:bg-muted/40 focus-visible:before:opacity-100 focus-visible:outline-offset-[-2px] sm:gap-4 sm:px-5"
                              >
                                <span
                                  className={cn(
                                    "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
                                    pull.state === "open"
                                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                      : pull.state === "merged"
                                        ? "bg-violet-500/10 text-violet-600 dark:text-violet-400"
                                        : "bg-muted text-muted-foreground"
                                  )}
                                >
                                  {pull.state === "merged" ? (
                                    <LuGitMerge aria-hidden className="h-4 w-4" />
                                  ) : (
                                    <LuGitPullRequest aria-hidden className="h-4 w-4" />
                                  )}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="line-clamp-2 break-words text-sm font-semibold leading-6 transition-colors group-hover:text-primary">
                                    {pull.title}
                                  </span>
                                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                                    <span className="font-mono font-medium">#{pull.number}</span>
                                    <span className="inline-flex items-center gap-1.5 break-all">
                                      {pull.author_avatar ? (
                                        <img
                                          src={pull.author_avatar}
                                          alt={pull.author}
                                          className="h-3.5 w-3.5 rounded-full object-cover"
                                          loading="lazy"
                                        />
                                      ) : null}
                                      {t("common.byAuthor", { author: pull.author || t("common.unknownAuthor") })}
                                    </span>
                                    <span className="text-muted-foreground/50" aria-hidden>
                                      ·
                                    </span>
                                    <RepositoryTimestamp value={pull.updated_at} prefix={t("timestamps.updatedPrefix")} />
                                  </span>

                                  <span className="mt-2.5 block">
                                    <BranchComparison head={pull.head} base={pull.base} />
                                  </span>

                                  {pull.labels && pull.labels.length > 0 && (
                                    <span className="mt-2.5 flex flex-wrap gap-1.5">
                                      {pull.labels.map((label) => (
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

                                  <span className="mt-2 flex flex-wrap items-center gap-2 sm:hidden">
                                    <PullStatus state={pull.state} />
                                    <GitAISessionBadge session={aiSession} />
                                  </span>
                                </span>

                                <div className="hidden sm:flex items-center gap-3 shrink-0 pt-1">
                                  {pull.assignees && pull.assignees.length > 0 && (
                                    <div className="flex -space-x-1.5 overflow-hidden">
                                      {pull.assignees.slice(0, 3).map((assignee) => (
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

                                  {typeof pull.comments === "number" && pull.comments > 0 && (
                                    <span
                                      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground shrink-0"
                                      title={t("common.commentsCount", { count: pull.comments })}
                                    >
                                      <LuMessageSquare className="h-3.5 w-3.5" />
                                      <span>{pull.comments}</span>
                                    </span>
                                  )}

                                  <GitAISessionBadge session={aiSession} />
                                  <PullStatus state={pull.state} />
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
                              {loadingMore && (
                                <LuLoaderCircle aria-hidden className="h-4 w-4 animate-spin text-muted-foreground" />
                              )}
                              {loadingMore ? t("pullRequests.loadingMore") : t("pullRequests.scrollForMore")}
                            </span>
                          )}
                        </div>
                      )}
                      {!selected && !hasNext && pulls.length > 5 && (
                        <p className="py-4 text-center text-xs text-muted-foreground/60">
                          {filter === "open" ? t("pullRequests.allOpenLoaded") : t("pullRequests.allClosedLoaded")}
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

function PullRequestDetail({
  pull,
  vmUuid,
  repoPath,
  repoKey,
  repoName,
  onBack,
}: {
  pull: PullRequest;
  vmUuid?: string;
  repoPath?: string;
  repoKey: string;
  repoName: string;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation("git");
  const [activeTab, setActiveTab] = useState<"overview" | "files" | "commits" | "checks">("overview");
  const [checkingOut, setCheckingOut] = useState(false);
  const [detailRefreshTick, setDetailRefreshTick] = useState(0);

  const sessionKey = buildGitAISessionKey("pr", repoKey || repoPath || "", pull.number);
  const aiSession = useGitAISessionsStore((state) => state.sessions[sessionKey]);
  const studioOpen = Boolean(aiSession?.studioOpen);
  const activeMode = aiSession?.mode || null;
  const isGeneratingAi = isGitAISessionActiveStatus(aiSession?.status);

  // Detailed info
  const [detail, setDetail] = useState<PullRequestDetailData | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Files
  const [files, setFiles] = useState<PullRequestFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});

  // Commits
  const [commits, setCommits] = useState<PullRequestCommit[]>([]);
  const [loadingCommits, setLoadingCommits] = useState(false);
  const [commitsError, setCommitsError] = useState<string | null>(null);

  // Comments
  const [comments, setComments] = useState<PullRequestComment[]>([]);
  const [loadingComments, setLoadingComments] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);

  // Checks
  const [checks, setChecks] = useState<PullRequestCheck[]>([]);
  const [loadingChecks, setLoadingChecks] = useState(false);
  const [checksError, setChecksError] = useState<string | null>(null);

  // Copy states
  const [copiedBranch, setCopiedBranch] = useState(false);
  const [copiedSha, setCopiedSha] = useState<string | null>(null);
  const [copiedFileDiff, setCopiedFileDiff] = useState<string | null>(null);

  // Clear per-PR detail state only (persisted AI sessions live in useGitAISessionsStore)

  // Fetch full details
  useEffect(() => {
    if (!vmUuid || !repoPath || !pull.number) return;
    const controller = new AbortController();
    setLoadingDetail(true);
    repositoryRequest<PullRequestDetailResponse>(
      vmUuid,
      `github/pull-requests/${pull.number}`,
      { path: repoPath },
      controller.signal
    )
      .then((res) => {
        if (!controller.signal.aborted && res.pull_request) {
          setDetail(res.pull_request);
        }
      })
      .catch(() => {
        // Fallback gracefully to list item pull
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingDetail(false);
      });
    return () => controller.abort();
  }, [vmUuid, repoPath, pull.number, detailRefreshTick]);

  // Fetch files
  useEffect(() => {
    if (!vmUuid || !repoPath || !pull.number) return;
    const controller = new AbortController();
    setLoadingFiles(true);
    setFilesError(null);
    repositoryRequest<PullRequestFilesResponse>(
      vmUuid,
      `github/pull-requests/${pull.number}/files`,
      { path: repoPath },
      controller.signal
    )
      .then((res) => {
        if (!controller.signal.aborted) {
          const list = res.files || [];
          setFiles(list);
          // Auto-expand first 5 files by default
          const initialExpanded: Record<string, boolean> = {};
          list.slice(0, 5).forEach((f) => {
            initialExpanded[f.filename] = true;
          });
          setExpandedFiles(initialExpanded);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) setFilesError(repositoryError(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingFiles(false);
      });
    return () => controller.abort();
  }, [vmUuid, repoPath, pull.number, detailRefreshTick]);

  // Fetch commits
  useEffect(() => {
    if (!vmUuid || !repoPath || !pull.number) return;
    const controller = new AbortController();
    setLoadingCommits(true);
    setCommitsError(null);
    repositoryRequest<PullRequestCommitsResponse>(
      vmUuid,
      `github/pull-requests/${pull.number}/commits`,
      { path: repoPath },
      controller.signal
    )
      .then((res) => {
        if (!controller.signal.aborted) setCommits(res.commits || []);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setCommitsError(repositoryError(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingCommits(false);
      });
    return () => controller.abort();
  }, [vmUuid, repoPath, pull.number, detailRefreshTick]);

  // Fetch comments
  const fetchComments = () => {
    if (!vmUuid || !repoPath || !pull.number) return;
    const controller = new AbortController();
    setLoadingComments(true);
    setCommentsError(null);
    repositoryRequest<PullRequestCommentsResponse>(
      vmUuid,
      `github/pull-requests/${pull.number}/comments`,
      { path: repoPath },
      controller.signal
    )
      .then((res) => {
        if (!controller.signal.aborted) setComments(res.comments || []);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setCommentsError(repositoryError(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingComments(false);
      });
  };

  useEffect(() => {
    fetchComments();
  }, [vmUuid, repoPath, pull.number]);

  // Fetch checks
  useEffect(() => {
    if (!vmUuid || !repoPath || !pull.number) return;
    const controller = new AbortController();
    setLoadingChecks(true);
    setChecksError(null);
    repositoryRequest<PullRequestChecksResponse>(
      vmUuid,
      `github/pull-requests/${pull.number}/checks`,
      pull.head_sha ? { path: repoPath, ref: pull.head_sha } : { path: repoPath },
      controller.signal
    )
      .then((res) => {
        if (!controller.signal.aborted) setChecks(res.checks || []);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setChecksError(repositoryError(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingChecks(false);
      });
    return () => controller.abort();
  }, [vmUuid, repoPath, pull.number, pull.head_sha]);

  const handleCopyBranch = () => {
    navigator.clipboard.writeText(pull.head);
    setCopiedBranch(true);
    toaster.create({ title: t("pullRequests.copiedBranch", { branch: pull.head }), type: "success" });
    setTimeout(() => setCopiedBranch(false), 2000);
  };

  const handleCheckoutBranch = async () => {
    if (!vmUuid || !repoPath) return;
    setCheckingOut(true);
    try {
      const status = await repositoryMutation<RepositoryStatus>(vmUuid, "git/switch", {
        path: repoPath,
        branch: pull.head,
        fetch: true,
      });
      toaster.create({
        title: t("pullRequests.checkedOutBranch", { branch: status.branch }),
        description: t("pullRequests.workspaceOnBranch", { branch: status.branch }),
        type: "success",
      });
    } catch (err) {
      const cmd = `git fetch origin pull/${pull.number}/head:${pull.head} && git checkout ${pull.head}`;
      navigator.clipboard.writeText(cmd);
      toaster.create({
        title: t("pullRequests.checkoutFailedCopied"),
        description: repositoryError(err),
        type: "info",
      });
    } finally {
      setCheckingOut(false);
    }
  };

  const buildPRContextText = () => {
    let commentsText = "";
    if (comments && comments.length > 0) {
      commentsText =
        "\n\n**Pull Request Discussion & Review Comments:**\n" +
        comments
          .slice(0, 15)
          .map(
            (c) =>
              `> **@${c.author}** ${c.type === "review_comment" ? `(on \`${c.path || ""}:${c.line || ""}\`)` : ""} commented:\n> ${c.body.replace(/\n/g, "\n> ")}`
          )
          .join("\n\n");
    }
    let filesText = "";
    if (files && files.length > 0) {
      filesText =
        "\n\n**Changed Files:**\n" +
        files
          .slice(0, 25)
          .map((f) => `- \`${f.filename}\` (${f.status}, +${f.additions} -${f.deletions})`)
          .join("\n");
    }
    const failingChecks = checks.filter(
      (c) => c.conclusion === "failure" || c.conclusion === "timed_out"
    );
    let checksText = "";
    if (failingChecks.length > 0) {
      checksText =
        "\n\n**Failing CI Checks:**\n" +
        failingChecks.map((c) => `- **${c.name}**: ${c.conclusion}`).join("\n");
    }
    return { commentsText, filesText, checksText };
  };

  const buildPRPrompt = (mode: AIStudioMode, failedCheck?: PullRequestCheck) => {
    const { commentsText, filesText, checksText } = buildPRContextText();
    if (mode === "pr-review") {
      const patchesPreview = files
        .slice(0, 10)
        .filter((f) => f.patch)
        .map((f) => `### \`${f.filename}\`\n\`\`\`diff\n${(f.patch || "").slice(0, 1500)}\n\`\`\``)
        .join("\n\n");
      return (
        `Please perform a thorough code review of GitHub Pull Request #${pull.number} (${pull.title}) in \`${repoPath || "/workspace"}\` (${repoName}):\n\n` +
        `**Branches:** \`${pull.head}\` → \`${pull.base}\`\n` +
        (pull.body ? `**Description:**\n${pull.body}\n\n` : "") +
        filesText +
        checksText +
        commentsText +
        (patchesPreview ? `\n\n**Key File Patches:**\n${patchesPreview}` : "") +
        `\n\nProvide a concise, actionable code review covering:\n1. Summary of changes\n2. Potential bugs, edge cases, or security issues\n3. Concrete suggestions for improvement (without modifying files unless asked).`
      );
    }
    if (mode === "pr-fix-ci" && failedCheck) {
      return (
        `CI check **"${failedCheck.name}"** failed (${failedCheck.conclusion}) on Pull Request #${pull.number} (${pull.title}, branch \`${pull.head}\`) in \`${repoPath || "/workspace"}\` (${repoName}).\n\n` +
        (failedCheck.url ? `**Check URL:** ${failedCheck.url}\n` : "") +
        filesText +
        `\n\nPlease investigate the codebase in \`${repoPath || "/workspace"}\`, reproduce or diagnose why "${failedCheck.name}" is failing, apply the fix directly to the files, and verify the fix passes.`
      );
    }
    return (
      `Please help resolve feedback and issues on GitHub Pull Request #${pull.number} (${pull.title}) in \`${repoPath || "/workspace"}\` (${repoName}):\n\n` +
      `**Branches:** \`${pull.head}\` into \`${pull.base}\`\n` +
      (pull.body ? `**Description:**\n${pull.body}\n\n` : "") +
      filesText +
      checksText +
      commentsText +
      `\n\nPlease inspect the changed files in \`${repoPath || "/workspace"}\`, address any requested review feedback, failing checks, or bugs directly in the code, run relevant tests to verify, and summarize your fixes.`
    );
  };

  const startPRAISession = (mode: AIStudioMode, prompt: string, forceRerun = false) => {
    if (!vmUuid || !repoPath) return;
    if (!forceRerun && aiSession && aiSession.mode === mode) {
      if (isGitAISessionActiveStatus(aiSession.status)) {
        useGitAISessionsStore.getState().setStudioOpen(sessionKey, true);
        return;
      }
      if (!aiSession.studioOpen) {
        useGitAISessionsStore.getState().setStudioOpen(sessionKey, true);
        return;
      }
    }
    void launchGitAISession({
      kind: "pr",
      repoKey: repoKey || repoPath,
      number: pull.number,
      title: pull.title,
      mode,
      vmUuid,
      repoPath,
      initialPrompt: prompt,
      targetBranch: pull.head,
      createBranchIfMissing: false,
      baseBranch: pull.base,
      defaultCommitMessage: `fix: address feedback on PR #${pull.number}`,
    });
  };

  const handleStartAIReview = () => {
    startPRAISession("pr-review", buildPRPrompt("pr-review"));
  };

  const handleStartAIFix = () => {
    startPRAISession("pr-fix", buildPRPrompt("pr-fix"));
  };

  const handleFixCheckWithAI = (check: PullRequestCheck) => {
    startPRAISession("pr-fix-ci", buildPRPrompt("pr-fix-ci", check), true);
  };

  const handleCopySha = (sha: string) => {
    navigator.clipboard.writeText(sha);
    setCopiedSha(sha);
    toaster.create({ title: t("pullRequests.shaCopied"), type: "success" });
    setTimeout(() => setCopiedSha(null), 2000);
  };

  const handleCopyFileDiff = (filename: string, patch: string) => {
    navigator.clipboard.writeText(patch);
    setCopiedFileDiff(filename);
    toaster.create({ title: t("pullRequests.diffCopied", { file: filename }), type: "success" });
    setTimeout(() => setCopiedFileDiff(null), 2000);
  };

  const toggleFile = (filename: string) => {
    setExpandedFiles((prev) => ({ ...prev, [filename]: !prev[filename] }));
  };

  const toggleAllFiles = (expand: boolean) => {
    const next: Record<string, boolean> = {};
    files.forEach((f) => {
      next[f.filename] = expand;
    });
    setExpandedFiles(next);
  };

  const totalAdditions = detail?.additions ?? files.reduce((acc, f) => acc + (f.additions || 0), 0);
  const totalDeletions = detail?.deletions ?? files.reduce((acc, f) => acc + (f.deletions || 0), 0);
  const totalChangedFiles = detail?.changed_files ?? files.length;
  const totalCommitsCount = detail?.commits_count ?? commits.length;

  const currentPull = detail || pull;
  const labels = currentPull.labels || [];
  const assignees = currentPull.assignees || [];
  const requestedReviewers = detail?.requested_reviewers || [];
  const milestone = detail?.milestone;

  const tabs = [
    {
      id: "overview" as const,
      label: t("pullRequests.tabs.overview"),
      icon: LuMessageSquare,
      count: comments.length,
    },
    {
      id: "files" as const,
      label: t("pullRequests.tabs.filesChanged"),
      icon: LuFileCode,
      count: totalChangedFiles,
    },
    {
      id: "commits" as const,
      label: t("pullRequests.tabs.commits"),
      icon: LuGitCommitHorizontal,
      count: totalCommitsCount,
    },
    {
      id: "checks" as const,
      label: t("pullRequests.tabs.checks"),
      icon: LuCircleCheck,
      count: checks.length,
    },
  ];

  return (
    <div className="workspace-page-enter space-y-6">
      {/* Top action bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="-ml-2 text-muted-foreground hover:text-foreground"
        >
          <LuArrowLeft className="mr-1.5 h-4 w-4" />
          {t("pullRequests.backToList")}
        </Button>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={checkingOut}
            onClick={() => void handleCheckoutBranch()}
            title={t("pullRequests.checkoutBranchTitle", { branch: pull.head })}
            className="gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            {checkingOut ? (
              <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <LuGitBranch className="h-3.5 w-3.5" />
            )}
            <span>{t("pullRequests.checkoutBranch")}</span>
          </Button>

          <a
            href={pull.url}
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
            onClick={handleStartAIReview}
            disabled={isGeneratingAi && activeMode === "pr-review" && studioOpen}
            className="gap-1.5 border-indigo-500/30 bg-indigo-500/5 text-xs font-medium text-indigo-600 hover:bg-indigo-500/15 dark:text-indigo-400"
          >
            {isGeneratingAi && activeMode === "pr-review" ? (
              <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <LuSparkles className="h-3.5 w-3.5" />
            )}
            <span>
              {isGeneratingAi && activeMode === "pr-review"
                ? t("pullRequests.generatingReview")
                : t("pullRequests.aiReview")}
            </span>
          </Button>

          <Button
            size="sm"
            onClick={handleStartAIFix}
            disabled={isGeneratingAi && (activeMode === "pr-fix" || activeMode === "pr-fix-ci") && studioOpen}
            className="gap-1.5 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white shadow-xs"
          >
            {isGeneratingAi && (activeMode === "pr-fix" || activeMode === "pr-fix-ci") ? (
              <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <LuSparkles className="h-3.5 w-3.5" />
            )}
            <span>
              {isGeneratingAi && (activeMode === "pr-fix" || activeMode === "pr-fix-ci")
                ? t("pullRequests.fixingWithAi")
                : t("pullRequests.fixWithAi")}
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
          targetBranch={pull.head}
          createBranchIfMissing={false}
          baseBranch={pull.base}
          defaultCommitMessage={`fix: address feedback on PR #${pull.number}`}
          pullNumber={pull.number}
          onClose={() => useGitAISessionsStore.getState().setStudioOpen(sessionKey, false)}
          onRerun={() =>
            startPRAISession(
              aiSession.mode,
              aiSession.mode === "pr-fix-ci" ? aiSession.initialPrompt : buildPRPrompt(aiSession.mode),
              true
            )
          }
          onSuccessRefresh={() => setDetailRefreshTick((t) => t + 1)}
        />
      )}

      {/* Hero Header Card */}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="space-y-4 border-b border-border bg-muted/20 p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-2">
            <PullStatus state={currentPull.state} />
            <span className="text-xs text-muted-foreground/60">·</span>
            <span className="text-xs font-mono text-muted-foreground">{t("pullRequests.prNumber", { number: currentPull.number })}</span>
            {detail?.mergeable !== undefined && detail?.mergeable !== null && (
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium border",
                  detail.mergeable
                    ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-400"
                    : "bg-amber-500/10 text-amber-600 border-amber-500/20 dark:text-amber-400"
                )}
              >
                {detail.mergeable ? t("pullRequests.cleanMergeable") : t("pullRequests.conflictsExist")}
              </span>
            )}
          </div>

          <h2 className="break-words text-xl font-semibold leading-snug tracking-tight sm:text-2xl">
            {currentPull.title}
          </h2>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 break-all font-medium text-foreground">
              {currentPull.author_avatar ? (
                <img
                  src={currentPull.author_avatar}
                  alt={currentPull.author}
                  className="h-4 w-4 rounded-full object-cover"
                />
              ) : (
                <LuUser className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              {currentPull.author || t("common.unknownAuthor")}
            </span>
            <span className="text-muted-foreground/40" aria-hidden>
              {t("pullRequests.wantsToMergeInto")}
            </span>
            <span className="font-mono text-foreground rounded bg-muted/70 px-1.5 py-0.5">
              {currentPull.base}
            </span>
            <span className="text-muted-foreground/40" aria-hidden>
              {t("pullRequests.fromBranch")}
            </span>
            <button
              type="button"
              onClick={handleCopyBranch}
              className="inline-flex items-center gap-1 font-mono text-foreground rounded bg-muted/70 px-1.5 py-0.5 hover:bg-muted"
              title={t("pullRequests.copyBranchTitle")}
            >
              <span>{currentPull.head}</span>
              {copiedBranch ? (
                <LuCheck className="h-3 w-3 text-emerald-500" />
              ) : (
                <LuCopy className="h-3 w-3 text-muted-foreground" />
              )}
            </button>
            <span className="text-muted-foreground/40" aria-hidden>
              ·
            </span>
            <RepositoryTimestamp value={currentPull.created_at || currentPull.updated_at} prefix={t("timestamps.openedPrefix")} />
            <span className="text-muted-foreground/40" aria-hidden>
              ·
            </span>
            <RepositoryTimestamp value={currentPull.updated_at} prefix={t("timestamps.updatedPrefix")} />
          </div>

          {/* Diff stats bar */}
          <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-2.5 py-1 font-mono">
              <span className="font-semibold text-emerald-600 dark:text-emerald-400">+{totalAdditions}</span>
              <span className="font-semibold text-rose-600 dark:text-rose-400">−{totalDeletions}</span>
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-muted/40 px-2.5 py-1 text-muted-foreground">
              <LuFileCode className="h-3.5 w-3.5" />
              <span>
                {totalChangedFiles === 1
                  ? t("pullRequests.filesChangedOne", { count: totalChangedFiles })
                  : t("pullRequests.filesChangedOther", { count: totalChangedFiles })}
              </span>
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-muted/40 px-2.5 py-1 text-muted-foreground">
              <LuGitCommitHorizontal className="h-3.5 w-3.5" />
              <span>
                {totalCommitsCount === 1
                  ? t("pullRequests.commitsCountOne", { count: totalCommitsCount })
                  : t("pullRequests.commitsCountOther", { count: totalCommitsCount })}
              </span>
            </span>
          </div>
        </div>

        {/* Tab navigation bar */}
        <div className="flex border-b border-border bg-card px-4 sm:px-6 overflow-x-auto">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "relative inline-flex items-center gap-2 border-b-2 py-3 px-3 text-xs font-medium transition-colors shrink-0",
                  isActive
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className={cn("h-4 w-4", isActive ? "text-primary" : "text-muted-foreground")} />
                <span>{tab.label}</span>
                {typeof tab.count === "number" && tab.count > 0 && (
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.2 text-[10px] font-mono",
                      isActive
                        ? "bg-primary/10 text-primary font-semibold"
                        : "bg-muted text-muted-foreground"
                    )}
                  >
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Tab Content and Sidebar */}
        <div className="grid grid-cols-1 gap-6 p-5 sm:p-6 lg:grid-cols-4">
          <div className="space-y-6 lg:col-span-3 min-w-0">
            {/* OVERVIEW TAB */}
            {activeTab === "overview" && (
              <div className="space-y-6">
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
                      {currentPull.body || t("common.noDescription")}
                    </ReactMarkdown>
                  </div>
                </div>

                {/* Comments & Discussion */}
                <div className="space-y-4 pt-2">
                  <div className="flex items-center justify-between">
                    <h3 className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      <LuMessageSquare className="h-3.5 w-3.5" />
                      <span>{t("pullRequests.discussionTitle")}</span>
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
                      <p>{t("pullRequests.noComments")}</p>
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
                              {comment.type === "review_comment" && (
                                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                  {t("pullRequests.reviewCommentBadge")}
                                </span>
                              )}
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

                          {comment.path && (
                            <div className="border-b border-border/60 bg-muted/10 px-4 py-1.5 text-[11px] font-mono text-muted-foreground">
                              <span>{comment.path}</span>
                              {comment.line && <span className="text-muted-foreground/60">:L{comment.line}</span>}
                            </div>
                          )}

                          {comment.diff_hunk && (
                            <div className="border-b border-border/60 bg-zinc-950 p-2 font-mono text-[11px] leading-4 text-zinc-400 overflow-x-auto">
                              <pre className="whitespace-pre">{comment.diff_hunk}</pre>
                            </div>
                          )}

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
            )}

            {/* FILES CHANGED TAB */}
            {activeTab === "files" && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
                  <div className="text-xs text-muted-foreground">
                    <Trans
                      i18nKey="pullRequests.filesSummary"
                      ns="git"
                      values={{
                        filesCount: files.length,
                        additions: totalAdditions,
                        deletions: totalDeletions,
                      }}
                      components={{
                        filesSpan: <span className="font-semibold text-foreground" />,
                        addSpan: <span className="font-semibold text-emerald-600 dark:text-emerald-400" />,
                        delSpan: <span className="font-semibold text-rose-600 dark:text-rose-400" />,
                      }}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => toggleAllFiles(true)}
                      className="h-7 text-xs"
                    >
                      {t("pullRequests.expandAll")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => toggleAllFiles(false)}
                      className="h-7 text-xs"
                    >
                      {t("pullRequests.collapseAll")}
                    </Button>
                  </div>
                </div>

                {loadingFiles ? (
                  <div className="rounded-xl border border-border bg-card/50 p-6 text-center">
                    <RepositoryLoading label={t("pullRequests.loadingFilesDiff")} />
                  </div>
                ) : filesError ? (
                  <div
                    role="alert"
                    className="flex items-center justify-between rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-xs text-destructive"
                  >
                    <span>{filesError}</span>
                  </div>
                ) : files.length === 0 ? (
                  <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/80 bg-muted/10 px-4 py-8 text-center text-xs text-muted-foreground">
                    <LuFileCode className="mb-2 h-5 w-5 text-muted-foreground/40" />
                    <p>{t("pullRequests.noFiles")}</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {files.map((file) => {
                      const isExpanded = expandedFiles[file.filename] ?? false;
                      const statusColor =
                        file.status === "added"
                          ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
                          : file.status === "removed"
                            ? "bg-rose-500/10 text-rose-600 border-rose-500/20"
                            : "bg-blue-500/10 text-blue-600 border-blue-500/20";
                      const fileStatusLabel =
                        file.status === "added"
                          ? t("pullRequests.fileStatus.added")
                          : file.status === "modified"
                            ? t("pullRequests.fileStatus.modified")
                            : file.status === "removed"
                              ? t("pullRequests.fileStatus.removed")
                              : file.status === "renamed"
                                ? t("pullRequests.fileStatus.renamed")
                                : file.status === "copied"
                                  ? t("pullRequests.fileStatus.copied")
                                  : file.status === "changed"
                                    ? t("pullRequests.fileStatus.changed")
                                    : file.status;

                      return (
                        <div
                          key={file.filename}
                          className="overflow-hidden rounded-xl border border-border bg-card"
                        >
                          <div className="flex items-center justify-between border-b border-border bg-muted/20 px-4 py-2.5">
                            <button
                              type="button"
                              onClick={() => toggleFile(file.filename)}
                              className="flex items-center gap-2.5 min-w-0 text-left hover:text-primary transition-colors flex-1"
                            >
                              {isExpanded ? (
                                <LuChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                              ) : (
                                <LuChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                              )}
                              <span
                                className={cn(
                                  "rounded px-1.5 py-0.5 text-[10px] font-mono font-medium uppercase border",
                                  statusColor
                                )}
                              >
                                {fileStatusLabel}
                              </span>
                              <span className="font-mono text-xs font-semibold text-foreground truncate">
                                {file.filename}
                              </span>
                              {file.previous_filename && (
                                <span className="text-[11px] text-muted-foreground truncate">
                                  {t("pullRequests.renamedFrom", { name: file.previous_filename })}
                                </span>
                              )}
                            </button>

                            <div className="flex items-center gap-3 shrink-0 ml-3">
                              <span className="font-mono text-xs">
                                <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{" "}
                                <span className="text-rose-600 dark:text-rose-400">−{file.deletions}</span>
                              </span>
                              {file.patch && (
                                <button
                                  type="button"
                                  onClick={() => handleCopyFileDiff(file.filename, file.patch!)}
                                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                                  title={t("pullRequests.copyFileDiffTitle")}
                                >
                                  {copiedFileDiff === file.filename ? (
                                    <LuCheck className="h-3.5 w-3.5 text-emerald-500" />
                                  ) : (
                                    <LuCopy className="h-3.5 w-3.5" />
                                  )}
                                </button>
                              )}
                            </div>
                          </div>

                          {isExpanded && (
                            <div className="bg-zinc-950 font-mono text-[12px] leading-5 overflow-x-auto p-3">
                              {file.patch ? (
                                file.patch.split("\n").map((line, idx) => {
                                  let lineCls = "text-zinc-400";
                                  if (line.startsWith("+") && !line.startsWith("+++")) {
                                    lineCls = "bg-emerald-950/60 text-emerald-300 font-medium";
                                  } else if (line.startsWith("-") && !line.startsWith("---")) {
                                    lineCls = "bg-rose-950/60 text-rose-300 font-medium";
                                  } else if (line.startsWith("@@")) {
                                    lineCls = "text-cyan-400 font-semibold bg-cyan-950/30";
                                  } else if (line.startsWith("diff ") || line.startsWith("index ")) {
                                    lineCls = "text-zinc-500 font-semibold";
                                  }
                                  return (
                                    <div key={idx} className={cn("px-2 py-0.5 whitespace-pre rounded-sm", lineCls)}>
                                      {line || " "}
                                    </div>
                                  );
                                })
                              ) : (
                                <p className="p-3 text-xs text-zinc-500 italic">
                                  {t("pullRequests.binaryOrNoChanges")}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* COMMITS TAB */}
            {activeTab === "commits" && (
              <div className="space-y-4">
                <div className="text-xs text-muted-foreground border-b border-border pb-3">
                  <Trans
                    i18nKey="pullRequests.commitsSummary"
                    ns="git"
                    values={{ count: commits.length }}
                    components={{ countSpan: <span className="font-semibold text-foreground" /> }}
                  />
                </div>

                {loadingCommits ? (
                  <div className="rounded-xl border border-border bg-card/50 p-6 text-center">
                    <RepositoryLoading label={t("pullRequests.loadingCommits")} />
                  </div>
                ) : commitsError ? (
                  <div
                    role="alert"
                    className="flex items-center justify-between rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-xs text-destructive"
                  >
                    <span>{commitsError}</span>
                  </div>
                ) : commits.length === 0 ? (
                  <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/80 bg-muted/10 px-4 py-8 text-center text-xs text-muted-foreground">
                    <LuGitCommitHorizontal className="mb-2 h-5 w-5 text-muted-foreground/40" />
                    <p>{t("pullRequests.noCommits")}</p>
                  </div>
                ) : (
                  <ul className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border bg-card shadow-xs">
                    {commits.map((commit) => (
                      <li key={commit.sha} className="flex items-start justify-between gap-3 p-4 hover:bg-muted/30 transition-colors">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-sm text-foreground break-words">
                            {commit.message}
                          </p>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                            {commit.author_avatar ? (
                              <img
                                src={commit.author_avatar}
                                alt={commit.author_login || commit.author_name}
                                className="h-3.5 w-3.5 rounded-full object-cover"
                              />
                            ) : (
                              <LuUser className="h-3.5 w-3.5" />
                            )}
                            <span className="font-medium text-foreground">
                              {commit.author_login || commit.author_name || t("common.unknown")}
                            </span>
                            <span className="text-muted-foreground/50">·</span>
                            <RepositoryTimestamp value={commit.date} prefix={t("timestamps.committedPrefix")} />
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0 pt-0.5">
                          <button
                            type="button"
                            onClick={() => handleCopySha(commit.sha)}
                            className="inline-flex items-center gap-1 rounded bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                            title={t("pullRequests.copyShaTitle")}
                          >
                            <span>{commit.short_sha}</span>
                            {copiedSha === commit.sha ? (
                              <LuCheck className="h-3 w-3 text-emerald-500" />
                            ) : (
                              <LuCopy className="h-3 w-3" />
                            )}
                          </button>
                          {commit.url && (
                            <a
                              href={commit.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                              title={t("pullRequests.openCommitOnGithub")}
                            >
                              <LuExternalLink className="h-3.5 w-3.5" />
                            </a>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* CHECKS & CI TAB */}
            {activeTab === "checks" && (
              <div className="space-y-4">
                <div className="text-xs text-muted-foreground border-b border-border pb-3">
                  <Trans
                    i18nKey="pullRequests.checksSummary"
                    ns="git"
                    values={{
                      count: checks.length,
                      sha: pull.head_sha ? pull.head_sha.slice(0, 7) : pull.head,
                    }}
                    components={{
                      countSpan: <span className="font-semibold text-foreground" />,
                      shaSpan: <span className="font-mono text-foreground font-semibold" />,
                    }}
                  />
                </div>

                {loadingChecks ? (
                  <div className="rounded-xl border border-border bg-card/50 p-6 text-center">
                    <RepositoryLoading label={t("pullRequests.loadingChecks")} />
                  </div>
                ) : checksError ? (
                  <div
                    role="alert"
                    className="flex items-center justify-between rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-xs text-destructive"
                  >
                    <span>{checksError}</span>
                  </div>
                ) : checks.length === 0 ? (
                  <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/80 bg-muted/10 px-4 py-8 text-center text-xs text-muted-foreground">
                    <LuCircleCheck className="mb-2 h-5 w-5 text-muted-foreground/40" />
                    <p>{t("pullRequests.noChecks")}</p>
                  </div>
                ) : (
                  <ul className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border bg-card shadow-xs">
                    {checks.map((check) => {
                      const isSuccess = check.conclusion === "success";
                      const isFailure = check.conclusion === "failure" || check.conclusion === "timed_out";
                      const isRunning = check.status === "in_progress" || check.status === "queued";
                      const rawCheckStatus = check.conclusion || check.status;
                      const checkStatusLabel =
                        rawCheckStatus === "success"
                          ? t("pullRequests.checkStatus.success")
                          : rawCheckStatus === "failure"
                            ? t("pullRequests.checkStatus.failure")
                            : rawCheckStatus === "timed_out"
                              ? t("pullRequests.checkStatus.timed_out")
                              : rawCheckStatus === "cancelled"
                                ? t("pullRequests.checkStatus.cancelled")
                                : rawCheckStatus === "skipped"
                                  ? t("pullRequests.checkStatus.skipped")
                                  : rawCheckStatus === "neutral"
                                    ? t("pullRequests.checkStatus.neutral")
                                    : rawCheckStatus === "action_required"
                                      ? t("pullRequests.checkStatus.action_required")
                                      : rawCheckStatus === "queued"
                                        ? t("pullRequests.checkStatus.queued")
                                        : rawCheckStatus === "in_progress"
                                          ? t("pullRequests.checkStatus.in_progress")
                                          : rawCheckStatus === "completed"
                                            ? t("pullRequests.checkStatus.completed")
                                            : rawCheckStatus;

                      return (
                        <li key={check.id} className="flex items-center justify-between gap-3 p-4 hover:bg-muted/30 transition-colors">
                          <div className="flex items-center gap-3 min-w-0">
                            <span
                              className={cn(
                                "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                                isSuccess
                                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                  : isFailure
                                    ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                                    : "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                              )}
                            >
                              {isRunning ? (
                                <LuLoaderCircle className="h-4 w-4 animate-spin" />
                              ) : isSuccess ? (
                                <LuCircleCheck className="h-4 w-4" />
                              ) : (
                                <LuCircleAlert className="h-4 w-4" />
                              )}
                            </span>

                            <div className="min-w-0">
                              <p className="font-medium text-sm text-foreground truncate">{check.name}</p>
                              <p className="text-xs text-muted-foreground capitalize">
                                {checkStatusLabel}
                                {check.completed_at && (
                                  <>
                                    {" "}
                                    · <RepositoryTimestamp value={check.completed_at} prefix={t("timestamps.finishedPrefix")} />
                                  </>
                                )}
                              </p>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            {isFailure && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleFixCheckWithAI(check)}
                                className="h-7 gap-1 border-rose-500/30 bg-rose-500/10 px-2.5 text-xs text-rose-600 hover:bg-rose-500/20 dark:text-rose-400"
                              >
                                <LuSparkles className="h-3 w-3" />
                                <span>{t("pullRequests.fixCheckWithAi")}</span>
                              </Button>
                            )}
                            {check.url && (
                              <a
                                href={check.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground shrink-0 rounded-md px-2 py-1 hover:bg-muted"
                              >
                                <span>{t("pullRequests.checkDetails")}</span>
                                <LuExternalLink className="h-3 w-3" />
                              </a>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* SIDEBAR METADATA */}
          <div className="space-y-5 lg:border-l lg:border-border lg:pl-6">
            <div>
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("pullRequests.reviewers")}
              </h4>
              {requestedReviewers.length > 0 ? (
                <ul className="space-y-1.5">
                  {requestedReviewers.map((reviewer) => (
                    <li key={reviewer.login} className="flex items-center gap-2 text-xs">
                      {reviewer.avatar_url ? (
                        <img
                          src={reviewer.avatar_url}
                          alt={reviewer.login}
                          className="h-4 w-4 rounded-full object-cover"
                        />
                      ) : (
                        <LuUser className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      <span className="font-medium text-foreground">@{reviewer.login}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground/70">{t("pullRequests.noReviewsRequested")}</p>
              )}
            </div>

            <div>
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("common.assignees")}
              </h4>
              {assignees.length > 0 ? (
                <ul className="space-y-1.5">
                  {assignees.map((assignee) => (
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
              {labels.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {labels.map((label) => (
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
              {milestone ? (
                <div className="rounded-lg border border-border bg-muted/20 p-2.5 text-xs">
                  <div className="flex items-center gap-1.5 font-medium text-foreground">
                    <LuMilestone className="h-3.5 w-3.5 text-primary" />
                    <span>{milestone.title}</span>
                  </div>
                  {milestone.due_on && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {t("common.dueDate", {
                        date: new Date(milestone.due_on).toLocaleDateString(i18n.resolvedLanguage || "en"),
                      })}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground/70">{t("common.noMilestone")}</p>
              )}
            </div>

            <div>
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("pullRequests.branches")}
              </h4>
              <div className="rounded-lg border border-border bg-muted/20 p-2.5 text-xs space-y-1.5">
                <div className="flex items-center justify-between text-muted-foreground">
                  <span className="text-[10px] uppercase font-medium">{t("pullRequests.headBranch")}</span>
                  <span className="font-mono text-foreground font-semibold truncate max-w-[140px]" title={pull.head}>
                    {pull.head}
                  </span>
                </div>
                <div className="flex items-center justify-between text-muted-foreground">
                  <span className="text-[10px] uppercase font-medium">{t("pullRequests.baseBranch")}</span>
                  <span className="font-mono text-foreground font-semibold truncate max-w-[140px]" title={pull.base}>
                    {pull.base}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
