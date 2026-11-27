"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuRefreshCw, LuUnlink } from "react-icons/lu";
import { SiGitlab } from "react-icons/si";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { toaster } from "@/components/ui/toaster";
import {
  connectGitlabAccount,
  disconnectGitlabAccount,
  getGitlabAccountStatus,
  notifyGitlabAccountsChanged,
  type GitlabAccount,
} from "@/lib/gitlab-connection";

function errorMessage(error: unknown, fallback: string) {
  return (
    (error as { response?: { data?: { error?: string; detail?: string } } })?.response?.data?.error ||
    (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
    (error instanceof Error ? error.message : fallback)
  );
}

export default function GitlabAccountConnection({ onCountChange }: { onCountChange?: (count: number) => void }) {
  const { t } = useTranslation(["git", "common"]);
  const [accounts, setAccounts] = useState<GitlabAccount[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [connectError, setConnectError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [target, setTarget] = useState<GitlabAccount | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState("");
  const connection = useRef<AbortController | null>(null);
  const pending = useRef(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError("");
    try {
      const status = await getGitlabAccountStatus(signal);
      if (!signal?.aborted) {
        setAccounts(status.accounts);
        setConfigured(status.configured);
        onCountChange?.(status.accounts.length);
      }
    } catch (error) {
      if (!signal?.aborted) setLoadError(errorMessage(error, t("gitlabAccount.loadError")));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [onCountChange, t]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => () => connection.current?.abort(), []);

  const connect = async () => {
    if (pending.current || !configured) return;
    pending.current = true;
    const controller = new AbortController();
    connection.current = controller;
    setConnecting(true);
    setConnectError("");
    try {
      await connectGitlabAccount(controller.signal);
      if (controller.signal.aborted) return;
      notifyGitlabAccountsChanged();
      await load();
      toaster.create({
        title: t("gitlabAccount.connectSuccessTitle"),
        description: t("gitlabAccount.connectSuccessDescription"),
        type: "success",
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        setConnectError(errorMessage(error, t("gitlabAccount.connectError")));
      }
    } finally {
      pending.current = false;
      if (!controller.signal.aborted) setConnecting(false);
    }
  };

  const disconnect = async () => {
    if (!target || disconnecting) return;
    setDisconnecting(true);
    setDisconnectError("");
    try {
      const deleted = await disconnectGitlabAccount(target.id);
      if (!deleted) throw new Error(t("gitlabAccount.disconnectError"));
      const remaining = accounts.filter((account) => account.id !== target.id);
      setAccounts(remaining);
      onCountChange?.(remaining.length);
      notifyGitlabAccountsChanged();
      toaster.create({
        title: t("gitlabAccount.disconnectSuccessTitle"),
        description: t("gitlabAccount.disconnectSuccessDescription", {
          login: target.login || target.id,
        }),
        type: "success",
      });
      setTarget(null);
    } catch (error) {
      setDisconnectError(errorMessage(error, t("gitlabAccount.disconnectError")));
    } finally {
      setDisconnecting(false);
    }
  };

  const changeTarget = (open: boolean) => {
    if (disconnecting || open) return;
    setTarget(null);
    setDisconnectError("");
  };

  return (
    <section
      aria-label={t("gitlabAccount.title")}
      className="rounded-2xl border border-border/70 bg-card/60 p-4 sm:p-5 dark:bg-white/[0.02]"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-orange-500/25 bg-orange-500/10 text-orange-500">
            <SiGitlab className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold tracking-tight">{t("gitlabAccount.title")}</h2>
              <span className="rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground dark:border-white/10 dark:bg-white/5">
                {t("gitlabAccount.personal")}
              </span>
            </div>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
              {t("gitlabAccount.description")}
            </p>
          </div>
        </div>
        {!loading && accounts.length > 0 ? (
          <Badge className="shrink-0 border border-emerald-500/20 bg-emerald-500/15 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
            {t("gitlabAccount.connectedBadge")}
          </Badge>
        ) : !loading && !configured ? (
          <Badge className="shrink-0 border border-border/70 bg-muted/50 text-[10px] font-medium text-muted-foreground">
            {t("gitlabAccount.notConfiguredBadge")}
          </Badge>
        ) : null}
      </div>

      <div className="mt-4">
        {loading ? (
          <div className="space-y-2" role="status" aria-label={t("gitlabAccount.loading")}>
            <Skeleton className="h-12 w-full rounded-xl" />
          </div>
        ) : !accounts[0] ? (
          loadError ? (
            <div role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-5 text-center text-xs text-destructive">
              <p className="break-words">{loadError}</p>
              <button type="button" className="mt-1 underline" onClick={() => void load()}>
                {t("gitlabAccount.retry")}
              </button>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border/70 px-4 py-5 text-center dark:border-white/10">
              <p className="text-xs font-medium text-foreground">{t("gitlabAccount.emptyTitle")}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {configured ? t("gitlabAccount.emptyDescription") : t("gitlabAccount.notConfiguredDescription")}
              </p>
            </div>
          )
        ) : (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-background/60 px-3 py-2.5 dark:border-white/10 dark:bg-white/[0.02]">
            <div className="flex min-w-0 items-center gap-2.5">
              <SiGitlab className="h-4 w-4 shrink-0 text-orange-500" />
              <span className="truncate text-xs font-medium text-foreground">
                @{accounts[0].login || accounts[0].id}
              </span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 shrink-0 gap-1.5 rounded-full text-xs"
              aria-label={t("gitlabAccount.disconnectAriaLabel", {
                login: accounts[0].login || accounts[0].id,
              })}
              onClick={() => {
                setDisconnectError("");
                setTarget(accounts[0]);
              }}
            >
              <LuUnlink className="h-3 w-3" />
              {t("gitlabAccount.disconnect")}
            </Button>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3 dark:border-white/5">
        <div className="min-w-0">
          {loadError && accounts.length > 0 && (
            <div role="alert" className="text-xs text-destructive">
              <p className="break-words">{loadError}</p>
              <button type="button" className="mt-1 underline" onClick={() => void load()}>
                {t("gitlabAccount.retry")}
              </button>
            </div>
          )}
          {connectError && (
            <p role="alert" className="break-words text-xs text-destructive">
              {connectError}
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto h-8 shrink-0 gap-1.5 rounded-full text-xs"
          disabled={connecting || !configured}
          loading={connecting}
          onClick={() => void connect()}
        >
          {connecting ? null : accounts.length > 0 ? (
            <LuRefreshCw className="h-3.5 w-3.5" />
          ) : (
            <SiGitlab className="h-3.5 w-3.5 text-orange-500" />
          )}
          {connecting
            ? t("gitlabAccount.connecting")
            : accounts.length > 0
              ? t("gitlabAccount.reconnect")
              : t("gitlabAccount.connect")}
        </Button>
      </div>

      <Dialog open={Boolean(target)} onOpenChange={changeTarget}>
        <DialogContent
          hideClose={disconnecting}
          className="w-[calc(100%-2rem)] rounded-xl"
          onEscapeKeyDown={(event) => {
            if (disconnecting) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (disconnecting) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle className="break-words">
              {t("gitlabAccount.disconnectTitle", {
                login: target?.login || target?.id || "",
              })}
            </DialogTitle>
            <DialogDescription>{t("gitlabAccount.disconnectDescription")}</DialogDescription>
          </DialogHeader>
          {disconnectError && (
            <p role="alert" className="break-words text-xs text-destructive">
              {disconnectError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={disconnecting}
              onClick={() => changeTarget(false)}
            >
              {t("common:common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={disconnecting}
              onClick={() => void disconnect()}
            >
              {disconnecting
                ? t("gitlabAccount.disconnecting")
                : t("gitlabAccount.disconnectConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
