"use client";

import React, { useEffect, useRef, useState, memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toaster } from "@/components/ui/toaster";
import {
  LuX,
  LuTrash2,
  LuPencil,
  LuCheck,
  LuPanelLeftClose,
  LuPlus,
  LuEllipsis,
  LuBox,
  LuChevronRight,
  LuFolderPlus,
  LuFolderMinus,
  LuFolderCode,
  LuCircleDot,
  LuGitPullRequest,
  LuPlug,
  LuPin,
  LuServer,
  LuLoader as LuLoader2,
} from "react-icons/lu";
import { useRouter, usePathname } from "@/lib/navigation";
import { useTheme } from "next-themes";
import useSidebarStore, { DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH } from "../stores/sidebar";
import useChatStore from "@/stores/chat";
import useAuthStore from "@/stores/auth";
import { Link } from "react-router-dom";
import SidebarAvatar from "./sidebar-avatar";
import useSandboxProjectsStore, { type IProject } from "@/stores/sandbox-projects";
import useWorkspaceTabsStore from "@/stores/workspace-tabs";
import { cn } from "@/lib/utils";
import NeuronLogo from "@/components/neuron-logo";
import { prepareConversationTransition, prepareNewChatTransition } from "@/lib/prompt-transition";
import CreateWorkspaceDialog from "@/components/workspace/create-workspace-dialog";
import ManageWorkspaceMembersDialog from "@/components/workspace/manage-members-dialog";
import WorkspaceSandboxSettingsDialog from "@/components/workspace/sandbox-settings-dialog";
import CreateProjectDialog from "@/components/projects/create-project-dialog";
import EditProjectDialog from "@/components/projects/edit-project-dialog";
import RemoveProjectDialog from "@/components/projects/remove-project-dialog";
import useWorkspacesStore from "@/stores/workspaces";
import frontendExtension from "@cloud";
import useSigninStore from "@/stores/signin";
import AnimatedCollapse from "@/components/chat/animated-collapse";

interface SidebarProps {
  hideOverlay?: boolean;
  offsetTop?: number;
}

interface Conversation {
  uuid: string;
  title: string;
  can_edit?: boolean;
}

interface SidebarItemProps {
  conversation: Conversation;
  isActive: boolean;
  isEditing: boolean;
  isGenerating?: boolean;
  editTitle: string;
  setEditTitle: (title: string) => void;
  onStartEdit: (e: React.MouseEvent, uuid: string, title: string) => void;
  onSaveEdit: (e: React.MouseEvent) => void;
  onCancelEdit: () => void;
  onDelete: (e: React.MouseEvent, uuid: string) => void;
  onNavigate: (uuid: string) => void;
  onAddToProject?: (e: React.MouseEvent, uuid: string) => void;
  onRemoveFromProject?: (e: React.MouseEvent, uuid: string) => void;
  isInsideProject?: boolean;
  className?: string;
}

