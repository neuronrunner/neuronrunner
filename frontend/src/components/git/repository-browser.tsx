"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCheck, LuGithub, LuGitlab, LuLoaderCircle, LuLock, LuRefreshCw } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  GITHUB_ACCOUNTS_EVENT,
  connectGithubAccount,
  githubRepositories,
  type GithubAccess,
} from "@/lib/github-connection";
import {
  GITLAB_ACCOUNTS_EVENT,
  connectGitlabAccount,
  gitlabRepositories,
  type GitlabAccess,
} from "@/lib/gitlab-connection";
import { cn } from "@/lib/utils";

export type GitProvider = "github" | "gitlab";

export interface BrowsedRepository {
  provider: GitProvider;
  full_name: string;
  clone_url: string;
  private: boolean;
  description?: string | null;
  default_branch?: string | null;
}

type Access = GithubAccess | GitlabAccess;

const PROVIDERS: Array<{ id: GitProvider; label: string; Icon: typeof LuGithub }> = [
  { id: "github", label: "GitHub", Icon: LuGithub },
  { id: "gitlab", label: "GitLab", Icon: LuGitlab },
];

function errorMessage(error: unknown, fallback: string) {
  return (error as { response?: { data?: { error?: string } } })?.response?.data?.error || (error instanceof Error ? error.message : fallback);
}

