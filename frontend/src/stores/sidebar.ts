import { env } from "@/lib/env";
import axios from "axios";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { authedAxios } from "@/lib/axios";
import useWorkspaceTabsStore from "./workspace-tabs";
import useSandboxProjectsStore from "./sandbox-projects";

export const DEFAULT_SIDEBAR_WIDTH = 310;
export const MIN_SIDEBAR_WIDTH = 240;
export const MAX_SIDEBAR_WIDTH = 520;

export interface Conversation {
    uuid: string;
    title: string;
    can_edit?: boolean;
    is_generating?: boolean;
    created_at?: string;
    last_activity_at?: string;
}

interface SidebarStore {
    isOpen: boolean;
    toggle: () => void;
    setOpen: (open: boolean) => void;
    conversations: Conversation[];
    projectConversations: Record<string, Conversation[]>;
    generalConversations: Conversation[];
    generalHistoryProjectId: string | null;
    isHistoryLoading: boolean;
    isHistoryLoadingMore: boolean;
    historyHasMore: boolean;
    historyOffset: number;
    historyRequestId: number;
    historyAbortController: AbortController | null;
    fetchGeneralConversations: (append?: boolean, filesystemUuid?: string) => Promise<void>;
    setConversations: (conversations: Conversation[]) => void;
    setConversationTitle: (uuid: string, title: string, options?: { insertIfMissing?: boolean }) => void;
    moveConversationToTop: (uuid: string) => void;
    isLoading: boolean;
    isLoadingMore: boolean;
    hasMore: boolean;
    offset: number;
    pageSize: number;
    abortController: AbortController | null;
    requestId: number;
    conversationProjectId: string | null;
    fetchConversations: (append?: boolean, projectUuid?: string) => Promise<void>;
    renameConversation: (uuid: string, newTitle: string) => Promise<void>;
    deleteConversation: (uuid: string) => Promise<void>;
    avatarExpanded: boolean;
    toggleAvatar: () => void;
    setAvatarExpanded: (expanded: boolean) => void;
    width: number;
    setWidth: (width: number) => void;
}

