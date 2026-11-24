"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type WorkspaceTabType = "chat" | "files" | "code" | "excel" | "docx" | "pdf" | "image" | "terminal" | "git" | "browser" | "desktop";

export interface IWorkspaceTab {
  id: string;
  type: WorkspaceTabType;
  title: string;
  // Chat tab fields
  conversationUuid?: string;
  // File tab fields
  fileUuid?: string;
  filePath?: string;
  fileSize?: number;
  content?: string;
  savedContent?: string;
  isBinary?: boolean;
  isDirty?: boolean;
  // Preview tabs are replaced by the next single-click file open.
  isPreview?: boolean;
  isContentLoaded?: boolean;
}

export function detectFileType(filePath: string): WorkspaceTabType {
  const ext = (filePath.split(".").pop() || "").toLowerCase();
  if (["jpg", "jpeg", "png"].includes(ext)) return "image";
  if (ext === "xlsx" || ext === "xls" || ext === "csv") {
    return "excel";
  }
  if (ext === "docx") {
    return "docx";
  }
  if (ext === "pdf") {
    return "pdf";
  }
  return "code";
}

export function cleanTabTitle(rawTitle?: string): string {
  if (!rawTitle) return "New Conversation";
  const cleaned = rawTitle
    .replace(/^[\s#>*_`~-]+/, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "New Conversation";
}

interface WorkspaceTabsState {
  tabs: IWorkspaceTab[];
  activeTabId: string;
  splitTabs: IWorkspaceTab[];
  activeSplitTabId: string | null;
  isSplit: boolean;
  splitRatio: number; // percentage of left pane (20 - 80, default 50)
  focusedPane: "left" | "right";
  draggedTabId: string | null;
  dragSourcePane: "left" | "right" | null;

  openChatTab: (conversationUuid?: string, title?: string, inPane?: "left" | "right") => string;
  openFilesTab: () => string;
  openGitTab: () => string;
  openBrowserTab: () => string;
  openDesktopTab: () => string;
  openTerminalTab: (title?: string, inPane?: "left" | "right") => string;
  openFileTab: (
    file: {
      uuid: string;
      path: string;
      file_size_bytes?: number;
      mime_type?: string;
    },
    content?: string | null,
    isBinary?: boolean,
    options?: { preview?: boolean }
  ) => string;
  pinTab: (tabId: string) => void;
  closeAllFileTabs: () => void;
  closeOtherFileTabs: (tabId: string) => void;
  closeFileTabsToRight: (tabId: string) => void;
  closeFileTabsWhere: (shouldClose: (tab: IWorkspaceTab) => boolean) => void;
  closeTab: (tabId: string) => void;
  closeDeletedFileTabs: (path: string) => boolean;
  setActiveTab: (tabId: string) => void;
  setActiveSplitTab: (tabId: string) => void;
  setFocusedPane: (pane: "left" | "right") => void;
  setSplitRatio: (ratio: number) => void;
  setDraggingTab: (tabId: string | null, sourcePane?: "left" | "right" | null) => void;
  splitTab: (tabId: string, toPane?: "left" | "right") => void;
  closeSplit: () => void;
  moveTab: (
    tabId: string,
    fromPane: "left" | "right",
    toPane: "left" | "right",
    targetIndex?: number
  ) => void;
  reorderTabs: (pane: "left" | "right", fromIndex: number, toIndex: number) => void;
  updateTabContent: (tabId: string, content: string) => void;
  markTabSaved: (tabId: string) => void;
  setTabContentLoaded: (tabId: string, content: string, isBinary?: boolean) => void;
  updateChatTabTitle: (conversationUuid: string, title: string) => void;
  updateChatTabUuid: (oldTabId: string, newConversationUuid: string, title?: string) => void;
  resetForWorkspace: () => void;
}

export const useWorkspaceTabsStore = create<WorkspaceTabsState>()(
  persist(
    (set, get) => ({
      tabs: [
        {
          id: "chat-default",
          type: "chat",
          title: "New Chat",
        },
      ],
      activeTabId: "chat-default",
      splitTabs: [],
      activeSplitTabId: null,
      isSplit: false,
      splitRatio: 50,
      focusedPane: "left",
      draggedTabId: null,
      dragSourcePane: null,

      setDraggingTab: (tabId, sourcePane = null) => {
        set({ draggedTabId: tabId, dragSourcePane: sourcePane });
      },

      resetForWorkspace: () => {
        const keepFilesPanel = get().splitTabs.some((tab) => tab.type === "files") && get().isSplit;
        const chatId = `chat-workspace-${Date.now()}`;
        const filesTab = keepFilesPanel
          ? [{ id: "tab-files", type: "files" as const, title: "Files" }]
          : [];
        set({
          tabs: [{ id: chatId, type: "chat", title: "New Chat" }],
          activeTabId: chatId,
          splitTabs: filesTab,
          activeSplitTabId: filesTab[0]?.id ?? null,
          isSplit: filesTab.length > 0,
          focusedPane: "left",
          draggedTabId: null,
          dragSourcePane: null,
        });
      },

      setFocusedPane: (pane) => {
        set({ focusedPane: pane });
      },

      setSplitRatio: (ratio) => {
        const clamped = Math.min(80, Math.max(20, ratio));
        set({ splitRatio: clamped });
      },

      setActiveSplitTab: (tabId) => {
        const { splitTabs } = get();
        if (splitTabs.some((t) => t.id === tabId)) {
          set({ activeSplitTabId: tabId, focusedPane: "right" });
        }
      },

      splitTab: (tabId, toPane = "right") => {
        const { tabs, splitTabs, activeTabId, activeSplitTabId } = get();

        if (toPane === "right") {
          const tabIndex = tabs.findIndex((t) => t.id === tabId);
          if (tabIndex === -1) return;
          const tabToMove = tabs[tabIndex];
          let newTabs = tabs.filter((t) => t.id !== tabId);

          // If left tabs become empty, create a fresh New Chat tab so left pane is never empty
          let nextActiveTabId = activeTabId;
          if (newTabs.length === 0) {
            const fallbackChatId = `chat-default-${Date.now()}`;
            newTabs = [
              {
                id: fallbackChatId,
                type: "chat",
                title: "New Chat",
              },
            ];
            nextActiveTabId = fallbackChatId;
          } else if (activeTabId === tabId) {
            nextActiveTabId =
              tabIndex < newTabs.length ? newTabs[tabIndex].id : newTabs[newTabs.length - 1].id;
          }

          const newSplitTabs = [...splitTabs, tabToMove];
          set({
            tabs: newTabs,
            activeTabId: nextActiveTabId,
            splitTabs: newSplitTabs,
            activeSplitTabId: tabToMove.id,
            isSplit: true,
            focusedPane: "right",
          });
        } else {
          // toPane === "left"
          const tabIndex = splitTabs.findIndex((t) => t.id === tabId);
          if (tabIndex === -1) return;
          const tabToMove = splitTabs[tabIndex];
          const newSplitTabs = splitTabs.filter((t) => t.id !== tabId);
          const newTabs = [...tabs, tabToMove];

          let nextActiveSplitTabId = activeSplitTabId;
          const isStillSplit = newSplitTabs.length > 0;
          if (!isStillSplit) {
            nextActiveSplitTabId = null;
          } else if (activeSplitTabId === tabId) {
            nextActiveSplitTabId =
              tabIndex < newSplitTabs.length
                ? newSplitTabs[tabIndex].id
                : newSplitTabs[newSplitTabs.length - 1].id;
          }

          set({
            tabs: newTabs,
            activeTabId: tabToMove.id,
            splitTabs: newSplitTabs,
            activeSplitTabId: nextActiveSplitTabId,
            isSplit: isStillSplit,
            focusedPane: "left",
          });
        }
      },

      closeSplit: () => {
        const { tabs, splitTabs } = get();
        set({
          tabs: [...tabs, ...splitTabs],
          splitTabs: [],
          activeSplitTabId: null,
          isSplit: false,
          focusedPane: "left",
        });
      },

      moveTab: (tabId, fromPane, toPane, targetIndex) => {
        const { tabs, splitTabs, activeTabId, activeSplitTabId } = get();

        if (fromPane === toPane) {
          // Reorder within same pane
          const list = fromPane === "left" ? [...tabs] : [...splitTabs];
          const currIdx = list.findIndex((t) => t.id === tabId);
          if (currIdx === -1) return;
          const [item] = list.splice(currIdx, 1);
          const insertIdx =
            targetIndex !== undefined
              ? Math.min(list.length, Math.max(0, targetIndex))
              : list.length;
          list.splice(insertIdx, 0, item);
          if (fromPane === "left") {
            set({ tabs: list });
          } else {
            set({ splitTabs: list });
          }
          return;
        }

        // Cross-pane move
        if (fromPane === "left" && toPane === "right") {
          const fromIdx = tabs.findIndex((t) => t.id === tabId);
          if (fromIdx === -1) return;
          const tab = tabs[fromIdx];
          let newTabs = tabs.filter((t) => t.id !== tabId);

          let nextActiveLeft = activeTabId;
          if (newTabs.length === 0) {
            const fallbackId = `chat-default-${Date.now()}`;
            newTabs = [{ id: fallbackId, type: "chat", title: "New Chat" }];
            nextActiveLeft = fallbackId;
          } else if (activeTabId === tabId) {
            nextActiveLeft =
              fromIdx < newTabs.length ? newTabs[fromIdx].id : newTabs[newTabs.length - 1].id;
          }

          const newSplitTabs = [...splitTabs];
          const insertIdx =
            targetIndex !== undefined
              ? Math.min(newSplitTabs.length, Math.max(0, targetIndex))
              : newSplitTabs.length;
          newSplitTabs.splice(insertIdx, 0, tab);

          set({
            tabs: newTabs,
            activeTabId: nextActiveLeft,
            splitTabs: newSplitTabs,
            activeSplitTabId: tab.id,
            isSplit: true,
            focusedPane: "right",
          });
        } else {
          // fromPane === "right" && toPane === "left"
          const fromIdx = splitTabs.findIndex((t) => t.id === tabId);
          if (fromIdx === -1) return;
          const tab = splitTabs[fromIdx];
          const newSplitTabs = splitTabs.filter((t) => t.id !== tabId);

          let nextActiveRight = activeSplitTabId;
          const isStillSplit = newSplitTabs.length > 0;
          if (!isStillSplit) {
            nextActiveRight = null;
          } else if (activeSplitTabId === tabId) {
            nextActiveRight =
              fromIdx < newSplitTabs.length
                ? newSplitTabs[fromIdx].id
                : newSplitTabs[newSplitTabs.length - 1].id;
          }

          const newTabs = [...tabs];
          const insertIdx =
            targetIndex !== undefined
              ? Math.min(newTabs.length, Math.max(0, targetIndex))
              : newTabs.length;
          newTabs.splice(insertIdx, 0, tab);

          set({
            tabs: newTabs,
            activeTabId: tab.id,
            splitTabs: newSplitTabs,
            activeSplitTabId: nextActiveRight,
            isSplit: isStillSplit,
            focusedPane: "left",
          });
        }
      },

      reorderTabs: (pane, fromIndex, toIndex) => {
        const { tabs, splitTabs } = get();
        const list = pane === "left" ? [...tabs] : [...splitTabs];
        if (
          fromIndex < 0 ||
          fromIndex >= list.length ||
          toIndex < 0 ||
          toIndex >= list.length
        ) {
          return;
        }
        const [removed] = list.splice(fromIndex, 1);
        list.splice(toIndex, 0, removed);
        if (pane === "left") {
          set({ tabs: list });
        } else {
          set({ splitTabs: list });
        }
      },

      openChatTab: (conversationUuid?: string, title?: string, inPane?: "left" | "right") => {
        const { tabs, splitTabs, activeTabId, activeSplitTabId } = get();

        // 1. If opening an existing conversation
        if (conversationUuid) {
          const cleanTitle = title ? cleanTabTitle(title) : undefined;

          // Check if already open in left pane
          const existingInLeft = tabs.find(
            (t) => t.type === "chat" && t.conversationUuid === conversationUuid
          );
          if (existingInLeft) {
            if (
              cleanTitle &&
              (existingInLeft.title === "Conversation" ||
                existingInLeft.title === "New Chat" ||
                existingInLeft.title === "New Conversation" ||
                existingInLeft.title.startsWith("New Conversation"))
            ) {
              set({
                tabs: tabs.map((t) =>
                  t.id === existingInLeft.id ? { ...t, title: cleanTitle } : t
                ),
                activeTabId: existingInLeft.id,
                focusedPane: "left",
              });
            } else {
              set({ activeTabId: existingInLeft.id, focusedPane: "left" });
            }
            return existingInLeft.id;
          }

          // Check if already open in right pane
          const existingInRight = splitTabs.find(
            (t) => t.type === "chat" && t.conversationUuid === conversationUuid
          );
          if (existingInRight) {
            if (
              cleanTitle &&
              (existingInRight.title === "Conversation" ||
                existingInRight.title === "New Chat" ||
                existingInRight.title === "New Conversation" ||
                existingInRight.title.startsWith("New Conversation"))
            ) {
              set({
                splitTabs: splitTabs.map((t) =>
                  t.id === existingInRight.id ? { ...t, title: cleanTitle } : t
                ),
                activeSplitTabId: existingInRight.id,
                focusedPane: "right",
              });
            } else {
              set({ activeSplitTabId: existingInRight.id, focusedPane: "right" });
            }
            return existingInRight.id;
          }

          // Chats opened from navigation or a newly created conversation belong
          // in the primary (left) pane. Callers such as the tab bar can still
          // explicitly request the right pane.
          const targetPane = inPane ?? "left";
          const currentList = targetPane === "right" ? splitTabs : tabs;
          const activeId =
            targetPane === "right" ? activeSplitTabId : activeTabId;
          const activeTab = currentList.find((t) => t.id === activeId);

          // 2. Check if we should reuse an empty "New Chat" tab!
          // Only reuse the active tab if it's currently an empty chat tab
          let emptyTabToReuse: IWorkspaceTab | undefined;
          if (activeTab && activeTab.type === "chat" && !activeTab.conversationUuid) {
            emptyTabToReuse = activeTab;
          }

          const tabTitle = cleanTitle || "New Conversation";
          const newTabId = `chat-${conversationUuid}`;

          if (emptyTabToReuse) {
            const updateItem = (t: IWorkspaceTab) =>
              t.id === emptyTabToReuse!.id
                ? {
                    ...t,
                    id: newTabId,
                    conversationUuid,
                    title: tabTitle,
                  }
                : t;

            if (splitTabs.some((t) => t.id === emptyTabToReuse!.id)) {
              set({
                splitTabs: splitTabs.map(updateItem),
                activeSplitTabId: newTabId,
                focusedPane: "right",
              });
            } else {
              set({
                tabs: tabs.map(updateItem),
                activeTabId: newTabId,
                focusedPane: "left",
              });
            }
            return newTabId;
          }

          // 3. Otherwise create a brand new tab
          const newTab: IWorkspaceTab = {
            id: newTabId,
            type: "chat",
            title: tabTitle,
            conversationUuid,
          };

          if (targetPane === "right") {
            set({
              splitTabs: [...splitTabs, newTab],
              activeSplitTabId: newTabId,
              focusedPane: "right",
            });
          } else {
            set({
              tabs: [...tabs, newTab],
              activeTabId: newTabId,
              focusedPane: "left",
            });
          }
          return newTabId;
        }

        // 2. If requesting a "New Chat" tab, always create and activate a new tab
        const targetPane = inPane ?? "left";
        const newId = `chat-new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const newTab: IWorkspaceTab = {
          id: newId,
          type: "chat",
          title: "New Chat",
        };

        if (targetPane === "right") {
          set({
            splitTabs: [...splitTabs, newTab],
            activeSplitTabId: newId,
            focusedPane: "right",
          });
        } else {
          set({
            tabs: [...tabs, newTab],
            activeTabId: newId,
            focusedPane: "left",
          });
        }
        return newId;
      },

      openFilesTab: () => {
        const { tabs, splitTabs, activeTabId } = get();
        const existingInLeft = tabs.find((t) => t.type === "files");
        if (existingInLeft) {
          const existingIndex = tabs.findIndex((t) => t.id === existingInLeft.id);
          let nextTabs = tabs.filter((t) => t.id !== existingInLeft.id);
          let nextActiveTabId = activeTabId;

          if (nextTabs.length === 0) {
            const fallbackId = `chat-default-${Date.now()}`;
            nextTabs = [{ id: fallbackId, type: "chat", title: "New Chat" }];
            nextActiveTabId = fallbackId;
          } else if (activeTabId === existingInLeft.id) {
            nextActiveTabId =
              existingIndex < nextTabs.length
                ? nextTabs[existingIndex].id
                : nextTabs[nextTabs.length - 1].id;
          }

          set({
            tabs: nextTabs,
            activeTabId: nextActiveTabId,
            splitTabs: [...splitTabs, existingInLeft],
            activeSplitTabId: existingInLeft.id,
            isSplit: true,
            focusedPane: "right",
          });
          return existingInLeft.id;
        }
        const existingInRight = splitTabs.find((t) => t.type === "files");
        if (existingInRight) {
          set({
            activeSplitTabId: existingInRight.id,
            isSplit: true,
            focusedPane: "right",
          });
          return existingInRight.id;
        }

        const newTabId = "tab-files";
        const newTab: IWorkspaceTab = {
          id: newTabId,
          type: "files",
          title: "Files",
        };
        set({
          splitTabs: [...splitTabs, newTab],
          activeSplitTabId: newTabId,
          isSplit: true,
          focusedPane: "right",
        });
        return newTabId;
      },

      openGitTab: () => {
        const { splitTabs } = get();
        const existing = splitTabs.find((tab) => tab.type === "git");
        const tab: IWorkspaceTab = existing || { id: "tab-git", type: "git", title: "Git" };
        set({
          splitTabs: existing ? splitTabs : [...splitTabs, tab],
          activeSplitTabId: tab.id,
          isSplit: true,
          focusedPane: "right",
        });
        return tab.id;
      },

      openBrowserTab: () => {
        const { splitTabs } = get();
        const existing = splitTabs.find(tab => tab.type === "browser");
        const tab: IWorkspaceTab = existing || { id: "tab-browser", type: "browser", title: "Browser" };
        set({
          splitTabs: existing ? splitTabs : [...splitTabs, tab],
          activeSplitTabId: tab.id,
          isSplit: true,
          focusedPane: "right",
        });
        return tab.id;
      },

      openDesktopTab: () => {
        const { splitTabs } = get();
        const existing = splitTabs.find(tab => tab.type === "desktop");
        const tab: IWorkspaceTab = existing ? { ...existing, title: "Desktop" } : { id: "tab-desktop", type: "desktop", title: "Desktop" };
        set({ splitTabs: existing ? splitTabs.map(item => item.id === tab.id ? tab : item) : [...splitTabs, tab], activeSplitTabId: tab.id,
          isSplit: true, focusedPane: "right" });
        return tab.id;
      },

      openTerminalTab: (title, inPane) => {
        const { tabs, splitTabs } = get();
        const allTabs = [...tabs, ...splitTabs];
        const existingTerminals = allTabs.filter((t) => t.type === "terminal");

        // Determine next terminal number based on existing terminals
        let nextNumber = 1;
        const usedNumbers = new Set(
          existingTerminals
            .map((t) => {
              const match = t.title.match(/^Terminal\s*(\d+)$/i);
              return match ? parseInt(match[1], 10) : (t.title === "Terminal" ? 1 : null);
            })
            .filter((n): n is number => n !== null)
        );
        while (usedNumbers.has(nextNumber)) {
          nextNumber++;
        }

        const tabTitle = (title && title !== "Terminal") ? title : `Terminal ${nextNumber}`;
        const newTabId = `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const newTab: IWorkspaceTab = {
          id: newTabId,
          type: "terminal",
          title: tabTitle,
        };

        const targetPane = inPane || "right";

        if (targetPane === "right") {
          set({
            splitTabs: [...splitTabs, newTab],
            activeSplitTabId: newTabId,
            isSplit: true,
            focusedPane: "right",
          });
        } else {
          set({
            tabs: [...tabs, newTab],
            activeTabId: newTabId,
            focusedPane: "left",
          });
        }
        return newTabId;
      },

      openFileTab: (file, content, isBinary, options) => {
        const { tabs, splitTabs, activeSplitTabId } = get();
        const tabId = `file-${file.uuid || file.path}`;
        const preview = options?.preview === true;

        if (tabs.some((t) => t.id === tabId)) {
          set({
            tabs: options?.preview === false
              ? tabs.map((t) => (t.id === tabId && t.isPreview ? { ...t, isPreview: false } : t))
              : tabs,
            activeTabId: tabId,
            focusedPane: "left",
          });
          return tabId;
        }
        const existingInRight = splitTabs.find((t) => t.id === tabId);
        if (existingInRight) {
          const nextSplitTabs = splitTabs.filter((t) => t.id !== tabId);
          const nextActiveSplitTabId =
            activeSplitTabId === tabId
              ? nextSplitTabs[0]?.id ?? null
              : activeSplitTabId;
          set({
            tabs: [...tabs, existingInRight],
            activeTabId: tabId,
            splitTabs: nextSplitTabs,
            activeSplitTabId: nextActiveSplitTabId,
            isSplit: nextSplitTabs.length > 0,
            focusedPane: "left",
          });
          return tabId;
        }

        const type = detectFileType(file.path);
        const fileName = file.path.split("/").pop() || file.path;

        const newTab: IWorkspaceTab = {
          id: tabId,
          type,
          title: fileName,
          fileUuid: file.uuid || file.path,
          filePath: file.path,
          fileSize: file.file_size_bytes,
          content: content || "",
          savedContent: content !== undefined && content !== null ? content : undefined,
          isBinary: Boolean(isBinary),
          isDirty: false,
          isPreview: preview,
          isContentLoaded: content !== undefined && content !== null,
        };

        // A new preview replaces the previous clean preview tab in place so
        // browsing files does not pile up tabs.
        const previewIndex = preview
          ? tabs.findIndex((t) => t.isPreview && !t.isDirty && t.filePath)
          : -1;
        if (previewIndex !== -1) {
          const nextTabs = [...tabs];
          nextTabs[previewIndex] = newTab;
          set({ tabs: nextTabs, activeTabId: tabId, focusedPane: "left" });
          return tabId;
        }

        // Files are selected from the right-hand explorer, but their editor
        // belongs in the primary workspace. Keeping this deterministic also
        // prevents the explorer from replacing itself when it has focus.
        set({
          tabs: [...tabs, newTab],
          activeTabId: tabId,
          focusedPane: "left",
        });
        return tabId;
      },

      pinTab: (tabId) => {
        set((state) => {
          const pin = (t: IWorkspaceTab) => (t.id === tabId && t.isPreview ? { ...t, isPreview: false } : t);
          return { tabs: state.tabs.map(pin), splitTabs: state.splitTabs.map(pin) };
        });
      },

      // Closes every file tab in one go. Tabs with unsaved changes are kept.
      closeAllFileTabs: () => get().closeFileTabsWhere(() => true),
      closeOtherFileTabs: (tabId) => get().closeFileTabsWhere((t) => t.id !== tabId),
      closeFileTabsToRight: (tabId) => {
        const files = get().tabs.filter((t) => t.filePath);
        const index = files.findIndex((t) => t.id === tabId);
        if (index === -1) return;
        const doomed = new Set(files.slice(index + 1).map((t) => t.id));
        get().closeFileTabsWhere((t) => doomed.has(t.id));
      },
      closeFileTabsWhere: (shouldClose) => {
        const state = get();
        const keep = (tab: IWorkspaceTab) => !tab.filePath || Boolean(tab.isDirty) || !shouldClose(tab);
        const tabs = state.tabs.filter(keep);
        const splitTabs = state.splitTabs.filter(keep);
        let activeTabId = state.activeTabId;
        if (!tabs.some((t) => t.id === activeTabId)) {
          const fallback = tabs.find((t) => t.type === "chat") ?? tabs[0];
          if (fallback) {
            activeTabId = fallback.id;
          } else {
            const chat: IWorkspaceTab = { id: `chat-new-${Date.now()}`, type: "chat", title: "New Chat" };
            tabs.push(chat);
            activeTabId = chat.id;
          }
        }
        set({
          tabs,
          splitTabs,
          activeTabId,
          activeSplitTabId: splitTabs.some((t) => t.id === state.activeSplitTabId) ? state.activeSplitTabId : splitTabs[0]?.id ?? null,
          isSplit: state.isSplit && splitTabs.length > 0,
        });
      },

      closeDeletedFileTabs: (path) => {
        const state = get();
        const deletedPath = path.replace(/\/+$/, "");
        const matches = (tab: IWorkspaceTab) => Boolean(
          tab.filePath && (tab.filePath === deletedPath || tab.filePath.startsWith(`${deletedPath}/`))
        );
        const removed = [...state.tabs, ...state.splitTabs].filter(matches);
        if (!removed.length) return false;
        const activeRemoved = removed.some((tab) => tab.id === state.activeTabId || (state.isSplit && tab.id === state.activeSplitTabId));
        const tabs = state.tabs.filter((tab) => !matches(tab));
        const splitTabs = state.splitTabs.filter((tab) => !matches(tab));
        let activeTabId = state.activeTabId;
        if (activeRemoved || !tabs.length) {
          const chat: IWorkspaceTab = {
            id: `chat-new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: "chat",
            title: "New Chat",
          };
          tabs.push(chat);
          activeTabId = chat.id;
        }
        set({
          tabs,
          splitTabs,
          activeTabId,
          activeSplitTabId: splitTabs.some((tab) => tab.id === state.activeSplitTabId) ? state.activeSplitTabId : splitTabs[0]?.id ?? null,
          isSplit: state.isSplit && splitTabs.length > 0,
          focusedPane: activeRemoved ? "left" : state.focusedPane,
        });
        return activeRemoved;
      },

      closeTab: (tabId) => {
        const { tabs, splitTabs, activeTabId, activeSplitTabId } = get();

        // 1. Check in splitTabs (right pane)
        const rightIndex = splitTabs.findIndex((t) => t.id === tabId);
        if (rightIndex !== -1) {
          const newSplitTabs = splitTabs.filter((t) => t.id !== tabId);
          if (newSplitTabs.length === 0) {
            set({
              splitTabs: [],
              activeSplitTabId: null,
              isSplit: false,
              focusedPane: "left",
            });
          } else {
            const nextActiveRight =
              activeSplitTabId === tabId
                ? rightIndex < newSplitTabs.length
                  ? newSplitTabs[rightIndex].id
                  : newSplitTabs[newSplitTabs.length - 1].id
                : activeSplitTabId;
            set({
              splitTabs: newSplitTabs,
              activeSplitTabId: nextActiveRight,
            });
          }
          return;
        }

        // 2. Check in tabs (left pane)
        const leftIndex = tabs.findIndex((t) => t.id === tabId);
        if (leftIndex === -1) return;

        const newTabs = tabs.filter((t) => t.id !== tabId);

        if (newTabs.length === 0) {
          // If right pane has an editor tab, move the first one over
          const eligibleFromRight = splitTabs.find(
            (t) => !["files", "git", "terminal", "browser", "desktop"].includes(t.type)
          );
          if (eligibleFromRight) {
            const restRight = splitTabs.filter((t) => t.id !== eligibleFromRight.id);
            set({
              tabs: [eligibleFromRight],
              activeTabId: eligibleFromRight.id,
              splitTabs: restRight,
              activeSplitTabId: restRight.length > 0 ? restRight[0].id : null,
              isSplit: restRight.length > 0,
            });
            return;
          }

          const freshChatId = `chat-new-${Date.now()}`;
          set({
            tabs: [
              {
                id: freshChatId,
                type: "chat",
                title: "New Chat",
              },
            ],
            activeTabId: freshChatId,
          });
          return;
        }

        if (activeTabId === tabId) {
          const nextActive =
            leftIndex < newTabs.length
              ? newTabs[leftIndex].id
              : newTabs[newTabs.length - 1].id;
          set({
            tabs: newTabs,
            activeTabId: nextActive,
          });
        } else {
          set({ tabs: newTabs });
        }
      },

      setActiveTab: (tabId) => {
        const { tabs } = get();
        if (tabs.some((t) => t.id === tabId)) {
          set({ activeTabId: tabId, focusedPane: "left" });
        }
      },

      updateTabContent: (tabId, content) => {
        set((state) => {
          const update = (t: IWorkspaceTab) => {
            if (t.id !== tabId) return t;
            const isDirty = t.savedContent !== undefined ? t.savedContent !== content : true;
            return { ...t, content, isDirty, isPreview: isDirty ? false : t.isPreview };
          };
          return {
            tabs: state.tabs.map(update),
            splitTabs: state.splitTabs.map(update),
          };
        });
      },

      markTabSaved: (tabId) => {
        set((state) => {
          const update = (t: IWorkspaceTab) => {
            if (t.id !== tabId) return t;
            return { ...t, savedContent: t.content, isDirty: false };
          };
          return {
            tabs: state.tabs.map(update),
            splitTabs: state.splitTabs.map(update),
          };
        });
      },

      setTabContentLoaded: (tabId, content, isBinary) => {
        set((state) => {
          const update = (t: IWorkspaceTab) => {
            if (t.id !== tabId) return t;
            return {
              ...t,
              content,
              savedContent: content,
              isDirty: false,
              isBinary: isBinary !== undefined ? isBinary : t.isBinary,
              isContentLoaded: true,
            };
          };
          return {
            tabs: state.tabs.map(update),
            splitTabs: state.splitTabs.map(update),
          };
        });
      },

      updateChatTabTitle: (conversationUuid, title) => {
        if (!conversationUuid || !title) return;
        const cleanTitle = cleanTabTitle(title);
        if (!cleanTitle) return;
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.type === "chat" && t.conversationUuid === conversationUuid
              ? { ...t, title: cleanTitle }
              : t
          ),
          splitTabs: state.splitTabs.map((t) =>
            t.type === "chat" && t.conversationUuid === conversationUuid
              ? { ...t, title: cleanTitle }
              : t
          ),
        }));
      },

      updateChatTabUuid: (oldTabId, newConversationUuid, title) => {
        set((state) => {
          const cleanTitle = title ? cleanTabTitle(title) : undefined;
          const updateTab = (t: IWorkspaceTab) =>
            t.id === oldTabId
              ? {
                  ...t,
                  id: `chat-${newConversationUuid}`,
                  conversationUuid: newConversationUuid,
                  title:
                    cleanTitle ||
                    (t.title !== "New Chat" ? t.title : "New Conversation"),
                }
              : t;

          return {
            tabs: state.tabs.map(updateTab),
            splitTabs: state.splitTabs.map(updateTab),
            activeTabId:
              state.activeTabId === oldTabId
                ? `chat-${newConversationUuid}`
                : state.activeTabId,
            activeSplitTabId:
              state.activeSplitTabId === oldTabId
                ? `chat-${newConversationUuid}`
                : state.activeSplitTabId,
          };
        });
      },
    }),
    {
      name: "nr_workspace_tabs",
      storage: createJSONStorage(() =>
        typeof window !== "undefined"
          ? window.sessionStorage
          : {
              getItem: () => null,
              setItem: () => {},
              removeItem: () => {},
            }
      ),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Older versions could put terminals in the chat pane, where the drawer
        // could not select them. Move those sessions into the tools panel.
        const misplaced = state.tabs.filter((tab) => tab.type === "terminal");
        if (!misplaced.length) return;
        const activeMoved = misplaced.find((tab) => tab.id === state.activeTabId);
        state.tabs = state.tabs.filter((tab) => tab.type !== "terminal");
        if (!state.tabs.length) state.tabs = [{ id: "chat-default", type: "chat", title: "New Chat" }];
        const rightIds = new Set(state.splitTabs.map((tab) => tab.id));
        state.splitTabs = [...state.splitTabs, ...misplaced.filter((tab) => !rightIds.has(tab.id))];
        if (activeMoved) {
          state.activeTabId = state.tabs[0].id;
          state.activeSplitTabId = activeMoved.id;
          state.isSplit = true;
          state.focusedPane = "right";
        }
      },
      partialize: (state) => {
        return {
          tabs: state.tabs.map((t) => ({
            id: t.id,
            type: t.type,
            title: t.title,
            conversationUuid: t.conversationUuid,
            fileUuid: t.fileUuid,
            filePath: t.filePath,
            fileSize: t.fileSize,
            isBinary: t.isBinary,
          })),
          activeTabId: state.activeTabId,
          splitTabs: state.splitTabs.map((t) => ({
            id: t.id,
            type: t.type,
            title: t.title,
            conversationUuid: t.conversationUuid,
            fileUuid: t.fileUuid,
            filePath: t.filePath,
            fileSize: t.fileSize,
            isBinary: t.isBinary,
          })),
          activeSplitTabId: state.activeSplitTabId,
          isSplit: state.isSplit,
          splitRatio: state.splitRatio,
          focusedPane: state.focusedPane,
        };
      },
    }
  )
);

export default useWorkspaceTabsStore;