const SidebarItem = memo(({
  conversation,
  isActive,
  isEditing,
  isGenerating,
  editTitle,
  setEditTitle,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  onNavigate,
  onAddToProject,
  onRemoveFromProject,
  isInsideProject,
  className,
}: SidebarItemProps) => {
  const { t } = useTranslation("chat");

  return (
    <div className={cn("relative group/item", className)}>
      {isEditing ? (
        <div className="flex items-center gap-1.5 px-1 h-8.5 sm:h-9">
          <Input
            className="h-8 text-sm px-2.5"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSaveEdit(e as unknown as React.MouseEvent);
              if (e.key === "Escape") onCancelEdit();
            }}
            autoFocus
          />
          <button
            type="button"
            aria-label={t("sidebar.save")}
            onClick={onSaveEdit}
            className="h-7 w-7 inline-flex items-center justify-center rounded text-emerald-500 hover:bg-emerald-500/10 transition-colors shrink-0"
          >
            <LuCheck className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={t("sidebar.cancel")}
            onClick={onCancelEdit}
            className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-muted transition-colors shrink-0"
          >
            <LuX className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div
          className={cn(
            "flex items-center h-8.5 sm:h-9 rounded-lg transition-colors px-1.5",
            isActive
              ? "bg-accent text-accent-foreground font-semibold"
              : "hover:bg-muted/60 text-foreground"
          )}
        >
          <button
            type="button"
            onClick={() => onNavigate(conversation.uuid)}
            className="flex-1 min-w-0 text-left px-1.5 text-sm truncate"
          >
            {conversation.title || t("conversation.untitled")}
          </button>

          {isGenerating && (
            <span
              className="shrink-0 flex items-center justify-center mr-1 text-muted-foreground"
              title={t("sidebar.generating")}
            >
              <LuLoader2 className="h-3.5 w-3.5 anim-spin-slow text-muted-foreground" />
            </span>
          )}

          {!isGenerating && (
            <div className="opacity-0 group-hover/item:opacity-100 transition-opacity mr-1 shrink-0">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("sidebar.moreActions")}
                    className="h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  >
                    <LuEllipsis className="h-4 w-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {onAddToProject && (
                    <DropdownMenuItem
                      onClick={(e) => onAddToProject(e as unknown as React.MouseEvent, conversation.uuid)}
                    >
                      <LuFolderPlus className="h-4 w-4 mr-2" />
                      {t("sidebar.addToProject")}
                    </DropdownMenuItem>
                  )}
                  {isInsideProject && onRemoveFromProject && (
                    <DropdownMenuItem
                      onClick={(e) => onRemoveFromProject(e as unknown as React.MouseEvent, conversation.uuid)}
                    >
                      <LuFolderMinus className="h-4 w-4 mr-2" />
                      {t("sidebar.removeFromProject")}
                    </DropdownMenuItem>
                  )}
                  {conversation.can_edit !== false && (
                    <>
                      <DropdownMenuItem
                        onClick={(e) =>
                          onStartEdit(
                            e as unknown as React.MouseEvent,
                            conversation.uuid,
                            conversation.title
                          )
                        }
                      >
                        <LuPencil className="h-4 w-4 mr-2" />
                        {t("sidebar.rename")}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={(e) =>
                          onDelete(e as unknown as React.MouseEvent, conversation.uuid)
                        }
                        className="text-red-500 focus:text-red-500"
                      >
                        <LuTrash2 className="h-4 w-4 mr-2" />
                        {t("sidebar.delete")}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

SidebarItem.displayName = "SidebarItem";

const Sidebar = ({ hideOverlay = false, offsetTop = 0 }: SidebarProps) => {
  const { t } = useTranslation("chat");
  const router = useRouter();
  const pathname = usePathname();
  const { resolvedTheme } = useTheme();
  const isLight = resolvedTheme === "light";

  const {
    isOpen,
    toggle,
    setOpen,
    conversations,
    projectConversations: cachedProjectConversations,
    generalConversations,
    generalHistoryProjectId,
    fetchConversations,
    fetchGeneralConversations,
    isHistoryLoading: isLoading,
    isHistoryLoadingMore: isLoadingMore,
    historyHasMore: hasMore,
    renameConversation,
    deleteConversation,
    avatarExpanded,
    toggleAvatar,
  } = useSidebarStore();

  const width = useSidebarStore((state) => state.width) || DEFAULT_SIDEBAR_WIDTH;
  const setWidth = useSidebarStore((state) => state.setWidth);
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.style.setProperty("--app-sidebar-width", `${width}px`);
    }
  }, [width]);

  const isResizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isResizingRef.current = true;
    setIsResizing(true);
    startXRef.current = e.clientX;
    startWidthRef.current = width;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handleMouseMove = (event: MouseEvent) => {
      if (!isResizingRef.current) return;
      const delta = event.clientX - startXRef.current;
      const newWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, startWidthRef.current + delta));
      document.documentElement.style.setProperty("--app-sidebar-width", `${newWidth}px`);
      setWidth(newWidth);
    };

    const handleMouseUp = () => {
      if (!isResizingRef.current) return;
      isResizingRef.current = false;
      setIsResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }, [width, setWidth]);

  const handleResetWidth = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setWidth(DEFAULT_SIDEBAR_WIDTH);
    if (typeof document !== "undefined") {
      document.documentElement.style.setProperty("--app-sidebar-width", `${DEFAULT_SIDEBAR_WIDTH}px`);
    }
  }, [setWidth]);

  const closeSidebarOnMobile = useCallback(() => {
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      setOpen(false);
    }
  }, [setOpen]);

  const { conversationId, setChatMode } = useChatStore();
  const generatingConversations = useChatStore((state) => state.generatingConversations) || {};
  const { user } = useAuthStore();
  const userId = user?.uuid;
  const {
    workspaceSandbox,
    sandboxes,
    sandboxConversations,
    ensureSandboxes,
    pickSandbox,
    linkConversationToSandbox,
    updateSandbox,
    setCreateProjectDialogOpen,
  } = useSandboxProjectsStore();
  const isSandboxesLoading = useSandboxProjectsStore((state) => state.isLoading);
  const sandboxesLoadedFor = useSandboxProjectsStore((state) => state.sandboxesLoadedFor);
  const { currentWorkspace, fetchWorkspaces } = useWorkspacesStore();
  const isWorkspacesLoading = useWorkspacesStore((state) => state.isLoading);
  const [isInitialLoading, setIsInitialLoading] = useState(true);

  const isProjectsLoading = Boolean(userId) && (isInitialLoading || isSandboxesLoading || isWorkspacesLoading || !sandboxesLoadedFor);
  const isHistorySectionLoading = Boolean(userId) && (isInitialLoading || isLoading || isProjectsLoading);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [isAddToProjectOpen, setIsAddToProjectOpen] = useState(false);
  const [removeProjectTarget, setRemoveProjectTarget] = useState<IProject | null>(null);
  const [editProjectTarget, setEditProjectTarget] = useState<IProject | null>(null);
  const [selectedConvIdForProject, setSelectedConvIdForProject] = useState<string | null>(null);
  const lastExpandedConvRef = useRef<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)
        ) {
          return;
        }
        e.preventDefault();
        toggle();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggle]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    const handleResize = () => {
      if (window.innerWidth < 768 && useSidebarStore.getState().isOpen) {
        setOpen(false);
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [setOpen]);

  const workspaceProjects = useMemo(() => {
    return (sandboxes || []).filter((project) => project.workspace_uuid === currentWorkspace?.uuid);
  }, [sandboxes, currentWorkspace?.uuid]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const isHomeRoute = pathname === "/new" || pathname === "/";
  const isChatRoute = pathname.startsWith("/chat");

  const activePrimaryTab = useWorkspaceTabsStore((state) =>
    state.tabs.find((t) => t.id === state.activeTabId)
  );
  const activeTab = useWorkspaceTabsStore((state) =>
    state.tabs.find((t) => t.id === state.activeTabId) ||
    state.splitTabs.find((t) => t.id === state.activeSplitTabId)
  );
  const isFileActive = Boolean(
    (activePrimaryTab && !["chat", "files", "terminal"].includes(activePrimaryTab.type)) ||
    (activeTab && !["chat", "files", "terminal"].includes(activeTab.type))
  );
  const isNewChatActive =
    !isFileActive &&
    isHomeRoute &&
    (!activeTab || (activeTab.type === "chat" && !activeTab.conversationUuid));

  useEffect(() => {
    let cancelled = false;
    if (isOpen && userId) {
      setIsInitialLoading(true);
      const loadWorkspaceProjects = async () => {
        try {
          let workspace = useWorkspacesStore.getState().currentWorkspace;
          if (!workspace) {
            await fetchWorkspaces();
            workspace = useWorkspacesStore.getState().currentWorkspace;
          }
          if (!workspace || cancelled) return;
          void frontendExtension.runtimeBridge.fetchRuntimes(workspace.uuid);
          const projects = await ensureSandboxes(workspace.uuid);
          if (cancelled || useWorkspacesStore.getState().currentWorkspace?.uuid !== workspace.uuid) return;
          const state = useSandboxProjectsStore.getState();
          const activeProject = projects.find((project) => project.uuid === state.currentSandbox?.uuid);
          if (state.workspaceSandbox?.workspace_uuid === workspace.uuid) {
            await fetchGeneralConversations(false, state.workspaceSandbox.uuid);
          } else {
            useSidebarStore.getState().historyAbortController?.abort();
            useSidebarStore.setState({ generalConversations: [], generalHistoryProjectId: null, historyHasMore: false });
          }
          if (!cancelled && activeProject && useWorkspacesStore.getState().currentWorkspace?.uuid === workspace.uuid) {
            await fetchConversations(false, activeProject.uuid);
          }
        } finally {
          if (!cancelled) {
            setIsInitialLoading(false);
          }
        }
      };
      void loadWorkspaceProjects();
    }
    return () => { cancelled = true; };
  }, [isOpen, userId, currentWorkspace?.uuid, fetchConversations, fetchGeneralConversations, ensureSandboxes, fetchWorkspaces]);

  const handleScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container || isLoading || isLoadingMore || !hasMore) return;

    const threshold = 120;
    const reachedBottom =
      container.scrollTop + container.clientHeight >=
      container.scrollHeight - threshold;
    if (reachedBottom) {
      if (workspaceSandbox && workspaceSandbox.workspace_uuid === currentWorkspace?.uuid) {
        void fetchGeneralConversations(true, workspaceSandbox.uuid);
      }
    }
  }, [isLoading, isLoadingMore, hasMore, fetchGeneralConversations, currentWorkspace?.uuid, workspaceSandbox]);

  const onScroll = useCallback(() => {
    window.requestAnimationFrame(() => {
      handleScroll();
    });
  }, [handleScroll]);

  const handleStartEdit = useCallback((e: React.MouseEvent, uuid: string, title: string) => {
    e.stopPropagation();
    setEditingId(uuid);
    setEditTitle(title || "");
  }, []);

  const handleSaveEdit = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (editingId && editTitle.trim()) {
      await renameConversation(editingId, editTitle.trim());
    }
    setEditingId(null);
  }, [editingId, editTitle, renameConversation]);

  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
    setEditTitle("");
  }, []);

  const handleDelete = useCallback(async (e: React.MouseEvent, uuid: string) => {
    e.stopPropagation();
    const confirmed = window.confirm(t("sidebar.confirmDeleteChat"));
    if (!confirmed) return;

    await deleteConversation(uuid);
    if (conversationId === uuid) {
      router.push("/new");
    }
  }, [conversationId, deleteConversation, router, t]);

  const handleNavigate = useCallback((uuid: string) => {
    if (conversationId !== uuid || !isChatRoute || isFileActive) {
      if (typeof document !== "undefined" && isHomeRoute) {
        document.body.classList.remove("nav-from-chat", "nav-from-home");
        prepareConversationTransition(uuid);
      }
      const targetConv = [...conversations, ...generalConversations, ...Object.values(cachedProjectConversations).flat()].find((c) => c.uuid === uuid);
      setChatMode("chat");
      useWorkspaceTabsStore.getState().openChatTab(uuid, targetConv?.title);
      useChatStore.getState().switchConversation(uuid);
      router.push(`/chat/${uuid}`);
      closeSidebarOnMobile();
    }
  }, [conversationId, isChatRoute, router, isHomeRoute, setChatMode, closeSidebarOnMobile, conversations, generalConversations, cachedProjectConversations, isFileActive]);

  const toggleProjectExpand = useCallback((uuid: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!expandedProjects[uuid]) void fetchConversations(false, uuid);
    setExpandedProjects((prev) => ({
      ...prev,
      [uuid]: !prev[uuid],
    }));
  }, [expandedProjects, fetchConversations]);

  const handleProjectHeaderClick = useCallback(async (project: IProject) => {
    await pickSandbox(project.uuid);
    await fetchConversations(false, project.uuid);
    router.push(`/projects/${project.slug}`);
    closeSidebarOnMobile();
  }, [pickSandbox, fetchConversations, router, closeSidebarOnMobile]);

  const handleOpenAddToProject = useCallback((convUuid: string) => {
    setSelectedConvIdForProject(convUuid);
    setIsAddToProjectOpen(true);
  }, []);

  const handleConfirmAddToProject = useCallback(async (projectUuid: string) => {
    if (!selectedConvIdForProject) return;
    linkConversationToSandbox(projectUuid, selectedConvIdForProject);
    await updateSandbox(projectUuid, { conversation: selectedConvIdForProject });
    await fetchConversations(false, projectUuid);
    if (workspaceSandbox) await fetchGeneralConversations(false, workspaceSandbox.uuid);
    const targetProject = sandboxes.find((s) => s.uuid === projectUuid);
    toaster.create({
      title: t("sidebar.addedToProjectTitle"),
      description: t("sidebar.addedToProjectDescription", { name: targetProject?.display_name || t("sidebar.defaultProjectName") }),
      type: "success",
    });
    setIsAddToProjectOpen(false);
    setSelectedConvIdForProject(null);
  }, [selectedConvIdForProject, linkConversationToSandbox, updateSandbox, sandboxes, fetchConversations, fetchGeneralConversations, workspaceSandbox, t]);

  const handleRemoveFromProject = useCallback(async (convUuid: string, projectUuid: string) => {
    const store = useSandboxProjectsStore.getState();
    const currentList = store.sandboxConversations[projectUuid] || [];
    const updated = currentList.filter((id) => id !== convUuid);
    useSandboxProjectsStore.setState({
      sandboxConversations: {
        ...store.sandboxConversations,
        [projectUuid]: updated,
      },
    });
    await store.updateSandbox(projectUuid, { remove_conversation: convUuid });
    await fetchConversations(false, projectUuid);
    if (store.workspaceSandbox) await fetchGeneralConversations(false, store.workspaceSandbox.uuid);
    toaster.create({
      title: t("sidebar.removedFromProjectTitle"),
      description: t("sidebar.removedFromProjectDescription"),
      type: "info",
    });
  }, [fetchConversations, fetchGeneralConversations, t]);

  const projectConversationMap = useMemo(() => {
    const map: Record<string, string[]> = {};
    workspaceProjects.forEach((s) => {
      const set = new Set<string>();
      if (s.conversation) {
        set.add(s.conversation);
      }
      const list = (sandboxConversations || {})[s.uuid] || [];
      list.forEach((id) => {
        set.add(id);
      });
      map[s.uuid] = Array.from(set);
    });
    return map;
  }, [workspaceProjects, sandboxConversations]);

  useEffect(() => {
    if (!conversationId || lastExpandedConvRef.current === conversationId) return;
    for (const [projectUuid, convIds] of Object.entries(projectConversationMap)) {
      if (convIds.includes(conversationId)) {
        lastExpandedConvRef.current = conversationId;
        setExpandedProjects((prev) => (prev[projectUuid] ? prev : { ...prev, [projectUuid]: true }));
        break;
      }
    }
  }, [conversationId, projectConversationMap]);

  const historyConversations = useMemo(() => {
    if (workspaceSandbox?.workspace_uuid !== currentWorkspace?.uuid || generalHistoryProjectId !== workspaceSandbox?.uuid) return [];
    const assignedIds = new Set(Object.values(projectConversationMap).flat());
    return generalConversations.filter((conversation) => !assignedIds.has(conversation.uuid));
  }, [generalConversations, generalHistoryProjectId, workspaceSandbox, currentWorkspace?.uuid, projectConversationMap]);

  if (!user) return null;

  return (
    <>
      <CreateWorkspaceDialog />
      <ManageWorkspaceMembersDialog />
      <WorkspaceSandboxSettingsDialog />
      <CreateProjectDialog />
      <EditProjectDialog project={editProjectTarget} onOpenChange={open => { if (!open) setEditProjectTarget(null); }} />
      <RemoveProjectDialog project={removeProjectTarget} onOpenChange={open => { if (!open) setRemoveProjectTarget(null); }} />
      {/* Mobile Backdrop */}
      {!hideOverlay && isOpen && (
        <div
          onClick={toggle}
          className="fixed inset-0 bg-black/60 z-[998] md:hidden backdrop-blur-sm"
        />
      )}

      {/* Main Sidebar Panel */}
      <aside
        role="complementary"
        aria-label={t("sidebar.ariaLabel")}
        style={{
          width: typeof window !== "undefined" && window.innerWidth >= 768 ? `${width}px` : undefined,
        }}
        className={cn(
          "fixed top-0 left-0 h-[100dvh] w-[min(90vw,320px)] md:w-[var(--app-sidebar-width)] z-[1000] flex flex-col overflow-hidden border-r shadow-2xl md:shadow-none",
          !isResizing && "transition-transform duration-250 ease-in-out",
          isLight
            ? "bg-white/90 border-gray-200 backdrop-blur-xl"
            : "bg-[#050508]/95 border-white/10 backdrop-blur-xl",
          isOpen ? "translate-x-0" : "-translate-x-full md:-translate-x-[calc(100%+1rem)]"
        )}
      >
        {/* Brand Header */}
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/50 px-3.5">
          <Link
            to="/new"
            onClick={closeSidebarOnMobile}
            className="flex items-center gap-2.5 font-mono text-base tracking-[-0.02em] text-foreground transition-opacity hover:opacity-90"
          >
            <NeuronLogo size={28} className="text-foreground shrink-0" />
            <span className="flex items-baseline gap-[1ch]">
              <span className="font-bold">Neuron</span>{" "}
              <span className="font-light text-muted-foreground">Runner</span>
            </span>
          </Link>
          <button
            type="button"
            aria-label={t("sidebar.closeSidebar")}
            title={t("sidebar.closeSidebarShortcut")}
            onClick={toggle}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {user ? <LuPanelLeftClose className="h-5 w-5" /> : <LuX className="h-5 w-5" />}
          </button>
        </div>

        {/* Primary navigation */}
        <div className="flex shrink-0 flex-col gap-1 border-b border-border/40 px-3 py-2.5">
          <Button
            variant={isNewChatActive ? "secondary" : "ghost"}
            className={cn(
              "h-9 w-full justify-start gap-2.5 rounded-lg px-2.5 text-sm font-medium",
              isNewChatActive && "font-semibold text-foreground"
            )}
            onClick={() => {
              if (typeof document !== "undefined" && isChatRoute) {
                document.body.classList.remove("nav-from-chat", "nav-from-home");
                prepareNewChatTransition();
              }
              setChatMode("chat");
              if (!isChatRoute) useChatStore.getState().reset();
              useWorkspaceTabsStore.getState().openChatTab();
              router.push("/new");
              closeSidebarOnMobile();
            }}
          >
            <LuPlus className="h-4 w-4" />
            {t("sidebar.newChat")}
          </Button>
          <Button
            variant={pathname.startsWith("/issues") ? "secondary" : "ghost"}
            className="h-9 w-full justify-start gap-2.5 rounded-lg px-2.5 text-sm font-medium"
            onClick={() => {
              const store = useWorkspaceTabsStore.getState();
              const chatTab = store.tabs.find((t) => t.type === "chat");
              if (chatTab) {
                store.setActiveTab(chatTab.id);
              }
              router.push("/issues");
              closeSidebarOnMobile();
            }}
          >
            <LuCircleDot className="h-4 w-4" />{t("sidebar.issues")}
          </Button>
          <Button
            variant={pathname.startsWith("/pull-requests") ? "secondary" : "ghost"}
            className="h-9 w-full justify-start gap-2.5 rounded-lg px-2.5 text-sm font-medium"
            onClick={() => {
              const store = useWorkspaceTabsStore.getState();
              const chatTab = store.tabs.find((t) => t.type === "chat");
              if (chatTab) {
                store.setActiveTab(chatTab.id);
              }
              router.push("/pull-requests");
              closeSidebarOnMobile();
            }}
          >
            <LuGitPullRequest className="h-4 w-4" />{t("sidebar.pullRequests")}
          </Button>
          <Button
            variant={pathname.startsWith("/integrations") ? "secondary" : "ghost"}
            className="h-9 w-full justify-start gap-2.5 rounded-lg px-2.5 text-sm font-medium"
            aria-current={pathname.startsWith("/integrations") ? "page" : undefined}
            onClick={() => {
              router.push("/integrations");
              closeSidebarOnMobile();
            }}
          >
            <LuPlug className="h-4 w-4" />{t("sidebar.integrations")}
          </Button>
        </div>

        {/* Scrollable Content: Projects & History */}
        {user ? (
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-2 text-sm select-none"
          >
            {/* Projects Section */}
            <div className="mb-2">
              <div className="flex justify-between items-center px-2 py-1.5">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  {t("sidebar.projects")} {workspaceProjects.length > 0 ? `(${workspaceProjects.length})` : ""}
                </span>
                <button
                  type="button"
                  aria-label={t("sidebar.newProject")}
                  title={t("sidebar.createProject")}
                  onClick={() => {
                    setCreateProjectDialogOpen(true);
                  }}
                  className="h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  <LuPlus className="h-3.5 w-3.5" />
                </button>
              </div>

              {isProjectsLoading && workspaceProjects.length === 0 ? (
                <div className="flex justify-center items-center h-12">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                </div>
              ) : workspaceProjects.length > 0 ? (
                <div className="flex flex-col gap-1 mt-1">
                  {workspaceProjects.map((p) => {
                    const isExpanded = expandedProjects[p.uuid] === true;
                    const convIds = projectConversationMap[p.uuid] || [];
                    const projectConvs = (cachedProjectConversations[p.uuid] || conversations).filter((c) => convIds.includes(c.uuid));
                    const isDirectProjectRoute =
                      pathname === `/projects/${p.slug}` ||
                      pathname === `/projects/${p.uuid}` ||
                      pathname.startsWith(`/projects/${p.slug}/`) ||
                      pathname.startsWith(`/projects/${p.uuid}/`);
                    const hasActiveChildConversation =
                      !isFileActive &&
                      isChatRoute &&
                      Boolean(conversationId && convIds.includes(conversationId));
                    const isProjectActive = isDirectProjectRoute || (!isExpanded && hasActiveChildConversation);
                    const vmName = frontendExtension.runtimeBridge.resolveProjectRuntimeLabel(p);
                    return (
                      <div key={p.uuid} className="rounded-lg overflow-hidden">
                        <div
                          onClick={() => handleProjectHeaderClick(p)}
                          className={cn(
                            "group/project flex items-center h-8.5 sm:h-9 px-2 rounded-lg cursor-pointer transition-colors text-sm gap-1.5",
                            isProjectActive ? "bg-accent text-accent-foreground font-semibold" : "hover:bg-muted/60 text-foreground"
                          )}
                        >
                          <button
                            type="button"
                            aria-label={isExpanded ? t("sidebar.collapse") : t("sidebar.expand")}
                            aria-expanded={isExpanded}
                            onClick={(e) => toggleProjectExpand(p.uuid, e)}
                            className="h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground shrink-0"
                          >
                            <LuChevronRight
                              className={cn(
                                "h-3.5 w-3.5 transition-transform duration-200 ease-in-out",
                                isExpanded && "rotate-90 text-foreground"
                              )}
                            />
                          </button>
                          <LuFolderCode className={cn("h-4 w-4 shrink-0", isProjectActive ? "text-primary" : "text-muted-foreground")} />
                          <span className="flex-1 min-w-0 truncate font-medium">{p.display_name}</span>
                          {vmName && (
                            <span
                              title={t("sidebar.machineTooltip", { name: vmName })}
                              className="inline-flex max-w-[150px] shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-xs leading-none bg-muted/80 text-muted-foreground border border-border/50 truncate transition-transform duration-200 ease-out translate-x-[30px] group-hover/project:translate-x-0 group-has-[[data-state=open]]/project:translate-x-0"
                            >
                              <LuServer className="h-3 w-3 shrink-0" />
                              <span className="truncate">{vmName}</span>
                            </span>
                          )}
                          <div className="opacity-0 translate-x-1 pointer-events-none group-hover/project:opacity-100 group-hover/project:translate-x-0 group-hover/project:pointer-events-auto group-has-[[data-state=open]]/project:opacity-100 group-has-[[data-state=open]]/project:translate-x-0 group-has-[[data-state=open]]/project:pointer-events-auto [&:has([data-state=open])]:opacity-100 [&:has([data-state=open])]:translate-x-0 [&:has([data-state=open])]:pointer-events-auto transition-all duration-200 ease-out shrink-0">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  type="button"
                                  aria-label={t("sidebar.projectActionsFor", { name: p.display_name })}
                                  title={t("sidebar.projectActions")}
                                  onClick={(event) => event.stopPropagation()}
                                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                                >
                                  <LuEllipsis className="h-3.5 w-3.5" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                                <DropdownMenuItem onSelect={() => void updateSandbox(p.uuid, { is_favorite: !p.is_favorite })}>
                                  <LuPin />{p.is_favorite ? t("sidebar.unpin") : t("sidebar.pin")}
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => setEditProjectTarget(p)}><LuPencil />{t("sidebar.editDetails")}</DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setRemoveProjectTarget(p)}><LuTrash2 />{t("sidebar.delete")}</DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </div>
                        <AnimatedCollapse in={isExpanded}>
                          <div className="flex flex-col gap-0.5 mt-0.5 pl-4 pb-0.5">
                            {projectConvs.map((c) => (
                              <SidebarItem
                                key={c.uuid}
                                conversation={c}
                                isActive={!isFileActive && isChatRoute && c.uuid === conversationId}
                                isEditing={editingId === c.uuid}
                                isGenerating={Boolean(generatingConversations?.[c.uuid] ?? c.is_generating)}
                                editTitle={editTitle}
                                setEditTitle={setEditTitle}
                                onStartEdit={handleStartEdit}
                                onSaveEdit={handleSaveEdit}
                                onCancelEdit={handleCancelEdit}
                                onDelete={handleDelete}
                                onNavigate={handleNavigate}
                                isInsideProject
                                onRemoveFromProject={() => handleRemoveFromProject(c.uuid, p.uuid)}
                                onAddToProject={() => handleOpenAddToProject(c.uuid)}
                              />
                            ))}
                            {projectConvs.length === 0 && convIds.length === 0 && (
                              <div className="h-7 px-2 flex items-center text-xs text-muted-foreground/70 select-none">
                                {t("sidebar.noConversationsYet")}
                              </div>
                            )}
                          </div>
                        </AnimatedCollapse>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="px-2 py-2 text-center text-muted-foreground">
                  <p className="text-sm">
                    {t("sidebar.noProjects")}
                  </p>
                </div>
              )}
            </div>

            <div className="h-px bg-border my-2.5 mx-1" />

            {/* Chats & Tasks Section */}
            <div>
              <div className="flex justify-between items-center px-2 py-1.5">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  {t("sidebar.historyCount", { count: historyConversations.length })}
                </span>
              </div>

              {isHistorySectionLoading && historyConversations.length === 0 && (
                <div className="flex justify-center items-center h-12">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                </div>
              )}

              {!isHistorySectionLoading && historyConversations.length === 0 && (
                <p className="text-xs text-muted-foreground px-2 py-3 text-center">
                  {t("sidebar.noGeneralChatsYet")}
                </p>
              )}

              <div className="flex flex-col gap-1 mt-1">
                {historyConversations.map((c) => (
                  <SidebarItem
                    key={c.uuid}
                    conversation={c}
                    isActive={!isFileActive && isChatRoute && c.uuid === conversationId}
                    isEditing={editingId === c.uuid}
                    isGenerating={Boolean(generatingConversations?.[c.uuid] ?? c.is_generating)}
                    editTitle={editTitle}
                    setEditTitle={setEditTitle}
                    onStartEdit={handleStartEdit}
                    onSaveEdit={handleSaveEdit}
                    onCancelEdit={handleCancelEdit}
                    onDelete={handleDelete}
                    onNavigate={handleNavigate}
                    onAddToProject={() => handleOpenAddToProject(c.uuid)}
                  />
                ))}
              </div>

              {isLoadingMore && (
                <div className="flex justify-center py-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="px-3 py-4 flex-1">
            <p className="text-xs text-muted-foreground text-center">
              {t("sidebar.signInPrompt")}
            </p>
          </div>
        )}

        {/* User Avatar Footer */}
        {user ? (
          <SidebarAvatar
            user={user}
            expanded={avatarExpanded}
            onToggle={toggleAvatar}
          />
        ) : (
          <div className="w-full shrink-0 border-t border-border/60 p-3">
            <Button
              variant="default"
              className="w-full justify-center gap-2 text-sm font-medium"
              onClick={() => useSigninStore.getState().setOpen(true)}
            >
              {t("sidebar.signIn")}
            </Button>
          </div>
        )}

        {/* Drag Resize Handle (Desktop only) */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("sidebar.resizeSidebar")}
          title={t("sidebar.resizeSidebarTooltip")}
          onMouseDown={startResizing}
          onDoubleClick={handleResetWidth}
          className={cn(
            "hidden md:block absolute top-0 right-0 w-2.5 h-full cursor-col-resize z-50 select-none group",
            isResizing && "bg-primary/20"
          )}
        >
          <div
            className={cn(
              "w-[2px] h-full mx-auto transition-colors",
              isResizing ? "bg-primary" : "group-hover:bg-primary/60"
            )}
          />
        </div>
      </aside>

      <Dialog
        open={isAddToProjectOpen}
        onOpenChange={(open) => {
          setIsAddToProjectOpen(open);
          if (!open) setSelectedConvIdForProject(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("sidebar.addToProjectDialogTitle")}</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <p className="text-xs text-muted-foreground mb-3">
              {t("sidebar.addToProjectDialogDescription")}
            </p>
            {sandboxes.length === 0 ? (
              <div className="py-4 text-center">
                <p className="text-sm text-muted-foreground mb-3">{t("sidebar.noProjectsAvailable")}</p>
                <Button
                  size="sm"
                  onClick={() => {
                    setIsAddToProjectOpen(false);
                    useWorkspaceTabsStore.getState().openFilesTab();
                    router.push("/new");
                    closeSidebarOnMobile();
                  }}
                >
                  {t("sidebar.addProjectPath")}
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {sandboxes.map((sb) => (
                  <button
                    key={sb.uuid}
                    type="button"
                    onClick={() => handleConfirmAddToProject(sb.uuid)}
                    className="flex justify-between items-center p-3 rounded-xl border border-border hover:border-zinc-400 hover:bg-zinc-500/10 transition-colors text-left"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="p-2 rounded-lg bg-zinc-500/15 text-zinc-300">
                        <LuBox className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-foreground">{sb.display_name}</div>
                        <div className="text-xs text-muted-foreground font-mono truncate">
                          {sb.filesystem_path || `/workspace/${sb.slug}`}
                        </div>
                      </div>
                    </div>
                    <Badge variant="subtle">{t("sidebar.select")}</Badge>
                  </button>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

    </>
  );
};

export default Sidebar;
