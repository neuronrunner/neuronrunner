"use client";

import { useTranslation } from "react-i18next";
import { LuCheck, LuChevronsUpDown, LuLoaderCircle, LuPlus } from "react-icons/lu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWorkspaceSwitcher } from "@/components/workspace/workspace-switcher";
import { WorkspaceAvatar } from "@/components/workspace/workspace-identity";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import useWorkspacesStore from "@/stores/workspaces";

export default function WorkspaceSelector() {
  const { t } = useTranslation("settings");
  const { workspaces, currentWorkspace, switchWorkspace, isSwitching, isLoading, hasLoaded } =
    useWorkspaceSwitcher();
  const isWorkspacesLoading = (isLoading || !hasLoaded) && !workspaces.length;

  const formatMemberSummary = (role: string, count: number) => {
    const localizedRole = t(`roles.${role}`, { defaultValue: role });
    return count === 1
      ? t("workspaceSelector.summarySingle", { role: localizedRole, count })
      : t("workspaceSelector.summaryPlural", { role: localizedRole, count });
  };

  return (
    <div className="mb-3 pb-3 border-b border-border/50 dark:border-white/10">
      <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {t("workspaceSelector.currentWorkspace")}
      </p>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("workspaceSelector.ariaLabel")}
            disabled={isSwitching || isLoading}
            className="group flex w-full min-w-0 items-center gap-2.5 rounded-xl border border-border/60 bg-background/60 p-2 text-left transition-all hover:bg-muted/60 hover:border-border dark:bg-white/[0.03] dark:hover:bg-white/[0.06] dark:border-white/10 dark:hover:border-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            <WorkspaceAvatar
              name={currentWorkspace?.name || t("workspaceSelector.fallbackName")}
              image={currentWorkspace?.profile_picture}
              blurDataUrl={currentWorkspace?.profile_picture_blur_data_url}
              className="h-7 w-7 rounded-lg text-[10px]"
            />
            <span className="min-w-0 flex-1">
              <span
                className="block truncate text-xs font-semibold tracking-tight text-foreground"
                title={currentWorkspace?.name}
              >
                {isLoading ? (
                  <Skeleton className="h-3.5 w-24 rounded" />
                ) : (
                  currentWorkspace?.name || t("workspaceSelector.selectWorkspace")
                )}
              </span>
              <span className="mt-0.5 block truncate text-[10px] capitalize text-muted-foreground">
                {isLoading ? (
                  <Skeleton className="h-2.5 w-16 rounded mt-1" />
                ) : isSwitching ? (
                  t("workspaceSelector.switching")
                ) : currentWorkspace ? (
                  formatMemberSummary(currentWorkspace.user_role, currentWorkspace.member_count)
                ) : (
                  t("workspaceSelector.chooseTeam")
                )}
              </span>
            </span>
            <LuChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-colors group-hover:text-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={6}
          className="z-[1300] w-[var(--radix-dropdown-menu-trigger-width)] min-w-[240px] max-w-[calc(100vw-2rem)] rounded-xl p-1.5 shadow-xl border border-border dark:border-white/10 bg-popover/95 backdrop-blur-md"
        >
          <div className="flex items-center justify-between px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            <span>{t("workspaceSelector.workspaces")}</span>
            {isWorkspacesLoading ? (
              <LuLoaderCircle className="h-3 w-3 animate-spin text-muted-foreground" />
            ) : (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium text-foreground">
                {workspaces.length}
              </span>
            )}
          </div>
          <div className="max-h-60 overflow-y-auto overscroll-contain space-y-0.5">
            {isWorkspacesLoading ? (
              <div className="flex items-center justify-center py-6 text-muted-foreground">
                <LuLoaderCircle className="h-4 w-4 animate-spin" />
              </div>
            ) : workspaces.length ? (
              workspaces.map((workspace) => (
                <DropdownMenuItem
                  key={workspace.uuid}
                  aria-label={workspace.name}
                  aria-current={
                    workspace.uuid === currentWorkspace?.uuid ? "true" : undefined
                  }
                  onSelect={() => void switchWorkspace(workspace.uuid)}
                  className={cn(
                    "gap-2.5 rounded-lg px-2.5 py-2 transition-colors cursor-pointer",
                    workspace.uuid === currentWorkspace?.uuid
                      ? "bg-primary/10 text-primary dark:bg-white/10 dark:text-white"
                      : "hover:bg-muted/60 dark:hover:bg-white/5",
                  )}
                >
                  <WorkspaceAvatar
                    name={workspace.name}
                    image={workspace.profile_picture}
                    blurDataUrl={workspace.profile_picture_blur_data_url}
                    className="h-7 w-7 rounded-lg text-[10px]"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold">
                      {workspace.name}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] capitalize text-muted-foreground">
                      {formatMemberSummary(workspace.user_role, workspace.member_count)}
                    </span>
                  </span>
                  {workspace.uuid === currentWorkspace?.uuid && (
                    <LuCheck className="h-3.5 w-3.5 text-primary dark:text-white shrink-0" />
                  )}
                </DropdownMenuItem>
              ))
            ) : (
              <p className="px-2.5 py-3 text-xs text-muted-foreground">
                {t("workspaceSelector.noWorkspaces")}
              </p>
            )}
          </div>
          <DropdownMenuSeparator className="mx-1 my-1.5" />
          <DropdownMenuItem
            onSelect={() => {
              useWorkspacesStore.getState().resetError();
              useWorkspacesStore.getState().setCreateDialogOpen(true);
            }}
            className="gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium cursor-pointer text-muted-foreground hover:text-foreground hover:bg-muted/60 dark:hover:bg-white/5 transition-colors"
          >
            <LuPlus className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span>{t("workspaceSelector.newWorkspace")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
