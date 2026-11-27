"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCheck, LuGitlab, LuLoaderCircle, LuLock, LuRefreshCw } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GITLAB_ACCOUNTS_EVENT, connectGitlabAccount, gitlabRepositories, type GitlabAccess, type GitlabRepository } from "@/lib/gitlab-connection";

interface Props {
  uuid?: string;
  disabled?: boolean;
  onSelect: (url: string) => void;
  onSelectRepo?: (repo: GitlabRepository) => void;
  value?: string;
  onConnectingChange?: (connecting: boolean) => void;
  onBaseUrl?: (baseUrl: string) => void;
}

function errorMessage(error: unknown, fallback: string) {
  return (error as { response?: { data?: { error?: string } } })?.response?.data?.error || (error instanceof Error ? error.message : fallback);
}

export default function GitlabRepositoryAccess({ uuid, disabled, onSelect, onSelectRepo, value, onConnectingChange, onBaseUrl }: Props) {
  const { t } = useTranslation("git");
  const [access, setAccess] = useState<GitlabAccess | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(true);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const pending = useRef<AbortController | null>(null);
  const connectingCallback = useRef(onConnectingChange);
  connectingCallback.current = onConnectingChange;
  const connection = useRef<AbortController | null>(null);
  const baseUrlCallback = useRef(onBaseUrl);
  baseUrlCallback.current = onBaseUrl;

  useEffect(() => {
    setAccess(null); setLoading(true); setPage(1); setExpanded(true); setQuery(""); setError("");
  }, [uuid]);
  useEffect(() => {
    const controller = new AbortController(); pending.current = controller;
    setLoading(true); setError("");
    gitlabRepositories(uuid, page, controller.signal).then(data => {
      if (!controller.signal.aborted && data.base_url) baseUrlCallback.current?.(data.base_url);
      if (!controller.signal.aborted) setAccess(previous => ({ ...data, repos: page > 1 ? [...(previous?.repos || []), ...(data.repos || [])] : data.repos || [] }));
    }).catch(error => { if (!controller.signal.aborted) setError(errorMessage(error, t("gitlabAccess.loadError"))); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [uuid, page, revision, t]);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener(GITLAB_ACCOUNTS_EVENT, refresh);
    return () => window.removeEventListener(GITLAB_ACCOUNTS_EVENT, refresh);
  }, []);
  useEffect(() => () => { connection.current?.abort(); connectingCallback.current?.(false); }, []);

  const connect = async () => {
    if (connecting || disabled) return;
    const controller = new AbortController(); connection.current = controller;
    setConnecting(true); setError(""); connectingCallback.current?.(true);
    try {
      await connectGitlabAccount(controller.signal);
      if (!controller.signal.aborted) {
        pending.current?.abort(); setPage(1); setExpanded(true); setRevision(value => value + 1);
      }
    } catch (error) { if (!controller.signal.aborted) setError(errorMessage(error, t("gitlabAccess.loadError"))); }
    finally {
      if (!controller.signal.aborted) { setConnecting(false); connectingCallback.current?.(false); }
    }
  };
  const repos = access?.repos.filter(repo => repo.full_name.toLowerCase().includes(query.toLowerCase())) || [];
  const missingAccess = access?.connected && access.can_access_private === false;
  const checking = loading && !access && !connecting;
  return <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
    <div className="flex flex-wrap items-center gap-2">
      <LuGitlab className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 text-xs">
        <p className="truncate font-medium">{connecting ? t("gitlabAccess.connectingTitle") : access?.connected ? `@${access.username || "GitLab"}` : checking ? t("gitlabAccess.checkingTitle") : t("gitlabAccess.privateReposTitle")}</p>
        {!checking && <p className="mt-0.5 text-[11px] text-muted-foreground">{missingAccess ? t("gitlabAccess.missingAccessDesc") : access?.connected ? t("gitlabAccess.connectedDesc") : access?.reason === "expired" ? t("gitlabAccess.expiredDesc") : t("gitlabAccess.disconnectedDesc")}</p>}
      </div>
      {checking ? (
        <span className="flex h-7 w-7 items-center justify-center text-muted-foreground" role="status" aria-label={t("gitlabAccess.checkingTitle")}>
          <LuLoaderCircle className="h-4 w-4 animate-spin" />
        </span>
      ) : (
        <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 text-xs" disabled={disabled || connecting} onClick={() => void connect()}>{connecting ? <LuLoaderCircle className="h-3 w-3 animate-spin" /> : access?.connected || access?.reason === "expired" ? <LuRefreshCw className="h-3 w-3" /> : <LuGitlab className="h-3 w-3" />}{connecting ? t("gitlabAccess.connecting") : access?.connected || access?.reason === "expired" ? t("gitlabAccess.reconnect") : t("gitlabAccess.connect")}</Button>
      )}
    </div>
    {access?.connected && <button type="button" disabled={disabled || connecting} aria-expanded={expanded} onClick={() => setExpanded(value => !value)} className="text-xs text-primary hover:underline disabled:opacity-50">{expanded ? t("gitlabAccess.hideRepos") : t("gitlabAccess.chooseRepos")}</button>}
    {expanded && access?.connected && <div className="space-y-2 border-t pt-3">
      <Input aria-label={t("gitlabAccess.searchAriaLabel")} placeholder={t("gitlabAccess.searchPlaceholder")} value={query} disabled={disabled || connecting} onChange={event => setQuery(event.target.value)} className="h-8 text-xs" />
      <div aria-label={t("gitlabAccess.listAriaLabel")} className="max-h-40 space-y-1 overflow-y-auto">
        {repos.map(repo => <button key={repo.full_name} type="button" disabled={disabled || connecting} onClick={() => { onSelect(repo.clone_url); onSelectRepo?.(repo); }} aria-pressed={value === repo.clone_url} className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-muted disabled:opacity-50 ${value === repo.clone_url ? "bg-violet-500/10" : ""}`}><LuGitlab className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block truncate font-medium" title={repo.full_name}>{repo.full_name}</span>{repo.description && <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{repo.description}</span>}</span>{value === repo.clone_url && <LuCheck className="h-3.5 w-3.5 shrink-0 text-violet-500" />}{repo.private && <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground"><LuLock className="h-3 w-3" />{t("gitlabAccess.privateBadge")}</span>}</button>)}
        {!repos.length && !loading && <p className="py-2 text-xs text-muted-foreground">{query ? t("gitlabAccess.noMatchingRepos") : t("gitlabAccess.noReposAvailable")}</p>}
      </div>
      {access.has_next && <Button type="button" size="sm" variant="ghost" disabled={disabled || connecting || loading} onClick={() => setPage(value => value + 1)}>{loading ? t("gitlabAccess.loading") : t("gitlabAccess.loadMore")}</Button>}
    </div>}
    {access?.connected && access.can_access_private === true && !expanded && <p className="flex items-center gap-1 text-[11px] text-muted-foreground"><LuCheck className="h-3 w-3 text-emerald-500" />{t("gitlabAccess.privateAccessEnabled")}</p>}
    {error && <div role="alert" className="text-xs text-destructive"><p className="break-words">{error}</p>{!connecting && uuid && <button type="button" disabled={disabled} onClick={() => { setPage(1); setRevision(value => value + 1); }} className="mt-1 underline">{t("gitlabAccess.retry")}</button>}</div>}
  </div>;
}
