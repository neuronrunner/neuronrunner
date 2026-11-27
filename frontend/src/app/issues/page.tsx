"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  LuArrowRight,
  LuBot,
  LuCircleAlert,
  LuCircleCheck,
  LuCircleDot,
  LuDownload,
  LuExternalLink,
  LuLoaderCircle,
  LuMessageSquare,
  LuPlus,
  LuRefreshCw,
  LuSearch,
  LuX,
} from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { WorkspaceSidebarToggle } from "@/components/workspace-page-header";
import { RepositoryEmptyState, RepositoryLoading, RepositoryTimestamp } from "@/components/git/repository-ui";
import { RepositoryPicker } from "@/components/git/repository-picker";
import { CreateIssueDialog } from "@/components/issues/create-issue-dialog";
import { ImportIssuesDialog } from "@/components/issues/import-issues-dialog";
import { IssueDetail } from "@/components/issues/issue-detail";
import { IssueLabelChip, IssuePriorityMark, repositoryWebUrl, STATUS_STYLE } from "@/components/issues/issue-ui";
import { useLoadMoreOnScroll } from "@/hooks/use-load-more-on-scroll";
import { issuesError, listIssues, type Issue, type IssueCounts, type IssueStateFilter } from "@/lib/issues-api";
import { readListCache, writeListCache } from "@/lib/list-cache";
import { useCloseRightPanelOnMount } from "@/hooks/use-close-right-panel";
import useSandboxProjectsStore from "@/stores/sandbox-projects";
import { cn } from "@/lib/utils";

interface IssuesCache {
  issues: Issue[];
  hasNext: boolean;
}
const issuesCacheKey = (environmentId: string | null, filter: string, query: string) =>
  environmentId ? `issues:${environmentId}:${filter}:${query}` : null;
const countsCacheKey = (environmentId: string | null) => (environmentId ? `issues-counts:${environmentId}` : null);

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;

