"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuArrowDown, LuArrowUp, LuCheck, LuChevronDown, LuChevronRight, LuCircleAlert, LuCopy, LuExternalLink, LuFileCode2, LuFolderGit2, LuFolderOpen, LuGitBranch, LuGitCommitHorizontal, LuGitPullRequest, LuHistory, LuLoaderCircle, LuMinus, LuPlus, LuRefreshCw, LuSearch, LuX } from "react-icons/lu";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RepositoryPicker } from "@/components/git/repository-picker";
import { FileDiff } from "@/components/git/file-diff";
import { RepositoryLoading, RepositoryTimestamp } from "@/components/git/repository-ui";
import { useWorkspaceRepositories } from "@/hooks/use-workspace-repositories";
import { repositoryError, repositoryUnavailable, repositoryMutation, repositoryRequest, type RepositoryChange, type RepositoryHistory, type RepositoryStatus } from "@/lib/repository-api";
import useSandboxProjectsStore from "@/stores/sandbox-projects";
import useWorkspaceTabsStore from "@/stores/workspace-tabs";
import { useRepositoryChanges } from "@/hooks/use-repository-status";
import { cn } from "@/lib/utils";

const statusCode = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U", conflict: "!" };
const statusStyles = {
  modified: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  added: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  deleted: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
  renamed: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  untracked: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  conflict: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
};
const iconButton = "workspace-tool-icon-button";
type Operation = "commit" | "switch" | "stage" | "unstage";
type StatusResult = { context: string; status: RepositoryStatus };

function updatedStatus(previous: StatusResult | null, context: string, status: RepositoryStatus): StatusResult {
  if (previous?.context === context && previous.status.head_commit === status.head_commit && previous.status.history.length > status.history.length) {
    return { context, status: { ...status, history: previous.status.history, history_has_next: previous.status.history_has_next, history_next_offset: previous.status.history_next_offset, total_commits: status.total_commits ?? previous.status.total_commits } };
  }
  return { context, status };
}

function GitWelcome({ hasProject }: { hasProject: boolean }) {
  const { t } = useTranslation("workspace");
  return <div className="workspace-tool-empty">
    <div aria-hidden className="workspace-tool-empty-icon"><LuGitBranch className="h-5 w-5" /></div>
    <h2 className="workspace-tool-empty-title">{t("gitView.welcome.title")}</h2>
    <p className="workspace-tool-empty-description">{hasProject ? t("gitView.welcome.withProject") : t("gitView.welcome.withoutProject")}</p>
    <Button variant="outline" size="sm" className="mt-5 h-8 gap-2 rounded-md text-xs shadow-none" onClick={() => useWorkspaceTabsStore.getState().openFilesTab()}><LuFolderOpen className="h-3.5 w-3.5" />{t("common.openFiles")}</Button>
    <div className="mt-6 flex flex-wrap justify-center gap-x-4 gap-y-2 text-[10px] text-muted-foreground"><span className="flex items-center gap-1.5"><LuFileCode2 className="h-3 w-3" />{t("gitView.welcome.reviewDiffs")}</span><span className="flex items-center gap-1.5"><LuGitBranch className="h-3 w-3" />{t("gitView.welcome.manageBranches")}</span><span className="flex items-center gap-1.5"><LuHistory className="h-3 w-3" />{t("gitView.welcome.trackHistory")}</span></div>
  </div>;
}

