"use client";

import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  LuCheck,
  LuChevronDown,
  LuGitBranch,
  LuLoaderCircle,
  LuPlay,
  LuPlus,
  LuRefreshCw,
  LuServer,
} from "react-icons/lu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { toaster } from "@/components/ui/toaster";
import { useRepositoryChanges, useRepositoryStatus } from "@/hooks/use-repository-status";
import { chatCheckoutRequest, chatCheckoutSwitch, repositoryError, type ChatCheckout } from "@/lib/repository-api";
import useChatStore from "@/stores/chat";
import { useChatBranchStore } from "@/stores/chat-branch";
import type { IProject } from "@/stores/sandbox-projects";
import useSandboxProjectsStore from "@/stores/sandbox-projects";
import useWorkspacesStore from "@/stores/workspaces";

type Props = {
  uuid?: string;
  path?: string;
  project?: IProject;
  onSelected?: () => void;
  inline?: boolean;
};

export default function ProjectBranchPicker({
  uuid,
  path,
  project,
  onSelected,
  inline,
}: Props) {
  const { t } = useTranslation("workspace");
  const repo = useRepositoryStatus(uuid, path);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [startingVM, setStartingVM] = useState(false);

  // Each chat works in its own branch checkout, so picking a branch here never moves the
  // project folder or the agents running in other chats.
  const conversationId = useChatStore((state) => state.conversationId);
  const generating = useChatStore((state) => state.isStreaming || state.isActivelyGenerating);
  const pendingBranch = useChatBranchStore((state) => state.pending);
  const setPendingBranch = useChatBranchStore((state) => state.setPending);
  const [checkout, setCheckout] = useState<ChatCheckout | null>(null);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const chatKey = !inline && conversationId && uuid && path ? `${uuid}:${path}:${conversationId}` : null;

  useEffect(() => {
    setCheckout(null);
    setCheckoutError(null);
    if (!chatKey || !uuid || !path || !conversationId) return;
    const controller = new AbortController();
    chatCheckoutRequest(uuid, conversationId, path, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setCheckout(next);
      })
      // A chat that is not tied to this project yet keeps the pending-branch flow below.
      .catch(() => undefined);
    return () => controller.abort();
  }, [chatKey, uuid, path, conversationId]);

  const currentSandbox = useSandboxProjectsStore((state) => state.currentSandbox);
  const activeProject =
    project || (currentSandbox?.filesystem_path === path ? currentSandbox : undefined);
  const workspaceUuid = useWorkspacesStore(
    (state) => state.currentWorkspace?.uuid || state.currentWorkspaceUuid
  );
  const targetVM = null as { uuid: string; name: string; status: string } | null;
  const isVMRunning = true;
  const isVMStarting = false;
  const setCreateModalOpen = (_open: boolean) => {};

  const handleStartVM = async () => {};

  const pendingHere = pendingBranch && pendingBranch.project === activeProject?.uuid ? pendingBranch : null;
  const shownStatus = checkout ?? repo.status;
  const busy = repo.busy || checkoutBusy;
  const locked = generating && Boolean(checkout);
  const error = checkoutError || repo.error;

  const done = () => {
    setOpen(false);
    setQuery("");
    onSelected?.();
  };

  const choose = async (branch: string, create = false) => {
    if (locked || busy) return;
    if (checkout && uuid && path && conversationId) {
      setCheckoutBusy(true);
      setCheckoutError(null);
      try {
        const next = await chatCheckoutSwitch(uuid, conversationId, path, branch, create);
        setCheckout(next);
        setPendingBranch(null);
        // A newly created branch also shows up in the project's branch list.
        useRepositoryChanges.getState().changed(`${uuid}:${path}`);
        done();
      } catch (cause) {
        setCheckoutError(repositoryError(cause));
      } finally {
        setCheckoutBusy(false);
      }
      return;
    }
    // No chat yet: remember the choice, the first message gives it its own checkout.
    if (!activeProject) return;
    const sameAsProject = !create && branch === repo.status?.branch;
    setPendingBranch(sameAsProject ? null : { project: activeProject.uuid, branch, create });
    done();
  };

  const branches = shownStatus?.branches || [];
  const currentBranch = pendingHere?.branch ?? shownStatus?.branch;

  let contents: React.ReactNode;

  if (!isVMRunning) {
    if (isVMStarting) {
      contents = (
        <div className="flex flex-col items-center justify-center px-3 py-6 text-center">
          <div className="mb-2.5 flex h-9 w-9 items-center justify-center rounded-xl bg-muted/70 text-muted-foreground">
            <LuLoaderCircle className="h-4 w-4 animate-spin text-foreground" />
          </div>
          <p className="text-xs font-semibold text-foreground">
            {targetVM ? t("projects.branchPicker.startingVmNamed", { name: targetVM.name }) : t("projects.branchPicker.startingVm")}
          </p>
          <p className="mt-1 max-w-[220px] text-[11px] leading-relaxed text-muted-foreground">
            {t("projects.branchPicker.branchesLoadAuto")}
          </p>
        </div>
      );
    } else {
      contents = (
        <div className="flex flex-col items-center justify-center px-3 py-4 text-center">
          <div className="mb-2.5 flex h-9 w-9 items-center justify-center rounded-xl border border-border/70 bg-muted/50 text-muted-foreground">
            <LuServer className="h-4 w-4" />
          </div>
          <p className="text-xs font-semibold text-foreground">
            {currentBranch ? (
              <Trans
                i18nKey="projects.branchPicker.branchLabel"
                ns="workspace"
                values={{ branch: currentBranch }}
                components={{ branch: <span className="font-mono font-medium" /> }}
              />
            ) : (
              t("projects.branchPicker.vmOffline")
            )}
          </p>
          <p className="mt-1 max-w-[220px] text-[11px] leading-relaxed text-muted-foreground">
            {targetVM
              ? currentBranch
                ? t("projects.branchPicker.startVmToSwitch", { name: targetVM.name })
                : t("projects.branchPicker.startVmToView", { name: targetVM.name })
              : t("projects.branchPicker.startAnyVm")}
          </p>
          <div className="mt-3.5 flex w-full flex-col gap-1.5">
            {targetVM ? (
              <Button
                type="button"
                size="sm"
                disabled={startingVM}
                onClick={handleStartVM}
                className="h-8 w-full gap-1.5 text-xs font-medium"
              >
                {startingVM ? (
                  <>
                    <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    <span>{t("projects.branchPicker.startingMachine")}</span>
                  </>
                ) : (
                  <>
                    <LuPlay className="h-3.5 w-3.5 fill-current" />
                    <span>{t("projects.branchPicker.startMachine")}</span>
                  </>
                )}
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setOpen(false);
                  setCreateModalOpen(true);
                }}
                className="h-8 w-full gap-1.5 text-xs font-medium"
              >
                <LuPlus className="h-3.5 w-3.5" />
                <span>{t("projects.branchPicker.createMachine")}</span>
              </Button>
            )}

            {inline && onSelected && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onSelected}
                className="h-8 w-full text-xs font-medium"
              >
                {currentBranch ? t("projects.branchPicker.useBranch", { branch: currentBranch }) : t("projects.branchPicker.selectProject")}
              </Button>
            )}
          </div>
          {inline && (
            <p className="mt-2.5 px-2 text-[10px] leading-relaxed text-muted-foreground">
              {t("projects.branchPicker.branchPerChat")}
            </p>
          )}
        </div>
      );
    }
  } else {
    contents = (
      <div className="space-y-1">
        <div className="flex items-center gap-2 px-2 pb-1">
          <input
            aria-label={t("projects.branchPicker.findOrCreateAria")}
            placeholder={t("projects.branchPicker.findOrCreatePlaceholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            disabled={busy || locked}
            className="h-8 min-w-0 flex-1 bg-transparent text-xs outline-none"
          />
          <button
            type="button"
            aria-label={t("projects.branchPicker.refreshBranches")}
            disabled={busy || locked}
            onClick={repo.refresh}
            className="p-1 text-muted-foreground hover:text-foreground"
          >
            <LuRefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
        {locked && (
          <p role="status" className="px-2 py-1 text-[11px] text-muted-foreground">
            {t("projects.branchPicker.branchLockedWhileRunning")}
          </p>
        )}
        {error && (
          <div
            role="alert"
            className="flex items-start justify-between gap-2 rounded-md bg-destructive/10 px-2 py-2 text-xs text-destructive"
          >
            <span className="min-w-0 flex-1 leading-relaxed">{error}</span>
            <button
              type="button"
              onClick={repo.refresh}
              className="shrink-0 font-medium underline underline-offset-2"
            >
              {t("common.retry")}
            </button>
          </div>
        )}
        {repo.loading ? (
          <p
            role="status"
            className="flex items-center gap-2 px-2 py-4 text-xs text-muted-foreground"
          >
            <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
            {t("projects.branchPicker.loadingBranches")}
          </p>
        ) : (
          <div className="max-h-52 overflow-y-auto">
            {branches
              .filter((branch) =>
                branch.name.toLowerCase().includes(query.toLowerCase())
              )
              .map((branch) => (
                <button
                  key={`${branch.remote}:${branch.name}`}
                  type="button"
                  disabled={busy || locked}
                  onClick={() => void choose(branch.name)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-muted disabled:opacity-50"
                >
                  <LuGitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                  {branch.remote && (
                    <span className="text-[10px] text-muted-foreground">{t("projects.branchPicker.remote")}</span>
                  )}
                  {branch.name === currentBranch && (
                    <LuCheck className="h-3.5 w-3.5" />
                  )}
                </button>
              ))}
            {!branches.length && !error && (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                {t("projects.branchPicker.noBranchesFound")}
              </p>
            )}
            {shownStatus &&
              query.trim() &&
              !branches.some((branch) => branch.name === query.trim()) && (
                <button
                  type="button"
                  disabled={busy || locked}
                  onClick={() => void choose(query.trim(), true)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-muted"
                >
                  <LuPlus className="h-3.5 w-3.5" />
                  <span className="truncate">{t("projects.branchPicker.createBranch", { name: query.trim() })}</span>
                </button>
              )}
            {inline && shownStatus && (
              <button
                type="button"
                disabled={busy || locked}
                onClick={() => void choose(currentBranch || shownStatus!.branch)}
                className="mt-2 w-full rounded-md bg-foreground px-3 py-2 text-xs font-medium text-background hover:bg-foreground/90 disabled:opacity-50"
              >
                {busy ? t("projects.branchPicker.switchingBranch") : t("projects.branchPicker.useBranch", { branch: currentBranch || shownStatus.branch })}
              </button>
            )}
          </div>
        )}
        {!inline && busy && (
          <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
            {t("projects.branchPicker.switchingBranch")}
          </p>
        )}
        {inline && (
          <p className="px-2 pt-2 text-[10px] leading-relaxed text-muted-foreground">
            {t("projects.branchPicker.branchPerChat")}
          </p>
        )}
      </div>
    );
  }

  if (inline) return contents;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("projects.branchPicker.chooseBranchAria")}
          title={
            !isVMRunning
              ? isVMStarting
                ? t("projects.branchPicker.vmStartingTitle")
                : t("projects.branchPicker.vmOfflineTitle")
              : currentBranch
                ? t("projects.branchPicker.branchTitle", { branch: currentBranch })
                : t("projects.branchPicker.chooseBranchAria")
          }
          className="flex h-8 max-w-44 items-center gap-1.5 rounded-md bg-transparent px-2 text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          {isVMStarting ? (
            <LuLoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <LuGitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{currentBranch || t("projects.branchPicker.branchFallback")}</span>
          <LuChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 max-w-[calc(100vw-2rem)] rounded-xl p-2 shadow-xl"
      >
        {contents}
      </PopoverContent>
    </Popover>
  );
}