const useSidebarStore = create<SidebarStore>()(
    persist(
    (set, get) => ({
    isOpen: false,
    width: DEFAULT_SIDEBAR_WIDTH,
    setWidth: (width: number) => {
        const clamped = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width));
        set({ width: clamped });
    },
    toggle: () => set((state) => ({ isOpen: !state.isOpen })),
    setOpen: (open: boolean) => set({ isOpen: open }),
    conversations: [],
    projectConversations: {},
    generalConversations: [],
    generalHistoryProjectId: null,
    isHistoryLoading: false,
    isHistoryLoadingMore: false,
    historyHasMore: false,
    historyOffset: 0,
    historyRequestId: 0,
    historyAbortController: null,
    setConversations: (conversations) => set({ conversations }),
    setConversationTitle: (uuid: string, title: string, options) => {
        if (!uuid || !title) return;
        try {
            useWorkspaceTabsStore.getState().updateChatTabTitle(uuid, title);
        } catch {}
        set((state) => {
            const sandbox = useSandboxProjectsStore.getState();
            const linkedProjects = sandbox.sandboxes.filter((project) =>
                project.conversation === uuid || sandbox.sandboxConversations[project.uuid]?.includes(uuid)
            );
            const existing = state.conversations.find((c) => c.uuid === uuid)
                || state.generalConversations.find((c) => c.uuid === uuid)
                || Object.values(state.projectConversations).flat().find((c) => c.uuid === uuid);
            const conversation = { ...existing, uuid, title };
            const updateList = (items: Conversation[]) => {
                if (items.some((c) => c.uuid === uuid)) {
                    return items.map((c) => c.uuid === uuid ? { ...c, title } : c);
                }
                return options?.insertIfMissing === false ? items : [conversation, ...items];
            };
            const projectConversations = { ...state.projectConversations };
            linkedProjects.forEach((project) => {
                projectConversations[project.uuid] = updateList(projectConversations[project.uuid] || []);
            });
            const belongsToHistory = linkedProjects.length === 0 && (
                state.generalConversations.some((c) => c.uuid === uuid)
                || Boolean(state.generalHistoryProjectId && sandbox.sandboxConversations[state.generalHistoryProjectId]?.includes(uuid))
            );
            return {
                conversations: updateList(state.conversations),
                projectConversations,
                generalConversations: belongsToHistory
                    ? updateList(state.generalConversations)
                    : state.generalConversations.filter((c) => c.uuid !== uuid),
            };
        });
    },
    moveConversationToTop: (uuid: string) => {
        const state = get();
        const isListed = [...state.conversations, ...state.generalConversations, ...Object.values(state.projectConversations).flat()]
            .some((conversation) => conversation.uuid === uuid);
        if (!isListed) {
            const tabs = useWorkspaceTabsStore.getState();
            const tab = [...tabs.tabs, ...tabs.splitTabs].find((tab) => tab.type === "chat" && tab.conversationUuid === uuid);
            if (tab?.title) get().setConversationTitle(uuid, tab.title);
        }
        set((state) => {
            const moveToTop = (items: Conversation[]) => {
                const index = items.findIndex((conversation) => conversation.uuid === uuid);
                if (index <= 0) return items;
                return [items[index], ...items.slice(0, index), ...items.slice(index + 1)];
            };
            return {
                conversations: moveToTop(state.conversations),
                generalConversations: moveToTop(state.generalConversations),
                projectConversations: Object.fromEntries(Object.entries(state.projectConversations).map(([projectId, items]) =>
                    [projectId, moveToTop(items)]
                )),
            };
        });
    },
    isLoading: false,
    isLoadingMore: false,
    hasMore: true,
    offset: 0,
    pageSize: 20,
    abortController: null,
    requestId: 0,
    conversationProjectId: null,
    avatarExpanded: false,
    toggleAvatar: () => set((state) => ({ avatarExpanded: !state.avatarExpanded })),
    setAvatarExpanded: (expanded: boolean) => set({ avatarExpanded: expanded }),
    fetchGeneralConversations: async (append = false, filesystemUuid) => {
        const state = get();
        const targetId = filesystemUuid ?? state.generalHistoryProjectId;
        if (!targetId) return;
        if (append && (state.isHistoryLoading || state.isHistoryLoadingMore || !state.historyHasMore)) return;
        if (!append) state.historyAbortController?.abort();
        const controller = new AbortController();
        const requestId = state.historyRequestId + 1;
        const offset = append ? state.historyOffset : 0;
        set({
            historyAbortController: controller,
            historyRequestId: requestId,
            isHistoryLoading: !append,
            isHistoryLoadingMore: append,
            ...(append ? {} : { generalConversations: [], generalHistoryProjectId: targetId, historyOffset: 0, historyHasMore: false }),
        });
        try {
            const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
            const response = await (authedAxios || axios).get(`${env.API_URL}/conversations/`, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
                signal: controller.signal,
                params: { project_uuid: targetId, general_only: true, limit: state.pageSize, offset },
            });
            if (get().historyRequestId !== requestId) return;
            const items: Conversation[] = response.data.conversations || [];
            set((current) => ({
                generalConversations: append ? [...current.generalConversations, ...items] : items,
                historyHasMore: response.data.has_next ?? false,
                historyOffset: response.data.next_offset ?? offset + items.length,
            }));
        } catch (error) {
            if (!controller.signal.aborted) console.error("Error fetching general history:", error);
        } finally {
            if (get().historyRequestId === requestId) {
                set({ isHistoryLoading: false, isHistoryLoadingMore: false, historyAbortController: null });
            }
        }
    },
    fetchConversations: async (append = false, projectUuid) => {
        const {
            abortController: prevController,
            requestId: prevRequestId,
            isLoading,
            isLoadingMore,
            hasMore,
            offset,
            pageSize,
            conversationProjectId,
        } = get();

        const targetProjectId = projectUuid ?? conversationProjectId ?? undefined;

        if (append) {
            if (isLoading || isLoadingMore || !hasMore) return;
        } else if (prevController) {
            prevController.abort();
        }

        const controller = new AbortController();
        const newRequestId = prevRequestId + 1;
        set({
            abortController: controller,
            isLoading: append ? isLoading : true,
            isLoadingMore: append,
            requestId: newRequestId,
            ...(append ? {} : {
                hasMore: true,
                offset: 0,
                conversations: [],
                conversationProjectId: targetProjectId || null,
            }),
        });

        try {
            const client = authedAxios || axios;
            const token = typeof window !== "undefined" ? localStorage.getItem('token') : null;
            const headers = token ? { Authorization: `Bearer ${token}` } : {};
            const response = await client.get(`${env.API_URL}/conversations/`, {
                headers,
                signal: controller.signal,
                params: {
                    limit: pageSize,
                    offset: append ? offset : 0,
                    project_uuid: targetProjectId,
                }
            });

            const items = response.data.conversations || [];
            const hasNext = response.data.has_next ?? false;
            const nextOffset = typeof response.data.next_offset === 'number'
                ? response.data.next_offset
                : (append ? offset + items.length : items.length);

            if (get().requestId === newRequestId) {
                set((state) => ({
                    conversations: append ? [...(state.conversations || []), ...items] : items,
                    ...(targetProjectId ? { projectConversations: {
                        ...state.projectConversations,
                        [targetProjectId]: append ? [...(state.projectConversations[targetProjectId] || []), ...items] : items,
                    } } : {}),
                    isLoading: false,
                    isLoadingMore: false,
                    abortController: null,
                    hasMore: hasNext,
                    offset: nextOffset,
                }));
            }
        } catch (error) {
            if (controller.signal.aborted) {
                console.log("Fetch aborted");
                if (get().requestId === newRequestId) {
                    set({ isLoading: false, isLoadingMore: false, abortController: null });
                }
            } else {
                console.error("Error fetching conversations:", error);
                if (get().requestId === newRequestId) {
                    set({ isLoading: false, isLoadingMore: false, abortController: null });
                }
            }
        }
    },
    renameConversation: async (uuid: string, newTitle: string) => {
        try {
            await axios.patch(
                `${env.API_URL}/conversations/${uuid}/rename/`,
                { title: newTitle },
                { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } }
            );
            // Update local state
            try {
                useWorkspaceTabsStore.getState().updateChatTabTitle(uuid, newTitle);
            } catch {}
            set((state) => ({
                conversations: state.conversations.map((c) => c.uuid === uuid ? { ...c, title: newTitle } : c),
                generalConversations: state.generalConversations.map((c) => c.uuid === uuid ? { ...c, title: newTitle } : c),
                projectConversations: Object.fromEntries(Object.entries(state.projectConversations).map(([id, items]) =>
                    [id, items.map((c) => c.uuid === uuid ? { ...c, title: newTitle } : c)]
                )),
            }));
        } catch (error) {
            console.error("Error renaming conversation:", error);
            throw error;
        }
    },
    deleteConversation: async (uuid: string) => {
        try {
            await axios.delete(
                `${env.API_URL}/conversations/${uuid}/delete/`,
                { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } }
            );
            // Remove from local state
            try {
                const tabStore = useWorkspaceTabsStore.getState();
                const tabToRemove = [...tabStore.tabs, ...tabStore.splitTabs].find(
                    (t) => t.type === "chat" && t.conversationUuid === uuid
                );
                if (tabToRemove) {
                    tabStore.closeTab(tabToRemove.id);
                }
            } catch {}
            set((state) => ({
                conversations: state.conversations.filter((c) => c.uuid !== uuid),
                generalConversations: state.generalConversations.filter((c) => c.uuid !== uuid),
                projectConversations: Object.fromEntries(Object.entries(state.projectConversations).map(([id, items]) =>
                    [id, items.filter((c) => c.uuid !== uuid)]
                )),
            }));
        } catch (error) {
            console.error("Error deleting conversation:", error);
            throw error;
        }
    },
}), {
    name: "sidebar-storage",
    storage: createJSONStorage(() => typeof window !== "undefined" ? window.localStorage : {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    } as any),
    partialize: (state) => ({ isOpen: state.isOpen, avatarExpanded: state.avatarExpanded, width: state.width }),
}));
export default useSidebarStore;
