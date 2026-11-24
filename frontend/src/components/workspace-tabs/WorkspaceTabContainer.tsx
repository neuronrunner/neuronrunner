"use client";

import { lazyView } from "@/lib/lazy-view";
import React, { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { usePathname, isKnownRoute } from "@/lib/navigation";
import useNavbarStore from "@/stores/navbar";
import {
  LuArrowLeft,
  LuFileCode2,
  LuFolderOpen,
  LuGitBranch,
  LuGlobe,
  LuImage,
  LuLoaderCircle,
  LuMessageSquare,
  LuMonitor,
  LuPanelLeftOpen,
  LuPanelRightClose,
  LuPlus,
  LuServer,
  LuTerminal,
  LuX,
} from "react-icons/lu";
import ConversationTitleInput from "@/components/conversation-title-input";
import FadingText from "@/components/fading-text";
import { WorkspacePageHeader, WorkspacePageTitle } from "@/components/workspace-page-header";
import WorkspaceHeaderToolbar from "@/components/workspace-header-toolbar";
import { Button } from "@/components/ui/button";
import useChatStore from "@/stores/chat";
import useSidebarStore from "@/stores/sidebar";
import useSandboxProjectsStore from "@/stores/sandbox-projects";
import useWorkspacesStore from "@/stores/workspaces";
import useAuthStore from "@/stores/auth";
import useWorkspaceTabsStore, { detectFileType, IWorkspaceTab } from "@/stores/workspace-tabs";
import { cn } from "@/lib/utils";
import frontendExtension from "@cloud";

const LoadingView = () => (
  <div className="flex h-full min-h-[200px] flex-1 items-center justify-center">
    <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-400 border-t-transparent" />
  </div>
);

const CodeEditorView = lazyView(
  () => import("./views/CodeEditorTabView").then((m) => m.CodeEditorTabView),
  LoadingView
);
const XlsxEditorView = lazyView(
  () => import("./views/XlsxEditorTabView").then((m) => m.XlsxEditorTabView),
  LoadingView
);
const DocxEditorView = lazyView(
  () => import("./views/DocxEditorTabView").then((m) => m.DocxEditorTabView),
  LoadingView
);
const PdfEditorView = lazyView(
  () => import("./views/PdfEditorTabView").then((m) => m.PdfEditorTabView),
  LoadingView
);
const ImagePreviewView = lazyView(
  () => import("./views/ImagePreviewTabView").then((m) => m.ImagePreviewTabView),
  LoadingView
);
const FileSystemExplorer = lazyView(
  () => import("../extend/FileSystemExplorer").then((m) => m.FileSystemExplorer),
  LoadingView
);
const TerminalView = lazyView(
  () => import("./views/TerminalTabView").then((m) => m.TerminalTabView),
  LoadingView
);
const GitView = lazyView(() => import("./views/GitTabView").then((m) => m.GitTabView), LoadingView);
const BrowserView = lazyView(() => import("./views/BrowserTabView").then(m => m.BrowserTabView), LoadingView);

interface Props {
  children?: React.ReactNode;
}

const viewIcon = (view?: IWorkspaceTab) => {
  if (view?.type === "files") return LuFolderOpen;
  if (view?.type === "terminal") return LuTerminal;
  if (view?.type === "git") return LuGitBranch;
  if (view?.type === "browser") return LuGlobe;
  if (view?.type === "desktop") return LuMonitor;
  if (view && (view.type === "image" || detectFileType(view.filePath || view.title) === "image")) return LuImage;
  return LuFileCode2;
};

/** Keeps chat primary and hosts workspace tools in the classic right drawer. */
export const WorkspaceTabContainer: React.FC<Props> = ({ children }) => {
  const { t } = useTranslation("workspace");
  // Re-render (and reconnect terminals) when the selected runtime changes.
  frontendExtension.runtimeBridge.useRuntimeList();
  const pathname = usePathname() || "/";
  const conversationId = useChatStore((state) => state.conversationId);
  const {
    tabs,
    activeTabId,
    splitTabs,
    activeSplitTabId,
    isSplit,
    setActiveSplitTab,
    openFilesTab,
    openGitTab,
    openBrowserTab,
    openDesktopTab,
    openTerminalTab,
    closeTab,
    closeAllFileTabs,
    closeOtherFileTabs,
    closeFileTabsToRight,
    setActiveTab,
    pinTab,
  } = useWorkspaceTabsStore();
  const [fileMenu, setFileMenu] = React.useState<{ x: number; y: number; tabId: string } | null>(null);
  useEffect(() => {
    if (!fileMenu) return;
    const close = () => setFileMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [fileMenu]);
  const openFileTabCount = [...tabs, ...splitTabs].filter((tab) => tab.filePath).length;
  const {
    sidebarWidth,
    setSidebarWidth,
    isSidebarResizing,
    setSidebarResizing,
    currentSandbox,
    workspaceSandbox,
  } = useSandboxProjectsStore();
  const currentWorkspace = useWorkspacesStore((state) => state.currentWorkspace);
  const currentWorkspaceUuid = useWorkspacesStore(
    (state) => state.currentWorkspaceUuid,
  );
  const workspaceUuid = currentWorkspace?.uuid || currentWorkspaceUuid;
  const { isOpen: isSidebarOpen, toggle: toggleSidebar } = useSidebarStore();

  const isChatRoute = pathname === "/new" || pathname === "/chat" || pathname.startsWith("/chat/");
  const isPullRequestsRoute = pathname.startsWith("/pull-requests");
  const isIssuesRoute = pathname.startsWith("/issues");
  const isIntegrationsRoute = pathname.startsWith("/integrations");
  const isPanelRoute = isChatRoute || isPullRequestsRoute || isIssuesRoute;
  const match = pathname.match(/^\/chat\/([a-zA-Z0-9_-]+)/);
  const conversationUuidFromRoute = match ? match[1] : undefined;
  const activeConversationId = conversationUuidFromRoute || (isChatRoute ? conversationId : undefined);
  const isNewRoute = !conversationUuidFromRoute || conversationUuidFromRoute === "new" || pathname === "/new" || pathname === "/chat";
  const hasActiveConversation = !isNewRoute && Boolean(activeConversationId && activeConversationId !== "new");

  const rightPanelTab = splitTabs.find((item) => item.id === activeSplitTabId) || splitTabs[0];
  const activePrimaryTab = tabs.find((item) => item.id === activeTabId) || tabs[0];
  const isFileTab = Boolean(
    activePrimaryTab && !["chat", "files", "terminal", "git", "browser", "desktop"].includes(activePrimaryTab.type)
  );
  const primaryFileTab = isPanelRoute && isFileTab ? activePrimaryTab : undefined;
  const panelOpen = Boolean(isSplit && rightPanelTab && rightPanelTab.type !== "chat");
  const showPanel = isPanelRoute && panelOpen;
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);
  const isLoggedIn = Boolean(user && token);
  const showWorkspaceHeader = isLoggedIn && (isChatRoute || Boolean(primaryFileTab));
  const ActiveIcon = viewIcon(rightPanelTab);
  const [panelEntered, setPanelEntered] = React.useState(false);
  const lastTerminalId = React.useRef<string | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const prevPathnameRef = React.useRef<string | null>(null);
  useEffect(() => {
    if (prevPathnameRef.current !== pathname) {
      if (pathname.startsWith("/pull-requests") || pathname.startsWith("/issues") || isIntegrationsRoute) {
        const { tabs: currentTabs, activeTabId: currentActiveId, setActiveTab } = useWorkspaceTabsStore.getState();
        const activeTab = currentTabs.find((t) => t.id === currentActiveId);
        if (activeTab && !["chat", "files", "terminal", "git", "browser", "desktop"].includes(activeTab.type)) {
          const chatTab = currentTabs.find((t) => t.type === "chat");
          if (chatTab) {
            setActiveTab(chatTab.id);
          }
        }
      }
      prevPathnameRef.current = pathname;
    }
  }, [pathname, isIntegrationsRoute]);

  useEffect(() => {
    if (rightPanelTab?.type === "terminal") lastTerminalId.current = rightPanelTab.id;
  }, [rightPanelTab?.id, rightPanelTab?.type]);

  useEffect(() => {
    if (!showPanel) {
      setPanelEntered(false);
    }
  }, [showPanel]);

  useEffect(() => {
    if (isSidebarResizing && !panelEntered) {
      setPanelEntered(true);
    }
  }, [isSidebarResizing, panelEntered]);

  useEffect(() => {
    if (!isSidebarResizing) return;

    const handlePointerMove = (event: PointerEvent) => {
      const containerWidth = containerRef.current?.clientWidth || window.innerWidth;
      const nextWidth = window.innerWidth - event.clientX;
      const maxWidth = Math.min(560, Math.floor(containerWidth * 0.5));
      setSidebarWidth(Math.max(320, Math.min(nextWidth, Math.max(320, maxWidth))));
    };
    const handlePointerUp = () => setSidebarResizing(false);

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [isSidebarResizing, setSidebarResizing, setSidebarWidth]);

  const closeRightPanel = () => {
    useWorkspaceTabsStore.setState({ isSplit: false, focusedPane: "left" });
  };

  // Responsive auto-collapse when screen narrows:
  // First closes the right panel (< 1024px), then closes the left sidebar (< 768px)
  const prevWidthRef = React.useRef(typeof window !== "undefined" ? window.innerWidth : 1440);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;

    // Check initial widths on mount
    if (window.innerWidth < 1024) {
      const state = useWorkspaceTabsStore.getState();
      if (state.isSplit) {
        useWorkspaceTabsStore.setState({ isSplit: false, focusedPane: "left" });
      }
    }
    if (window.innerWidth < 768) {
      const state = useSidebarStore.getState();
      if (state.isOpen) {
        state.setOpen(false);
      }
    }

    const handleResize = () => {
      const currentWidth = window.innerWidth;
      const prevWidth = prevWidthRef.current;

      // 1. Ekran daralırken önce sağ sayfayı kapat (< 1024px)
      if (currentWidth < 1024 && prevWidth >= 1024) {
        const state = useWorkspaceTabsStore.getState();
        if (state.isSplit) {
          useWorkspaceTabsStore.setState({ isSplit: false, focusedPane: "left" });
        }
      }

      // 2. Ekran daha da daralınca sol sayfayı (sidebar) kapat (< 768px)
      if (currentWidth < 768 && prevWidth >= 768) {
        const state = useSidebarStore.getState();
        if (state.isOpen) {
          state.setOpen(false);
        }
      }

      prevWidthRef.current = currentWidth;
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const allTerminalTabs = [
    ...splitTabs.filter((t) => t.type === "terminal"),
    ...tabs.filter((t) => t.type === "terminal"),
  ];

  const renderView = (view?: IWorkspaceTab) => {
    if (!view || ["chat", "terminal", "files", "git", "browser", "desktop"].includes(view.type)) return null;
    if (view.type === "image" || detectFileType(view.filePath || view.title) === "image") return <ImagePreviewView key={view.id} tab={view} />;
    if (view.type === "excel") return <XlsxEditorView key={view.id} tab={view} />;
    if (view.type === "docx") return <DocxEditorView key={view.id} tab={view} />;
    if (view.type === "pdf") return <PdfEditorView key={view.id} tab={view} />;
    return <CodeEditorView key={view.id} tab={view} />;
  };

  const openFiles = () => openFilesTab();

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

  const isNotFound = useNavbarStore((state) => state.isNotFound);
  const is404 = isNotFound || !isKnownRoute(pathname);
  const isWorkspace =
    isChatRoute ||
    isPullRequestsRoute ||
    isIssuesRoute ||
    isIntegrationsRoute ||
    pathname.startsWith("/projects/");

  if (!isLoggedIn || is404 || !isWorkspace) {
    return <>{children}</>;
  }

  return (
    <div ref={containerRef} className="workspace-screen relative flex h-full min-h-0 w-full flex-1 overflow-hidden bg-background select-text">
      <div className="relative min-w-0 flex-1 overflow-hidden">
        {showWorkspaceHeader && (
          <WorkspacePageHeader
            className="absolute inset-x-0 top-0 z-40"
            actions={<WorkspaceHeaderToolbar animate={isChatRoute && !primaryFileTab} />}
          >
            <div className="flex min-w-0 flex-1 items-center">
              {!isSidebarOpen && (
                <button
                  type="button"
                  aria-label={t("tabContainer.openSidebarAria")}
                  title={t("tabContainer.openSidebarTitle")}
                  onClick={toggleSidebar}
                  className="mr-2 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <LuPanelLeftOpen className="h-5 w-5" />
                </button>
              )}
              {(isPullRequestsRoute || isIssuesRoute) && primaryFileTab && (
                <button
                  type="button"
                  onClick={() => {
                    const store = useWorkspaceTabsStore.getState();
                    const chatTab = store.tabs.find((t) => t.type === "chat");
                    if (chatTab) {
                      store.setActiveTab(chatTab.id);
                    }
                  }}
                  className="mr-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  title={isIssuesRoute ? t("tabContainer.backToIssues") : t("tabContainer.backToPullRequests")}
                >
                  <LuArrowLeft className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{isIssuesRoute ? t("tabContainer.issues") : t("tabContainer.pullRequests")}</span>
                </button>
              )}
              {primaryFileTab ? (
                <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" role="tablist">
                  {tabs.filter((tab) => tab.filePath).map((tab) => {
                    const active = tab.id === primaryFileTab.id;
                    return (
                      <div
                        key={tab.id}
                        role="tab"
                        aria-selected={active}
                        title={tab.filePath}
                        onClick={() => setActiveTab(tab.id)}
                        onDoubleClick={() => pinTab(tab.id)}
                        onAuxClick={(e) => {
                          if (e.button === 1) {
                            e.preventDefault();
                            closeTab(tab.id);
                          }
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setFileMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
                        }}
                        className={cn(
                          "group flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs transition-colors",
                          active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                        )}
                      >
                        {React.createElement(viewIcon(tab), { className: "h-3.5 w-3.5 shrink-0" })}
                        <span className={cn("max-w-[160px] truncate", tab.isPreview && "italic")}>{tab.title}</span>
                        {tab.isDirty ? <span className="text-amber-400">•</span> : null}
                        <button
                          type="button"
                          aria-label={t("tabContainer.closeFile")}
                          onClick={(e) => {
                            e.stopPropagation();
                            closeTab(tab.id);
                          }}
                          className="inline-flex h-4 w-4 items-center justify-center rounded text-muted-foreground opacity-60 hover:bg-background hover:opacity-100 group-hover:opacity-100"
                        >
                          <LuX className="h-3 w-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : hasActiveConversation ? (
                <WorkspacePageTitle icon={LuMessageSquare}>
                  <ConversationTitleInput variant="workspace" />
                </WorkspacePageTitle>
              ) : isChatRoute ? (
                <WorkspacePageTitle icon={LuMessageSquare}>
                  <FadingText text={t("tabContainer.newConversation")} className="block px-1 text-sm font-semibold leading-none tracking-[-0.01em] text-foreground/80" />
                </WorkspacePageTitle>
              ) : null}
            </div>
          </WorkspacePageHeader>
        )}

        <div className={cn("h-full min-h-0", showWorkspaceHeader && "pt-11")}>
          <div className={cn("h-full min-h-0", primaryFileTab && "hidden")}>
            {children}
          </div>
          {primaryFileTab && (
            <div className="h-full min-h-0 overflow-hidden">
              {renderView(primaryFileTab)}
            </div>
          )}
        </div>
      </div>

      {fileMenu && (
        <div
          role="menu"
          style={{ left: fileMenu.x, top: fileMenu.y }}
          className="fixed z-50 min-w-[200px] rounded-md border border-border bg-popover p-1 text-xs text-popover-foreground shadow-md"
          onClick={(e) => e.stopPropagation()}
        >
          {[
            { key: "closeFile", label: t("tabContainer.closeFile"), run: () => closeTab(fileMenu.tabId) },
            { key: "closeOthers", label: t("tabContainer.closeOthers"), run: () => closeOtherFileTabs(fileMenu.tabId) },
            { key: "closeToRight", label: t("tabContainer.closeToRight"), run: () => closeFileTabsToRight(fileMenu.tabId) },
            { key: "closeAllFilesMenu", label: t("tabContainer.closeAllFilesMenu"), run: closeAllFileTabs },
          ].map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              onClick={() => {
                item.run();
                setFileMenu(null);
              }}
              className="flex w-full items-center rounded px-2 py-1.5 text-left hover:bg-muted"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      {showPanel && (
        <div
          onClick={closeRightPanel}
          className="fixed inset-0 bg-black/60 z-40 lg:hidden backdrop-blur-sm"
          aria-hidden="true"
        />
      )}

      {rightPanelTab && (
        <aside
          aria-label={t("tabContainer.panelAria", {
            title: rightPanelTab.type === "terminal" ? t("common.terminal") : rightPanelTab.title || t("common.tools"),
          })}
          onAnimationEnd={() => setPanelEntered(true)}
          style={{ "--workspace-panel-width": `${sidebarWidth}px` } as React.CSSProperties}
          className={cn(
            "workspace-right-panel fixed inset-y-0 right-0 z-50 flex w-full shrink-0 flex-col overflow-hidden border-l border-border/40 bg-background shadow-2xl lg:shadow-none",
            "sm:w-[min(90vw,480px)] lg:relative lg:inset-auto lg:z-30 lg:w-[var(--workspace-panel-width)] lg:max-w-[50%]",
            !panelEntered && !isSidebarResizing && "workspace-right-panel--entering",
            isSidebarResizing && "workspace-right-panel--resizing",
            !showPanel && "hidden"
          )}
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("tabContainer.resizeRightPanelAria")}
            onPointerDown={(event) => {
              event.preventDefault();
              setSidebarResizing(true);
            }}
            className={cn(
              "absolute inset-y-0 -left-1 z-50 hidden w-2 cursor-col-resize lg:block",
              "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors hover:after:bg-primary/70",
              isSidebarResizing && "after:bg-primary"
            )}
          />

          <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/40 bg-background/80 px-3 backdrop-blur-xl sm:px-4">
            <button
              type="button"
              aria-label={t("tabContainer.closeRightPanelAria")}
              title={t("tabContainer.closePanelTitle")}
              onClick={closeRightPanel}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <LuPanelRightClose className="h-5 w-5" />
            </button>

            <div className="flex min-w-0 flex-1 items-center gap-2.5 px-1">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40 text-muted-foreground">
                <ActiveIcon className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold leading-none tracking-[-0.01em] text-foreground">
                  {rightPanelTab.type === "terminal" ? t("common.terminal") : rightPanelTab.title || t("common.tools")}
                  {rightPanelTab.isDirty ? <span className="ml-1 text-amber-400">•</span> : null}
                </div>
              </div>
            </div>

            <div role="group" aria-label={t("common.workspaceTools")} className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border/50 bg-muted/30 p-0.5">
              {[
                { type: "files", label: t("common.files"), Icon: LuFolderOpen, onClick: openFiles },
                { type: "git", label: t("common.git"), Icon: LuGitBranch, onClick: () => openGitTab() },
                { type: "browser", label: t("common.browser"), Icon: LuGlobe, onClick: () => openBrowserTab() },
                { type: "terminal", label: t("common.terminal"), Icon: LuTerminal, onClick: openTerminal },
              ].map(({ type, label, Icon, onClick }) => (
                <button
                  key={type}
                  type="button"
                  title={label}
                  aria-label={label}
                  aria-pressed={rightPanelTab.type === type}
                  onClick={onClick}
                  className={cn(
                    "workspace-tool-icon-button relative",
                    rightPanelTab.type === type && "bg-background text-foreground shadow-sm"
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {type === "terminal" && allTerminalTabs.length > 1 && (
                    <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border border-background bg-muted px-0.5 text-[9px] font-medium text-foreground">
                      {allTerminalTabs.length}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </header>

          <div className="relative min-h-0 flex-1 overflow-hidden">
            {(() => {
              const activeSandboxUuid = currentSandbox?.uuid || workspaceSandbox?.uuid || "sandbox";
              const sandboxInstanceKey = `${activeSandboxUuid}:${workspaceSandbox?.sandbox_object_id || ""}`;
              return (
                <>
                  <div className={cn("w-full h-full min-h-0", rightPanelTab.type === "files" ? "block" : "hidden")}>
                    {rightPanelTab.type === "files" && <FileSystemExplorer key={sandboxInstanceKey} />}
                  </div>

                  {rightPanelTab.type === "git" && <GitView key={sandboxInstanceKey} />}
                  <div className={cn("h-full w-full min-h-0", rightPanelTab.type === "browser" ? "block" : "hidden")}>
                    {splitTabs.some((tab) => tab.type === "browser") && (
                      <BrowserView key={sandboxInstanceKey} isActive={rightPanelTab.type === "browser" && showPanel} />
                    )}
                  </div>
                  {rightPanelTab.type === "desktop" && (
                    <div className="h-full w-full min-h-0">
                      <frontendExtension.DesktopTabPanel sandboxUuid={activeSandboxUuid} />
                    </div>
                  )}
                  {!["terminal", "files", "git", "browser", "desktop"].includes(rightPanelTab.type) && renderView(rightPanelTab)}

                    {allTerminalTabs.map((termTab) => {
                      const isTabActive = rightPanelTab.type === "terminal" && rightPanelTab.id === termTab.id;
                      const selectedRuntimeUuid = frontendExtension.runtimeBridge.getSelectedRuntimeUuid();
                      return (
                        <div
                          key={termTab.id}
                          className={cn(
                            "w-full h-full min-h-0 flex-col",
                            isTabActive ? "flex" : "hidden"
                          )}
                        >
                          <TerminalView
                            key={`${termTab.id}:${sandboxInstanceKey}`}
                            tab={termTab}
                            pane="right"
                            isActive={isTabActive && showPanel}
                            vmUuid={selectedRuntimeUuid}
                            vmConnected={true}
                          />
                        </div>
                      );
                    })}
                  </>
                );
              })()}
          </div>
        </aside>
      )}
    </div>
  );
};

export default WorkspaceTabContainer;