export function GitTabView() {
  const { t } = useTranslation("workspace");
  const browser = useWorkspaceRepositories();
  const project = useSandboxProjectsStore(state => state.currentSandbox);
  const files = useSandboxProjectsStore(state => state.files);
  const removeRepository = browser.removeRepository;
  const [result, setResult] = useState<StatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<Operation | null>(null);
  const [notice, setNotice] = useState("");
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"changes" | "history">("changes");
  const [copied, setCopied] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const scrollContainer = useRef<HTMLDivElement>(null);
  const historyEnd = useRef<HTMLDivElement>(null);
  const path = browser.repository?.path;
  const contextKey = `${browser.uuid}:${path}`;
  const repositoryRevision = useRepositoryChanges(state => state.revisions[contextKey] || 0);
  const currentContext = useRef(contextKey);
  const mutationPending = useRef(false);
  const id = useId();
  currentContext.current = contextKey;

  useEffect(() => {
    setMessage(""); setNotice(""); setError(null); setBusy(null); setBranchesOpen(false); setBranchQuery(""); setQuery(""); setOpenFile(null); setCopied("");
  }, [contextKey]);
  useEffect(() => {
    if (!browser.uuid || !path || busy) return;
    const controller = new AbortController();
    setLoading(true);
    repositoryRequest<RepositoryStatus>(browser.uuid, "git/repository", { path }, controller.signal)
      .then(status => { if (!controller.signal.aborted) setResult(previous => updatedStatus(previous, contextKey, status)); })
      .catch(cause => {
        if (controller.signal.aborted) return;
        if (repositoryUnavailable(cause)) removeRepository(path);
        else setError(repositoryError(cause));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [browser.uuid, path, contextKey, revision, repositoryRevision, files, removeRepository, busy]);

  const ready = result?.context === contextKey && result.status.path === path ? result.status : null;
  const historyHead = ready?.head_commit;
  const historyHasNext = ready?.history_has_next;
  const historyOffset = ready?.history_next_offset;
  useEffect(() => { setHistoryError(null); }, [contextKey, historyHead]);
  useEffect(() => {
    if (view !== "history" || !browser.uuid || !path || !historyHead || !historyHasNext || historyOffset == null || loading || busy || historyError || !historyEnd.current) return;
    const controller = new AbortController();
    let pending = false;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting) || pending) return;
      pending = true;
      setHistoryLoading(true);
      repositoryRequest<RepositoryHistory>(browser.uuid!, "git/history", { path, head: historyHead, offset: historyOffset }, controller.signal)
        .then(page => {
          if (controller.signal.aborted) return;
          setResult(previous => {
            if (previous?.context !== contextKey || previous.status.head_commit !== page.head_commit) return previous;
            const hashes = new Set(previous.status.history.map(commit => commit.hash));
            return { ...previous, status: { ...previous.status, history: [...previous.status.history, ...page.history.filter(commit => !hashes.has(commit.hash))], history_has_next: page.has_next, history_next_offset: page.next_offset, total_commits: page.total_commits ?? previous.status.total_commits } };
          });
        })
        .catch(cause => {
          if (controller.signal.aborted) return;
          if (repositoryUnavailable(cause)) removeRepository(path);
          else setHistoryError(repositoryError(cause));
        })
        .finally(() => { if (!controller.signal.aborted) setHistoryLoading(false); });
    }, { root: scrollContainer.current, rootMargin: "160px" });
    observer.observe(historyEnd.current);
    return () => { observer.disconnect(); controller.abort(); setHistoryLoading(false); };
  }, [browser.uuid, path, contextKey, historyHead, historyHasNext, historyOffset, view, loading, busy, historyError, removeRepository]);
  const stagedFiles = (ready?.files || []).filter(file => file.staged);
  const unstagedFiles = (ready?.files || []).filter(file => file.worktree_status !== " " || file.status === "conflict");
  const conflictCount = ready?.files.filter(file => file.status === "conflict").length || 0;
  const mutate = async (operation: Operation, values: Record<string, unknown>) => {
    if (!browser.uuid || !path || !ready || mutationPending.current) return;
    if (operation === "commit" && (!message.trim() || !ready.files.length || conflictCount)) return;
    const key = contextKey;
    mutationPending.current = true;
    setBusy(operation); setError(null); setNotice("");
    try {
      const status = await repositoryMutation<RepositoryStatus>(browser.uuid, `git/${operation}`, { path, ...values });
      useRepositoryChanges.getState().changed(key);
      if (currentContext.current !== key) return;
      setResult(previous => updatedStatus(previous, key, status));
      if (operation === "commit") { setMessage(""); setOpenFile(null); setNotice(t("gitView.notices.committed", { hash: status.head_commit.slice(0, 7) })); }
      else if (operation === "switch") { setOpenFile(null); setBranchesOpen(false); setBranchQuery(""); setNotice(t("gitView.notices.switchedTo", { branch: status.branch })); void useSandboxProjectsStore.getState().fetchFiles(browser.uuid); }
      else setNotice(operation === "stage" ? t("gitView.notices.staged") : t("gitView.notices.unstaged"));
    } catch (cause) {
      if (currentContext.current !== key) return;
      if (repositoryUnavailable(cause)) { setResult(null); setOpenFile(null); removeRepository(path); }
      else setError(repositoryError(cause));
    } finally {
      mutationPending.current = false;
      if (currentContext.current === key) setBusy(null);
    }
  };
  const refreshing = browser.isLoading || loading;
  const refresh = () => { setError(null); browser.refresh(); setRevision(value => value + 1); };
  const copy = async (value: string) => {
    const context = contextKey;
    try { await navigator.clipboard.writeText(value); if (currentContext.current === context) setCopied(value); }
    catch { if (currentContext.current === context) setError(t("gitView.errors.copyFailed")); }
  };
  const branches = ready?.branches || [];
  const filteredBranches = branches.filter(branch => branch.name.toLowerCase().includes(branchQuery.trim().toLowerCase()));
  const term = query.trim().toLowerCase();
  const history = (ready?.history || []).filter(commit => `${commit.subject} ${commit.author} ${commit.hash}`.toLowerCase().includes(term));

  const renderChanges = (groupFiles: RepositoryChange[], staged: boolean) => {
    if (!groupFiles.length) return null;
    const filtered = groupFiles.filter(file => `${file.path} ${file.previous_path || ""}`.toLowerCase().includes(term));
    const mode = staged ? "staged" : "unstaged";
    return <section aria-label={staged ? t("gitView.stagedChanges") : t("gitView.unstagedChanges")} className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm shadow-black/[0.02]">
      <div className="flex items-center gap-2 border-b border-border/50 bg-muted/20 px-3 py-2">
        <span className={cn("h-1.5 w-1.5 rounded-full", staged ? "bg-emerald-500" : "bg-amber-500")} />
        <h3 className="min-w-0 flex-1 text-[11px] font-semibold">{staged ? t("gitView.stagedChanges") : t("gitView.changes")}<span className="ml-2 font-mono text-[10px] font-normal text-muted-foreground">{groupFiles.length}</span></h3>
        <button type="button" disabled={!!busy || refreshing} onClick={() => void mutate(staged ? "unstage" : "stage", { all: true })} title={staged ? t("gitView.unstageAllTitle") : t("gitView.stageAllTitle")} className="inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40">{staged ? <LuMinus className="h-3 w-3" /> : <LuPlus className="h-3 w-3" />}{staged ? t("gitView.unstageAll") : t("gitView.stageAll")}</button>
      </div>
      <ul className="divide-y divide-border/40">{filtered.map((file, index) => {
        const key = `${mode}:${file.path}`;
        const codes: Record<string, RepositoryChange["status"]> = { M: "modified", T: "modified", A: "added", C: "added", D: "deleted", R: "renamed", "?": "untracked" };
        const status = file.status === "conflict" ? "conflict" : codes[staged ? file.index_status : file.worktree_status] || file.status;
        const localizedStatus = t(`gitView.status.${status}`);
        return <li key={file.path}>
          <div className={cn("group flex min-w-0 items-center gap-0.5 pr-2 transition-colors hover:bg-muted/35", openFile === key && "bg-muted/35")}>
            <button type="button" onClick={() => setOpenFile(openFile === key ? null : key)} aria-expanded={openFile === key} aria-controls={`${id}-${mode}-diff-${index}`} className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2.5 text-left text-xs">
              <LuChevronRight aria-hidden className={cn("h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform", openFile === key && "rotate-90")} />
              <LuFileCode2 aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1" title={file.previous_path ? `${file.previous_path} → ${file.path}` : file.path}><span className="block truncate text-[11px] font-medium">{file.path.split("/").pop()}</span><span className="mt-0.5 block truncate font-mono text-[9px] text-muted-foreground">{file.previous_path ? `${file.previous_path} → ${file.path}` : file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : t("gitView.repositoryRoot")}</span></span>
              <span aria-label={localizedStatus} title={localizedStatus} className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-[10px] font-medium", statusStyles[status])}>{statusCode[status]}</span>
            </button>
            {status !== "deleted" && file.worktree_status !== "D" && <button type="button" aria-label={t("gitView.openInEditorAria", { path: file.path })} title={t("gitView.openInEditor")} onClick={() => useWorkspaceTabsStore.getState().openFileTab({ uuid: `${path}/${file.path}`, path: `${path}/${file.path}` })} className={cn(iconButton, "h-6 w-6")}><LuExternalLink className="h-3 w-3" /></button>}
            <button type="button" disabled={!!busy || refreshing} aria-label={staged ? t("gitView.unstageFileAria", { path: file.path }) : t("gitView.stageFileAria", { path: file.path })} title={staged ? t("gitView.unstageFile") : t("gitView.stageFile")} onClick={() => void mutate(staged ? "unstage" : "stage", { files: [file.path] })} className={cn(iconButton, "h-6 w-6", staged ? "hover:bg-amber-500/10 hover:text-amber-600 dark:hover:text-amber-400" : "hover:bg-emerald-500/10 hover:text-emerald-600 dark:hover:text-emerald-400")}>{staged ? <LuMinus className="h-3.5 w-3.5" /> : <LuPlus className="h-3.5 w-3.5" />}</button>
          </div>
          <div id={`${id}-${mode}-diff-${index}`} hidden={openFile !== key}>{openFile === key && browser.uuid && <FileDiff uuid={browser.uuid} path={path!} file={file.path} mode={mode} revision={revision + repositoryRevision} onRepositoryUnavailable={removeRepository} />}</div>
        </li>;
      })}</ul>
      {!filtered.length && <p className="px-4 py-5 text-center text-xs text-muted-foreground">{t("gitView.noMatchingFiles")}</p>}
    </section>;
  };

  return <section aria-label={t("gitView.ariaLabel")} className="flex h-full min-h-0 min-w-0 flex-col bg-background">
    <header className="workspace-tool-header">
      <div className="workspace-tool-toolbar">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground"><LuGitBranch className="h-3.5 w-3.5" /></span>
        <div className="min-w-0 flex-1">{browser.repositories.length > 1 ? <RepositoryPicker repositories={browser.repositories} value={path} onChange={browser.selectRepository} className="workspace-tool-field w-full justify-between py-0 text-[11px]" /> : <div className="workspace-tool-field"><LuFolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span className="truncate font-mono text-[11px]" title={path}>{browser.repository?.github_repository || browser.repository?.name || t("gitView.sourceControl")}</span></div>}</div>
        {browser.repository?.github_repository && <a href={`https://github.com/${browser.repository.github_repository}`} target="_blank" rel="noopener noreferrer" aria-label={t("gitView.viewOnGithub")} title={t("gitView.viewOnGithub")} className={iconButton}><LuExternalLink className="h-3.5 w-3.5" /></a>}
        <button type="button" title={t("gitView.refreshGit")} aria-label={t("gitView.refreshGit")} onClick={refresh} disabled={refreshing || !!busy} className={iconButton}><LuRefreshCw className={cn("h-3.5 w-3.5", refreshing && "motion-safe:animate-spin")} /></button>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-2 pb-1.5">
        <Popover open={branchesOpen} onOpenChange={setBranchesOpen}>
          <PopoverTrigger asChild><button type="button" aria-label={t("gitView.chooseBranch")} disabled={!ready || !!busy || refreshing} className="inline-flex h-5 min-w-0 max-w-[45%] items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"><LuGitBranch className="h-3 w-3 shrink-0" /><span className="truncate font-mono">{ready?.branch || t("gitView.noBranch")}</span><LuChevronDown className="h-3 w-3 shrink-0" /></button></PopoverTrigger>
          <PopoverContent align="start" className="w-72 max-w-[calc(100vw-2rem)] rounded-xl p-2">
            <div className="relative mb-2"><LuSearch aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><input aria-label={t("gitView.findOrCreateBranchAria")} placeholder={t("gitView.findOrCreateBranchPlaceholder")} value={branchQuery} onChange={event => setBranchQuery(event.target.value)} className="h-8 w-full rounded-lg border border-border bg-background pl-8 pr-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div>
            <div className="max-h-56 overflow-y-auto">{filteredBranches.map(branch => <button key={`${branch.remote}:${branch.name}`} type="button" disabled={!!busy || !branch.remote && branch.name === ready?.branch} onClick={() => void mutate("switch", { branch: branch.name })} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs hover:bg-muted disabled:opacity-60"><LuGitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate font-mono">{branch.name}</span>{branch.remote && <span className="text-[10px] text-muted-foreground">{t("gitView.remote")}</span>}{!branch.remote && branch.name === ready?.branch && <LuCheck aria-label={t("gitView.currentBranch")} className="h-3.5 w-3.5 text-emerald-500" />}</button>)}{!filteredBranches.length && <p className="px-2.5 py-3 text-xs text-muted-foreground">{t("gitView.noMatchingBranches")}</p>}</div>
            {branchQuery.trim() && !branches.some(branch => branch.name === branchQuery.trim()) && <button type="button" disabled={!!busy} onClick={() => void mutate("switch", { branch: branchQuery.trim(), create: true })} className="mt-1 flex w-full items-center gap-2 rounded-md border-t border-border px-2.5 py-2 text-left text-xs hover:bg-muted disabled:opacity-50"><LuPlus className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{t("gitView.createBranch", { name: branchQuery.trim() })}</span></button>}
          </PopoverContent>
        </Popover>
        <span aria-hidden className="h-3 w-px bg-border" />
        <nav aria-label={t("gitView.viewsAria")} className="flex min-w-0 items-center gap-1">{(["changes", "history"] as const).map(item => <button key={item} type="button" aria-pressed={view === item} onClick={() => { setView(item); setQuery(""); }} className={cn("inline-flex h-5 items-center gap-1 rounded px-1.5 text-[10px] transition-colors", view === item ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>{item === "changes" ? <LuFileCode2 className="h-3 w-3" /> : <LuHistory className="h-3 w-3" />}{item === "changes" ? t("gitView.changes") : t("gitView.history")}<span className="font-mono text-[9px] opacity-60">{item === "changes" ? ready?.files.length || 0 : (ready?.total_commits ?? ready?.history.length ?? 0)}</span></button>)}</nav>
        <Link to="/pull-requests" title={t("tabContainer.pullRequests")} aria-label={t("gitView.viewPullRequests")} className="ml-auto inline-flex h-5 shrink-0 items-center justify-center rounded px-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"><LuGitPullRequest className="h-3.5 w-3.5" /></Link>
      </div>
      {(refreshing || busy) && <span role="status" className="sr-only">{busy ? t("gitView.updatingRepo") : t("gitView.refreshingRepo")}</span>}
    </header>

    <div ref={scrollContainer} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-busy={refreshing || !!busy || historyLoading}>
      {(browser.error || error) && <div role="alert" className="relative m-3 flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs"><LuCircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" /><div className="min-w-0 flex-1"><p className="break-words leading-relaxed">{browser.error || error}</p><button type="button" disabled={refreshing || !!busy} onClick={refresh} className="mt-2 font-medium underline underline-offset-2 disabled:opacity-50">{t("common.tryAgain")}</button></div><button type="button" aria-label={t("browserView.dismissError")} onClick={() => { setError(null); if (browser.error) browser.refresh(); }} className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10"><LuX className="h-3.5 w-3.5" /></button></div>}
      {notice && <p role="status" className="relative mx-3 mt-3 flex items-start gap-2 rounded-lg bg-emerald-500/5 px-3 py-2 text-[11px] text-emerald-700 dark:text-emerald-400"><LuCheck className="mt-0.5 h-3 w-3 shrink-0" /><span className="min-w-0 flex-1 break-words">{notice}</span><button type="button" aria-label={t("gitView.dismissNotification")} onClick={() => setNotice("")} className="rounded p-0.5 hover:bg-emerald-500/10"><LuX className="h-3 w-3" /></button></p>}
      {!ready && refreshing ? <div className="p-3"><RepositoryLoading label={t("gitView.loadingRepo")} /></div> : !browser.repositories.length && !browser.error ? <GitWelcome hasProject={!!project} /> : ready && <div className="relative mx-auto w-full max-w-3xl space-y-3 p-3">
        {view === "changes" && conflictCount > 0 && <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-500/20 bg-rose-500/5 p-3 text-[11px] text-rose-700 dark:text-rose-400"><LuCircleAlert className="h-4 w-4 shrink-0" /><p><span className="font-semibold">{t("gitView.mergeConflicts", { count: conflictCount })}</span> {t("gitView.resolveConflictsHint")}</p></div>}
        {view === "changes" && ready.files.length > 0 && <form className="space-y-2.5 rounded-xl border border-border/60 bg-card p-3 shadow-sm shadow-black/[0.02]" onSubmit={event => { event.preventDefault(); void mutate("commit", { message: message.trim(), staged_only: stagedFiles.length > 0 }); }}>
          <label htmlFor={`${id}-message`} className="flex items-center gap-1.5 text-[11px] font-semibold"><LuGitCommitHorizontal className="h-3.5 w-3.5 text-muted-foreground" />{t("gitView.createCommit")}<span className="ml-auto truncate font-mono text-[10px] font-normal text-muted-foreground" title={ready.branch}>{ready.branch}</span></label>
          <textarea id={`${id}-message`} aria-label={t("gitView.commitMessageAria")} placeholder={t("gitView.commitMessagePlaceholder")} value={message} onChange={event => setMessage(event.target.value)} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} maxLength={2000} disabled={!!busy} rows={2} className="block min-h-16 w-full resize-y rounded-lg border border-border/60 bg-background px-2.5 py-2 text-xs leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50" />
          <Button type="submit" size="sm" className="h-8 w-full gap-2 rounded-lg text-[11px]" disabled={!!busy || refreshing || !message.trim() || !!conflictCount}>{busy === "commit" ? <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <LuGitCommitHorizontal className="h-3.5 w-3.5" />}{busy === "commit" ? t("gitView.committing") : stagedFiles.length ? t("gitView.commitStagedFiles", { count: stagedFiles.length }) : t("gitView.stageAllAndCommit")}</Button>
          <p className="text-[10px] leading-relaxed text-muted-foreground">{stagedFiles.length ? t("gitView.stagedCommitHint") : t("gitView.unstagedCommitHint")}<span className="ml-1.5 whitespace-nowrap opacity-60">Ctrl / ⌘ + Enter</span></p>
        </form>}
        {(view === "changes" ? ready.files.length > 0 : ready.history.length > 0) && <div className="relative"><LuSearch aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><input aria-label={view === "changes" ? t("gitView.filterFilesAria") : t("gitView.searchCommitsAria")} value={query} onChange={event => setQuery(event.target.value)} placeholder={view === "changes" ? t("gitView.filterFilesPlaceholder") : t("gitView.searchCommitsPlaceholder")} className="h-8 w-full rounded-lg border border-border/60 bg-card pl-8 pr-8 text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-ring" />{query && <button type="button" aria-label={t("projectDetail.chats.clearSearchAria")} onClick={() => setQuery("")} className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted"><LuX className="h-3 w-3" /></button>}</div>}
        {view === "changes" ? <>{renderChanges(stagedFiles, true)}{renderChanges(unstagedFiles, false)}{!ready.files.length && <div className="flex flex-col items-center rounded-xl border border-border/50 bg-card/50 px-5 py-10 text-center"><div className="relative mb-4"><div aria-hidden className="absolute -inset-3 rounded-full bg-emerald-500/10 blur-xl" /><span className="relative flex h-12 w-12 items-center justify-center rounded-2xl border border-emerald-500/15 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"><LuCheck className="h-6 w-6" /></span></div><h2 className="text-sm font-semibold">{t("gitView.allCommittedTitle")}</h2><p className="mt-2 max-w-xs text-[11px] leading-relaxed text-muted-foreground">{t("gitView.allCommittedDescription")}</p><button type="button" onClick={() => setView("history")} className="mt-4 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"><LuHistory className="h-3 w-3" />{t("gitView.viewCommitHistory")}<LuChevronRight className="h-3 w-3" /></button></div>}</> : <section aria-label={t("gitView.recentCommits")} className="overflow-hidden rounded-xl border border-border/60 bg-card">
          <div className="flex items-center gap-2 border-b border-border/50 bg-muted/20 px-3 py-2.5"><LuHistory className="h-3.5 w-3.5 text-muted-foreground" /><h3 className="flex-1 text-[11px] font-semibold">{t("gitView.recentCommits")}</h3><span className="text-[10px] text-muted-foreground">{ready.total_commits != null && ready.history_has_next ? t("gitView.commitsLoadedPartial", { loaded: ready.history.length, total: ready.total_commits }) : t("gitView.commitsLoaded", { loaded: ready.history.length })}</span></div>
          {!history.length ? <div className="px-4 py-10 text-center"><LuGitCommitHorizontal className="mx-auto mb-3 h-6 w-6 text-muted-foreground/50" /><p className="text-xs text-muted-foreground">{term ? t("gitView.noMatchingCommits") : t("gitView.firstCommitHint")}</p></div> : <ol className="px-3 py-1">{history.map(commit => <li key={commit.hash} className="relative flex min-w-0 items-start gap-2.5 py-3 after:absolute after:bottom-0 after:left-[6px] after:top-7 after:w-px after:bg-border/70 last:after:hidden"><LuGitCommitHorizontal className="relative z-10 mt-0.5 h-3.5 w-3.5 shrink-0 bg-card text-muted-foreground" /><div className="min-w-0 flex-1"><p className="truncate text-[11px] font-medium leading-5" title={commit.subject}>{commit.subject}</p><p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground"><span className="truncate">{commit.author}</span><span aria-hidden>·</span><RepositoryTimestamp value={commit.date} /></p><div className="mt-1.5 flex items-center gap-1.5"><button type="button" title={t("gitView.copyCommitHash")} aria-label={t("gitView.copyCommitHashAria", { hash: commit.hash.slice(0, 7) })} onClick={() => void copy(commit.hash)} className="inline-flex items-center gap-1.5 rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">{copied === commit.hash ? <LuCheck className="h-2.5 w-2.5 text-emerald-500" /> : <LuCopy className="h-2.5 w-2.5" />}{copied === commit.hash ? t("common.copied") : commit.hash.slice(0, 7)}</button>{browser.repository?.github_repository && <a href={`https://github.com/${browser.repository.github_repository}/commit/${commit.hash}`} target="_blank" rel="noopener noreferrer" title={t("gitView.viewCommitOnGithub")} aria-label={t("gitView.viewCommitOnGithubAria", { hash: commit.hash.slice(0, 7) })} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><LuExternalLink className="h-3 w-3" /></a>}</div></div></li>)}</ol>}
          {ready.history_has_next && <div ref={historyEnd} className="flex min-h-10 items-center justify-center gap-2 border-t border-border/40 px-3 py-2 text-[11px] text-muted-foreground">
            {historyError ? <div role="alert" className="text-center"><p>{historyError}</p><button type="button" onClick={() => setHistoryError(null)} className="mt-1 underline underline-offset-2">{t("gitView.retryLoadingCommits")}</button></div> : <span role="status" className="inline-flex items-center gap-2">{historyLoading && <LuLoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />}{historyLoading ? t("gitView.loadingMoreCommits") : t("gitView.scrollOlderCommits")}</span>}
          </div>}
        </section>}
      </div>}
    </div>
    <footer className="workspace-tool-footer flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="inline-flex min-w-0 max-w-[55%] items-center gap-1.5"><span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", !ready ? "bg-muted-foreground/40" : conflictCount ? "bg-rose-500" : ready.files.length ? "bg-amber-500" : "bg-emerald-500")} /><span className="truncate">{!ready ? t("gitView.noRepoSelected") : conflictCount ? t("gitView.conflictsToResolve") : ready.files.length ? t("gitView.changedAndStaged", { changed: ready.files.length, staged: stagedFiles.length }) : t("gitView.workingTreeClean")}</span></span>
      {ready?.upstream && <span className="inline-flex items-center gap-1.5 font-mono" title={t("gitView.upstreamTitle", { upstream: ready.upstream })}><LuArrowUp className="h-3 w-3" />{ready.ahead || 0}<LuArrowDown className="h-3 w-3" />{ready.behind || 0}</span>}
      {path && <button type="button" title={t("gitView.copyRepoPathTitle", { path })} aria-label={t("gitView.copyRepoPath")} onClick={() => void copy(path)} className="ml-auto inline-flex min-w-0 max-w-[40%] items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-muted hover:text-foreground">{copied === path ? <LuCheck className="h-3 w-3 shrink-0 text-emerald-500" /> : <LuCopy className="h-3 w-3 shrink-0" />}<span className="truncate font-mono">{copied === path ? t("common.copied") : path}</span></button>}
    </footer>
  </section>;
}