export default function IssuesPage() {
  const { t } = useTranslation("git");
  useCloseRightPanelOnMount();
  const sandboxes = useSandboxProjectsStore((state) => state.sandboxes);
  const currentSandbox = useSandboxProjectsStore((state) => state.currentSandbox);

  const [searchParams, setSearchParams] = useSearchParams();
  const filter: IssueStateFilter = searchParams.get("state") === "closed" ? "closed" : "open";
  const parsedIssue = Number.parseInt(searchParams.get("issue") || "", 10);
  const selectedNumber = Number.isFinite(parsedIssue) && parsedIssue > 0 ? parsedIssue : null;
  const urlEnvironment = searchParams.get("env");

  // Issues are scoped to a repo-backed environment; the hidden files-root row is not one.
  const environments = useMemo(() => sandboxes.filter((sandbox) => sandbox.filesystem_path !== "/workspace"), [sandboxes]);
  const environment = useMemo(
    () =>
      environments.find((item) => item.uuid === urlEnvironment) ||
      environments.find((item) => item.uuid === currentSandbox?.uuid) ||
      environments[0] ||
      null,
    [environments, urlEnvironment, currentSandbox?.uuid]
  );
  const environmentId = environment?.uuid ?? null;

  // Seed from the last result for this view so coming back to the page paints at once (refreshing behind it).
  const initialKey = issuesCacheKey(environmentId, filter, "");
  const initialCache = readListCache<IssuesCache>(initialKey);
  const [issues, setIssues] = useState<Issue[]>(initialCache?.issues ?? []);
  const [hasNext, setHasNext] = useState(initialCache?.hasNext ?? false);
  const [counts, setCounts] = useState<IssueCounts | null>(readListCache<IssueCounts>(countsCacheKey(environmentId)) ?? null);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [dataLoaded, setDataLoaded] = useState(Boolean(initialCache));
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const loadMoreRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewKeyRef = useRef<string | null>(initialKey);
  const generationRef = useRef(0);
  const loadMoreInFlight = useRef(false);

  const updateParams = useCallback(
    (mutate: (params: URLSearchParams) => void, replace = false) => {
      const next = new URLSearchParams(searchParams);
      mutate(next);
      setSearchParams(next, { replace });
    },
    [searchParams, setSearchParams]
  );

  const selectIssue = (number: number | null) =>
    updateParams((params) => {
      if (number) params.set("issue", String(number));
      else params.delete("issue");
    });

  const changeFilter = (next: IssueStateFilter) => {
    setQuery("");
    updateParams((params) => {
      params.set("state", next);
      params.delete("issue");
    });
  };

  const changeEnvironment = (uuid: string) => {
    setQuery("");
    updateParams((params) => {
      params.set("env", uuid);
      params.delete("issue");
    });
  };

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  // First page (also reruns on environment, filter, search or manual refresh).
  useEffect(() => {
    if (!environmentId) {
      viewKeyRef.current = null;
      setIssues([]);
      setDataLoaded(false);
      return;
    }
    // Entering another view (page, environment, tab or search): show its last result right away and refresh
    // behind it; with nothing cached, drop the previous view's rows so they never sit under the wrong tab.
    const cacheKey = issuesCacheKey(environmentId, filter, debouncedQuery);
    if (viewKeyRef.current !== cacheKey) {
      viewKeyRef.current = cacheKey;
      const cached = readListCache<IssuesCache>(cacheKey);
      setIssues(cached?.issues ?? []);
      setHasNext(cached?.hasNext ?? false);
      setDataLoaded(Boolean(cached));
      setCounts((current) => readListCache<IssueCounts>(countsCacheKey(environmentId)) ?? (cached ? current : null));
    }
    generationRef.current += 1;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setLoadMoreError(null);
    listIssues(environmentId, { state: filter, q: debouncedQuery, page: 1, per_page: PAGE_SIZE }, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setIssues(response.issues);
        setHasNext(response.has_next);
        setPage(1);
        setDataLoaded(true);
        writeListCache<IssuesCache>(cacheKey, { issues: response.issues, hasNext: response.has_next });
        if (response.counts) {
          setCounts(response.counts);
          writeListCache<IssueCounts>(countsCacheKey(environmentId), response.counts);
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(issuesError(err, t("issues.loadErrorTitle")));
        setDataLoaded(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [environmentId, filter, debouncedQuery, revision, t]);

  const loadMore = useCallback(async () => {
    if (!environmentId || loadMoreInFlight.current || !hasNext) return;
    const generation = generationRef.current;
    loadMoreInFlight.current = true;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const response = await listIssues(environmentId, {
        state: filter,
        q: debouncedQuery,
        page: page + 1,
        per_page: PAGE_SIZE,
      });
      if (generationRef.current !== generation) return; // the list was reloaded or switched meanwhile
      setIssues((prev) => {
        const seen = new Set(prev.map((issue) => issue.number));
        return [...prev, ...response.issues.filter((issue) => !seen.has(issue.number))];
      });
      setHasNext(response.has_next);
      setPage((value) => value + 1);
    } catch (err) {
      if (generationRef.current !== generation) return;
      setLoadMoreError(issuesError(err, t("issues.loadErrorTitle")));
    } finally {
      loadMoreInFlight.current = false;
      setLoadingMore(false);
    }
  }, [environmentId, hasNext, filter, debouncedQuery, page, t]);

  useLoadMoreOnScroll({
    enabled: hasNext && !loading && !loadingMore && !loadMoreError,
    onLoadMore: loadMore,
    rootRef: scrollRef,
    sentinelRef: loadMoreRef,
    itemCount: issues.length,
  });

  // Reuse the repository picker's look: one entry per environment, keyed by its folder.
  const pickerRepositories = useMemo(
    () =>
      environments.map((item) => ({
        path: item.filesystem_path,
        name: item.display_name || item.slug,
        github_repository: item.repo_full_name || null,
        remote_url: item.repo_url || null,
      })),
    [environments]
  );
  const changeEnvironmentByPath = (path: string) => {
    const next = environments.find((item) => item.filesystem_path === path);
    if (next) changeEnvironment(next.uuid);
  };
  const repoWebUrl = repositoryWebUrl(environment?.repo_url);
  const isGitlabRepo = Boolean(repoWebUrl && !/^https:\/\/github\.com\//i.test(repoWebUrl));

  const refresh = () => setRevision((value) => value + 1);
  const environmentName = environment ? environment.display_name || environment.slug : "";
  const hasQuery = Boolean(debouncedQuery.trim());

  return (
    <main className="workspace-page relative flex h-full min-h-0 min-w-0 flex-col bg-background">
      <WorkspaceSidebarToggle label={t("common.openSidebar")} />

      <div ref={scrollRef} className="workspace-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-5xl space-y-6 px-4 pb-6 pt-14 sm:px-8 sm:pb-9">
          <div className="workspace-page-enter flex items-start justify-between gap-4">
            <div>
              <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                {t("issues.eyebrow")}
              </p>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t("issues.title")}</h1>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{t("issues.subtitle")}</p>
            </div>
            <div className="mt-1 flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={loading || !environmentId}
                onClick={refresh}
                aria-label={t("issues.refreshAriaLabel")}
                className="rounded-lg"
              >
                <LuRefreshCw className={cn(loading && "animate-spin")} />
                <span className="hidden sm:inline">{t("common.refresh")}</span>
              </Button>
              <Button size="sm" disabled={!environmentId} onClick={() => setCreateOpen(true)} className="rounded-lg">
                <LuPlus />
                <span className="hidden sm:inline">{t("issues.new")}</span>
              </Button>
            </div>
          </div>

          {!environment ? (
            <RepositoryEmptyState title={t("issues.noEnvironmentsTitle")} description={t("issues.noEnvironmentsDesc")} />
          ) : (
            <>
              <div
                className="workspace-page-enter flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3 sm:p-4"
                style={{ animationDelay: "90ms" }}
              >
                <div className="min-w-0 flex-1 sm:max-w-sm">
                  <RepositoryPicker repositories={pickerRepositories} value={environment.filesystem_path} onChange={changeEnvironmentByPath} />
                </div>
                {repoWebUrl && (
                  <a
                    href={repoWebUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label={isGitlabRepo ? t("issues.viewOnGitlab") : t("issues.viewOnGithubAriaLabel")}
                  >
                    <span className="hidden sm:inline">{isGitlabRepo ? t("issues.viewOnGitlab") : t("common.viewOnGithub")}</span>
                    <LuExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                <button
                  type="button"
                  disabled={!environment.repo_url && !environment.repo_full_name}
                  onClick={() => setImportOpen(true)}
                  title={!environment.repo_url && !environment.repo_full_name ? t("issues.importNoRepo") : undefined}
                  className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  <LuDownload className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{t("issues.import")}</span>
                </button>
              </div>

              {error && (
                <div role="alert" className="flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/5 p-4">
                  <LuCircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{t("issues.loadErrorTitle")}</p>
                    <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">{error}</p>
                    <Button variant="outline" size="sm" disabled={loading} className="mt-3" onClick={refresh}>
                      {t("common.tryAgain")}
                    </Button>
                  </div>
                </div>
              )}

              {selectedNumber !== null ? (
                <IssueDetail
                  key={`${environment.uuid}:${selectedNumber}`}
                  environment={environment}
                  number={selectedNumber}
                  initialIssue={issues.find((issue) => issue.number === selectedNumber) ?? null}
                  onBack={() => selectIssue(null)}
                  onChanged={refresh}
                  onDeleted={() => {
                    selectIssue(null);
                    refresh();
                  }}
                />
              ) : (
                <>
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
                            onClick={() => changeFilter(state)}
                            className={cn(
                              "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors",
                              filter === state ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                            )}
                          >
                            {state === "open" ? (
                              <LuCircleDot
                                aria-hidden
                                className={cn("h-3.5 w-3.5", filter === state && "text-emerald-600 dark:text-emerald-400")}
                              />
                            ) : (
                              <LuCircleCheck
                                aria-hidden
                                className={cn("h-3.5 w-3.5", filter === state && "text-violet-600 dark:text-violet-400")}
                              />
                            )}
                            {state === "open" ? t("status.open") : t("status.closed")}
                            {counts && (
                              <span className="rounded-full bg-muted-foreground/15 px-1.5 py-px text-[10px] font-semibold tabular-nums text-muted-foreground">
                                {counts[state]}
                              </span>
                            )}
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
                        {hasQuery
                          ? t("common.matchingCount", { count: issues.length })
                          : `${
                              filter === "open"
                                ? issues.length === 1
                                  ? t("issues.countOpenOne", { count: issues.length })
                                  : t("issues.countOpenOther", { count: issues.length })
                                : issues.length === 1
                                  ? t("issues.countClosedOne", { count: issues.length })
                                  : t("issues.countClosedOther", { count: issues.length })
                            }${hasNext ? t("common.scrollForMoreSuffix") : ""}`}
                      </p>
                    )}
                  </div>

                  {loading && issues.length === 0 ? (
                    <RepositoryLoading label={t("issues.loading")} />
                  ) : !error && dataLoaded ? (
                    <div className="workspace-page-enter" style={{ animationDelay: "170ms" }}>
                      {issues.length === 0 ? (
                        <RepositoryEmptyState
                          title={hasQuery ? t("issues.noMatchingTitle") : filter === "open" ? t("issues.noOpenTitle") : t("issues.noClosedTitle")}
                          description={
                            hasQuery
                              ? t("issues.noMatchingDesc")
                              : filter === "open"
                                ? t("issues.noOpenDesc")
                                : t("issues.noClosedDesc")
                          }
                        >
                          {hasQuery ? (
                            <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                              {t("common.clearSearch")}
                            </Button>
                          ) : (
                            filter === "open" && (
                              <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                                <LuPlus />
                                {t("issues.new")}
                              </Button>
                            )
                          )}
                        </RepositoryEmptyState>
                      ) : (
                        <ul className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border bg-card shadow-xs">
                          {issues.map((issue) => {
                            const { icon: StatusIcon, tile } = STATUS_STYLE[issue.status];
                            return (
                              <li key={issue.id}>
                                <button
                                  type="button"
                                  onClick={() => selectIssue(issue.number)}
                                  className="group relative flex w-full min-w-0 items-start gap-3 px-4 py-4 text-left transition-colors before:absolute before:inset-y-3 before:left-0 before:w-0.5 before:rounded-full before:bg-indigo-500 before:opacity-0 before:transition-opacity hover:bg-muted/40 hover:before:opacity-100 focus-visible:bg-muted/40 focus-visible:before:opacity-100 focus-visible:outline-offset-[-2px] sm:gap-4 sm:px-5"
                                >
                                  <span className={cn("mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", tile)}>
                                    <StatusIcon aria-hidden className="h-4 w-4" />
                                  </span>
                                  <span className="min-w-0 flex-1">
                                    <span className="line-clamp-2 break-words text-sm font-semibold leading-6 transition-colors group-hover:text-primary">
                                      {issue.title}
                                    </span>
                                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                                      <span className="font-mono font-medium">#{issue.number}</span>
                                      <span className="break-all">
                                        {t("common.byAuthor", { author: issue.creator.name || t("common.unknownAuthor") })}
                                      </span>
                                      <span className="text-muted-foreground/50" aria-hidden>
                                        ·
                                      </span>
                                      <RepositoryTimestamp value={issue.updated_at} prefix={t("timestamps.updatedPrefix")} />
                                      {issue.priority !== "none" && <IssuePriorityMark priority={issue.priority} />}
                                    </span>
                                    {issue.labels.length > 0 && (
                                      <span className="mt-2.5 flex flex-wrap gap-1.5">
                                        {issue.labels.map((label) => (
                                          <IssueLabelChip key={label.name} label={label} size="xs" />
                                        ))}
                                      </span>
                                    )}
                                  </span>
                                  <div className="flex shrink-0 items-center gap-3 pt-1">
                                    {issue.assigned_to_agent && (
                                      <span
                                        className="inline-flex items-center gap-1 rounded-full bg-indigo-500/10 px-2 py-0.5 text-[10px] font-medium text-indigo-600 dark:text-indigo-400"
                                        title={t("issues.agentAssigned")}
                                      >
                                        {issue.status === "in_progress" ? (
                                          <LuLoaderCircle aria-hidden className="h-3 w-3 animate-spin" />
                                        ) : (
                                          <LuBot aria-hidden className="h-3 w-3" />
                                        )}
                                        <span className="hidden sm:inline">{t("issues.agent")}</span>
                                      </span>
                                    )}
                                    {issue.comments > 0 && (
                                      <span
                                        className="hidden shrink-0 items-center gap-1 text-[11px] text-muted-foreground sm:inline-flex"
                                        title={t("common.commentsCount", { count: issue.comments })}
                                      >
                                        <LuMessageSquare className="h-3.5 w-3.5" />
                                        <span>{issue.comments}</span>
                                      </span>
                                    )}
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

                      {hasNext && (
                        <div
                          ref={loadMoreRef}
                          className="flex min-h-12 items-center justify-center gap-2 border-t border-border/40 py-4 text-xs text-muted-foreground"
                        >
                          {loadMoreError ? (
                            <div role="alert" className="text-center">
                              <p className="text-xs text-destructive">{loadMoreError}</p>
                              <Button variant="outline" size="sm" onClick={() => void loadMore()} className="mt-2 text-xs">
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
                      {!hasNext && issues.length > 5 && (
                        <p className="py-4 text-center text-xs text-muted-foreground/60">
                          {filter === "open" ? t("issues.allOpenLoaded") : t("issues.allClosedLoaded")}
                        </p>
                      )}
                    </div>
                  ) : null}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {environment && (
        <>
          <CreateIssueDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            environmentId={environment.uuid}
            environmentName={environmentName}
            onCreated={(issue) => {
              refresh();
              selectIssue(issue.number);
            }}
          />
          <ImportIssuesDialog
            open={importOpen}
            onOpenChange={setImportOpen}
            environmentId={environment.uuid}
            environmentName={environmentName}
            repoUrl={environment.repo_url}
            repoName={environment.repo_full_name}
            onImported={refresh}
          />
        </>
      )}
    </main>
  );
}