/** Loads one provider's account status and repositories, page by page. */
function useProviderRepositories(provider: GitProvider, uuid: string | undefined, fallbackError: string) {
  const [access, setAccess] = useState<Access | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    setAccess(null);
    setLoading(true);
    setPage(1);
    setError("");
  }, [uuid]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const load = provider === "github" ? githubRepositories : gitlabRepositories;
    load(uuid, page, controller.signal)
      .then((data: Access) => {
        if (controller.signal.aborted) return;
        setAccess((previous) => ({
          ...data,
          repos: page > 1 ? [...(previous?.repos || []), ...(data.repos || [])] : data.repos || [],
        }) as Access);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorMessage(cause, fallbackError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [provider, uuid, page, revision, fallbackError]);

  useEffect(() => {
    const event = provider === "github" ? GITHUB_ACCOUNTS_EVENT : GITLAB_ACCOUNTS_EVENT;
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener(event, refresh);
    return () => window.removeEventListener(event, refresh);
  }, [provider]);

  return {
    access,
    loading,
    error,
    nextPage: () => setPage((value) => value + 1),
    reload: () => {
      setPage(1);
      setRevision((value) => value + 1);
    },
  };
}

interface Props {
  uuid?: string;
  disabled?: boolean;
  /** Clone URL of the repository currently chosen, to mark it in the list. */
  value?: string;
  onSelect: (repository: BrowsedRepository) => void;
  onConnectingChange?: (provider: GitProvider, connecting: boolean) => void;
  /** Reported by self-hosted GitLab so pasted URLs on that host are recognised. */
  onGitlabBaseUrl?: (baseUrl: string) => void;
}

/**
 * One place to pick a repository from every connected Git account: the accounts sit side by side as
 * status chips and their repositories share a single search box and list.
 */
export default function RepositoryBrowser({ uuid, disabled, value, onSelect, onConnectingChange, onGitlabBaseUrl }: Props) {
  const { t } = useTranslation("git");
  const github = useProviderRepositories("github", uuid, t("githubAccess.loadError"));
  const gitlab = useProviderRepositories("gitlab", uuid, t("gitlabAccess.loadError"));
  const states = { github, gitlab } as const;
  const [connecting, setConnecting] = useState<GitProvider | null>(null);
  const [connectError, setConnectError] = useState("");
  const [query, setQuery] = useState("");
  const connection = useRef<AbortController | null>(null);
  const connectingCallback = useRef(onConnectingChange);
  connectingCallback.current = onConnectingChange;
  const baseUrlCallback = useRef(onGitlabBaseUrl);
  baseUrlCallback.current = onGitlabBaseUrl;

  const gitlabBaseUrl = (gitlab.access as GitlabAccess | null)?.base_url;
  useEffect(() => {
    if (gitlabBaseUrl) baseUrlCallback.current?.(gitlabBaseUrl);
  }, [gitlabBaseUrl]);

  useEffect(() => () => connection.current?.abort(), []);

  const connect = async (provider: GitProvider) => {
    if (connecting || disabled) return;
    const controller = new AbortController();
    connection.current = controller;
    setConnecting(provider);
    setConnectError("");
    connectingCallback.current?.(provider, true);
    try {
      if (provider === "github") await connectGithubAccount(controller.signal, uuid);
      else await connectGitlabAccount(controller.signal);
      if (!controller.signal.aborted) states[provider].reload();
    } catch (cause) {
      if (!controller.signal.aborted) setConnectError(errorMessage(cause, t(`${provider}Access.loadError`)));
    } finally {
      if (!controller.signal.aborted) setConnecting(null);
      connectingCallback.current?.(provider, false);
    }
  };

  const repositories = useMemo<BrowsedRepository[]>(() => {
    const needle = query.trim().toLowerCase();
    return PROVIDERS.flatMap(({ id }) =>
      (states[id].access?.repos || []).map((repo) => ({ ...repo, provider: id }))
    ).filter((repo) => !needle || repo.full_name.toLowerCase().includes(needle));
  }, [github.access, gitlab.access, query]); // eslint-disable-line react-hooks/exhaustive-deps

  const anyConnected = PROVIDERS.some(({ id }) => states[id].access?.connected);
  const checking = PROVIDERS.some(({ id }) => states[id].loading && !states[id].access) && !connecting;
  const loadingMore = PROVIDERS.some(({ id }) => states[id].loading && Boolean(states[id].access));
  const hasNext = PROVIDERS.some(({ id }) => states[id].access?.connected && states[id].access?.has_next);
  const errors = [connectError, github.error, gitlab.error].filter(Boolean);

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {PROVIDERS.map(({ id, label, Icon }) => {
          const state = states[id];
          const access = state.access;
          const isConnecting = connecting === id;
          const isChecking = state.loading && !access && !isConnecting;
          const reconnect = access?.connected || access?.reason === "expired";
          return (
            <div key={id} className="flex min-w-0 items-center gap-2 rounded-md border border-border/70 bg-background/60 px-2.5 py-2">
              <Icon aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1 text-xs">
                <p className="font-medium">{label}</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {isConnecting
                    ? t(`${id}Access.connectingTitle`)
                    : isChecking
                      ? t("repoBrowser.checking")
                      : access?.connected
                        ? `@${access.username || label}`
                        : access?.reason === "expired"
                          ? t(`${id}Access.expiredDesc`)
                          : t("repoBrowser.notConnected")}
                </p>
              </div>
              {isChecking ? (
                <LuLoaderCircle aria-label={t(`${id}Access.checkingTitle`)} className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 gap-1.5 px-2 text-xs"
                  disabled={disabled || Boolean(connecting)}
                  onClick={() => void connect(id)}
                >
                  {isConnecting ? <LuLoaderCircle className="h-3 w-3 animate-spin" /> : reconnect ? <LuRefreshCw className="h-3 w-3" /> : null}
                  {isConnecting ? t("repoBrowser.connecting") : reconnect ? t("repoBrowser.reconnect") : t("repoBrowser.connect")}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {anyConnected ? (
        <div className="space-y-2 border-t pt-3">
          <Input
            aria-label={t("repoBrowser.searchAriaLabel")}
            placeholder={t("repoBrowser.searchPlaceholder")}
            value={query}
            disabled={disabled || Boolean(connecting)}
            onChange={(event) => setQuery(event.target.value)}
            className="h-8 text-xs"
          />
          <div aria-label={t("repoBrowser.listAriaLabel")} className="max-h-48 space-y-1 overflow-y-auto">
            {repositories.map((repo) => {
              const selected = value === repo.clone_url;
              const Icon = repo.provider === "github" ? LuGithub : LuGitlab;
              return (
                <button
                  key={`${repo.provider}:${repo.full_name}`}
                  type="button"
                  disabled={disabled || Boolean(connecting)}
                  aria-pressed={selected}
                  onClick={() => onSelect(repo)}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-muted disabled:opacity-50",
                    selected && "bg-violet-500/10"
                  )}
                >
                  <Icon aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium" title={repo.full_name}>{repo.full_name}</span>
                    {repo.description && <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{repo.description}</span>}
                  </span>
                  {selected && <LuCheck aria-hidden className="h-3.5 w-3.5 shrink-0 text-violet-500" />}
                  {repo.private && (
                    <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                      <LuLock aria-hidden className="h-3 w-3" />
                      {t("repoBrowser.private")}
                    </span>
                  )}
                </button>
              );
            })}
            {!repositories.length && !loadingMore && (
              <p className="py-2 text-xs text-muted-foreground">{query ? t("repoBrowser.noMatching") : t("repoBrowser.empty")}</p>
            )}
          </div>
          {hasNext && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled || Boolean(connecting) || loadingMore}
              onClick={() => PROVIDERS.forEach(({ id }) => states[id].access?.connected && states[id].access?.has_next && states[id].nextPage())}
            >
              {loadingMore ? t("repoBrowser.loading") : t("repoBrowser.loadMore")}
            </Button>
          )}
        </div>
      ) : (
        !checking && <p className="text-[11px] leading-relaxed text-muted-foreground">{t("repoBrowser.connectHint")}</p>
      )}

      {errors.map((message) => (
        <div key={message} role="alert" className="text-xs text-destructive">
          <p className="break-words">{message}</p>
        </div>
      ))}
    </div>
  );
}
