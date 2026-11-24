"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "@/lib/navigation";
import { LuCheck, LuChevronsUpDown, LuLoaderCircle, LuUsers } from "react-icons/lu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import useAuthStore from "@/stores/auth";
import useChatStore from "@/stores/chat";
import useSandboxProjectsStore from "@/stores/sandbox-projects";
import useSidebarStore from "@/stores/sidebar";
import useWorkspacesStore from "@/stores/workspaces";
import useWorkspaceTabsStore from "@/stores/workspace-tabs";
import { cn } from "@/lib/utils";
import { WorkspaceAvatar } from "./workspace-identity";

export function useWorkspaceSwitcher() {
  const router = useRouter();
  const token = useAuthStore((state) => state.token);
  const { workspaces, currentWorkspace, fetchWorkspaces, selectWorkspace, isLoading, hasLoaded } = useWorkspacesStore();
  const [isSwitching, setIsSwitching] = useState(false);

  useEffect(() => {
    if (token && !workspaces.length && !useWorkspacesStore.getState().isLoading) void fetchWorkspaces();
  }, [token, workspaces.length, fetchWorkspaces]);

  const switchWorkspace = async (uuid: string) => {
    if (isSwitching || uuid === currentWorkspace?.uuid) return;
    const workspace = selectWorkspace(uuid);
    if (!workspace) return;
    setIsSwitching(true);
    try {
      const sidebar = useSidebarStore.getState();
      sidebar.abortController?.abort();
      sidebar.historyAbortController?.abort();
      useSidebarStore.setState({
        conversations: [],
        projectConversations: {},
        generalConversations: [],
        generalHistoryProjectId: null,
        conversationProjectId: null,
        requestId: sidebar.requestId + 1,
        historyRequestId: sidebar.historyRequestId + 1,
        abortController: null,
        historyAbortController: null,
        isLoading: false,
        isLoadingMore: false,
        isHistoryLoading: false,
        isHistoryLoadingMore: false,
        historyHasMore: false,
      });
      useSandboxProjectsStore.setState({ currentSandbox: null });
      await useSandboxProjectsStore.getState().fetchSandboxes(workspace.uuid);
      const filesystem = useSandboxProjectsStore.getState().workspaceSandbox;
      useChatStore.getState().reset();
      useChatStore.getState().setChatMode("code");
      useWorkspaceTabsStore.getState().resetForWorkspace();
      if (filesystem?.workspace_uuid === workspace.uuid) await useSidebarStore.getState().fetchGeneralConversations(false, filesystem.uuid);
      else useSidebarStore.setState({ generalConversations: [], generalHistoryProjectId: null, historyHasMore: false });
      router.push("/new");
    } finally {
      setIsSwitching(false);
    }
  };

  return { workspaces, currentWorkspace, isSwitching, switchWorkspace, isLoading, hasLoaded };
}

interface WorkspaceMenuItemsProps {
  workspaces: ReturnType<typeof useWorkspaceSwitcher>["workspaces"];
  currentWorkspace: ReturnType<typeof useWorkspaceSwitcher>["currentWorkspace"];
  switchWorkspace: (uuid: string) => Promise<void>;
  isLoading?: boolean;
}

/** Workspace list + team actions, rendered inside an existing DropdownMenuContent. */
export function WorkspaceMenuItems({
  workspaces,
  currentWorkspace,
  switchWorkspace,
  isLoading: propIsLoading,
}: WorkspaceMenuItemsProps) {
  const { t } = useTranslation("workspace");
  const storeIsLoading = useWorkspacesStore((s) => s.isLoading);
  const hasLoaded = useWorkspacesStore((s) => s.hasLoaded);
  const token = useAuthStore((s) => s.token);
  const isLoading = propIsLoading ?? (storeIsLoading || !hasLoaded || (Boolean(token) && !currentWorkspace));

  return (
    <>
      <div className="flex items-center justify-between px-2.5 py-2 text-[11px] text-muted-foreground">
        <span>{t("switcher.workspaces")}</span>
        {isLoading && !workspaces.length ? (
          <LuLoaderCircle className="h-3 w-3 animate-spin text-muted-foreground" />
        ) : (
          <span>{workspaces.length}</span>
        )}
      </div>
      <div className="max-h-60 overflow-y-auto overscroll-contain">
        {isLoading && !workspaces.length ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <LuLoaderCircle className="h-4 w-4 animate-spin" />
          </div>
        ) : workspaces.length ? (
          workspaces.map((workspace) => (
            <DropdownMenuItem
              key={workspace.uuid}
              aria-label={workspace.name}
              aria-current={workspace.uuid === currentWorkspace?.uuid ? "true" : undefined}
              onSelect={() => void switchWorkspace(workspace.uuid)}
              className={cn("gap-2.5 rounded-lg p-2", workspace.uuid === currentWorkspace?.uuid && "bg-muted/60")}
            >
              <WorkspaceAvatar
                name={workspace.name}
                image={workspace.profile_picture}
                blurDataUrl={workspace.profile_picture_blur_data_url}
                className="h-8 w-8 text-[11px]"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{workspace.name}</span>
                <span className="mt-0.5 block text-[10px] capitalize text-muted-foreground">
                  {t(`roles.${workspace.user_role}`)} · {t("switcher.memberCount", { count: workspace.member_count })}
                </span>
              </span>
              {workspace.uuid === currentWorkspace?.uuid && <LuCheck className="text-muted-foreground" />}
            </DropdownMenuItem>
          ))
        ) : (
          <p className="px-2.5 py-3 text-xs text-muted-foreground">
            {t("switcher.noWorkspaces")}
          </p>
        )}
      </div>
    </>
  );
}

export default function WorkspaceSwitcher() {
  const { t } = useTranslation("workspace");
  const { workspaces, currentWorkspace, isSwitching, switchWorkspace, isLoading } = useWorkspaceSwitcher();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={t("switcher.switchWorkspaceAria")} disabled={isSwitching} className="group flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-border/60 bg-background p-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60">
          <WorkspaceAvatar name={currentWorkspace?.name || t("membersDialog.defaultWorkspaceName")} image={currentWorkspace?.profile_picture} blurDataUrl={currentWorkspace?.profile_picture_blur_data_url} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold">{currentWorkspace?.name || t("switcher.selectWorkspace")}</span>
            <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
              <LuUsers className="h-3 w-3" />
              {isSwitching ? t("switcher.switching") : currentWorkspace ? t("switcher.memberCount", { count: currentWorkspace.member_count }) : t("switcher.teamWorkspace")}
            </span>
          </span>
          <LuChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[240px] max-w-[calc(100vw-1rem)] rounded-xl p-1.5">
        <WorkspaceMenuItems
          workspaces={workspaces}
          currentWorkspace={currentWorkspace}
          switchWorkspace={switchWorkspace}
          isLoading={isLoading || isSwitching}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
