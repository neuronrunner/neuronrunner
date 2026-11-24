"use client";

import React, { useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  LuFolderCode,
  LuFolderOpen,
  LuGitBranch,
  LuGlobe,
  LuTerminal,
} from "react-icons/lu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import useWorkspaceTabsStore from "@/stores/workspace-tabs";
import { cn } from "@/lib/utils";
import frontendExtension from "@cloud";

interface WorkspaceHeaderToolbarProps {
  className?: string;
  animate?: boolean;
}

export function WorkspaceHeaderToolbar({
  className,
  animate = true,
}: WorkspaceHeaderToolbarProps) {
  const { t } = useTranslation("workspace");
  const {
    tabs,
    splitTabs,
    activeSplitTabId,
    isSplit,
    setActiveSplitTab,
    openFilesTab,
    openGitTab,
    openBrowserTab,
    openDesktopTab,
    openTerminalTab,
  } = useWorkspaceTabsStore();

  const lastTerminalId = useRef<string | null>(null);
  const rightPanelTab = splitTabs.find((item) => item.id === activeSplitTabId) || splitTabs[0];
  const showPanel = Boolean(isSplit && rightPanelTab && rightPanelTab.type !== "chat");

  const allTerminalTabs = [
    ...splitTabs.filter((t) => t.type === "terminal"),
    ...tabs.filter((t) => t.type === "terminal"),
  ];

  if (rightPanelTab?.type === "terminal") {
    lastTerminalId.current = rightPanelTab.id;
  }

  const openTerminal = () => {
    const existing = rightPanelTab?.type === "terminal"
      ? rightPanelTab
      : splitTabs.find((t) => t.type === "terminal" && t.id === lastTerminalId.current)
        || splitTabs.find((t) => t.type === "terminal");
    if (existing) {
      setActiveSplitTab(existing.id);
      useWorkspaceTabsStore.setState({ isSplit: true, focusedPane: "right" });
    } else {
      openTerminalTab(undefined, "right");
    }
  };

  const tools: Array<{
    label: string;
    title: string;
    Icon: React.ComponentType<{ className?: string }>;
    iconColor: string;
    action: () => unknown;
    badge?: number;
  }> = [
    {
      label: t("common.files"),
      title: t("common.files"),
      Icon: LuFolderOpen,
      iconColor: "text-indigo-400",
      action: () => openFilesTab(),
    },
    {
      label: t("common.git"),
      title: t("common.git"),
      Icon: LuGitBranch,
      iconColor: "text-amber-500",
      action: () => openGitTab(),
    },
    {
      label: t("common.browser"),
      title: t("common.browser"),
      Icon: LuGlobe,
      iconColor: "text-sky-500",
      action: () => openBrowserTab(),
    },
    ...frontendExtension.getWorkspaceToolbarActions({ openDesktopTab }).map((item) => ({
      label: t(item.labelKey as any) as string,
      title: t(item.labelKey as any) as string,
      Icon: item.icon,
      iconColor: item.iconColor,
      action: item.onClick,
      badge: undefined as number | undefined,
    })),
    {
      label: t("common.terminal"),
      title: t("common.terminal"),
      Icon: LuTerminal,
      iconColor: "text-emerald-500",
      action: openTerminal,
      badge: allTerminalTabs.length > 1 ? allTerminalTabs.length : undefined,
    },
  ];

  const ToolbarLeadingSlot = frontendExtension.WorkspaceToolbarLeading;

  return (
    <div
      className={cn(
        "flex shrink-0 items-center rounded-lg border border-border/40 bg-muted/40 p-0.5 shadow-2xs",
        animate && "chat-enter",
        className
      )}
      style={{ animationDelay: "100ms" }}
    >
      <ToolbarLeadingSlot />
      {!showPanel && (
        <>

          {/* Mobile view: Single compact Tools dropdown */}
          <div className="sm:hidden flex items-center">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("common.workspaceTools")}
                  title={t("common.workspaceTools")}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-all hover:bg-background/60 hover:text-foreground"
                >
                  <LuFolderCode className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
                  <span className="text-[11px] font-medium">{t("common.tools")}</span>
                  {allTerminalTabs.length > 1 && (
                    <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.2 text-[10px] font-semibold text-emerald-500">
                      {allTerminalTabs.length}
                    </span>
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                sideOffset={8}
                className="w-48 rounded-xl border border-border/70 bg-popover p-1.5 shadow-xl backdrop-blur-xl"
              >
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t("common.workspaceToolsTitle")}
                </div>
                <DropdownMenuSeparator className="my-1" />
                {tools.map(({ label, Icon, iconColor, action, badge }) => (
                  <DropdownMenuItem
                    key={label}
                    onClick={action}
                    className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium text-foreground hover:bg-muted focus:bg-muted"
                  >
                    <Icon className={cn("h-4 w-4 shrink-0", iconColor)} />
                    <span className="flex-1">{label}</span>
                    {badge !== undefined && (
                      <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.2 text-[10px] font-semibold text-emerald-500">
                        {badge}
                      </span>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Desktop view: Full horizontal tools list */}
          <div className="hidden sm:flex items-center">
            {tools.map(({ label, title, Icon, iconColor, action, badge }) => (
              <button
                key={label}
                type="button"
                aria-label={label}
                title={title}
                onClick={action}
                className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-all hover:bg-background/60 hover:text-foreground"
              >
                <Icon className={cn("h-3.5 w-3.5 shrink-0", iconColor)} />
                <span className="hidden md:inline">{label}</span>
                {badge !== undefined && (
                  <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.2 text-[10px] font-semibold text-emerald-500">
                    {badge}
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default WorkspaceHeaderToolbar;
