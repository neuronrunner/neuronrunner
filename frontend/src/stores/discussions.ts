import { env } from "@/lib/env";
import { create } from 'zustand';
import axios from 'axios';
import { toaster } from '@/components/ui/toaster';
import i18n from '@/i18n';
import type { DiscussionThread, DiscussionReply } from '@/types/discussion';

interface DiscussionsState {
  // State
  threads: DiscussionThread[];
  selectedThread: DiscussionThread | null;
  replies: DiscussionReply[];
  isLoadingThreads: boolean;
  isLoadingReplies: boolean;
  isCreatingDiscussion: boolean;
  newDiscussionTitle: string;
  newDiscussionBody: string;
  isSubmittingDiscussion: boolean;
  newReplyBody: string;
  isSubmittingReply: boolean;

  // Setters
  setThreads: (threads: DiscussionThread[]) => void;
  setSelectedThread: (thread: DiscussionThread | null) => void;
  setReplies: (replies: DiscussionReply[]) => void;
  setIsCreatingDiscussion: (isCreating: boolean) => void;
  setNewDiscussionTitle: (title: string) => void;
  setNewDiscussionBody: (body: string) => void;
  setNewReplyBody: (body: string) => void;

  // Actions
  loadThreads: (modelName: string, token?: string | null) => Promise<void>;
  loadReplies: (modelName: string, threadUuid: string, token?: string | null) => Promise<void>;
  createDiscussion: (modelName: string, token: string) => Promise<void>;
  deleteThread: (modelName: string, uuid: string, token: string) => Promise<void>;
  postReply: (modelName: string, token: string) => Promise<void>;
  deleteReply: (modelName: string, replyUuid: string, token: string) => Promise<void>;
  reset: () => void;
}

const apiBase = env.API_URL;

const useDiscussionsStore = create<DiscussionsState>((set, get) => ({
  // Initial state
  threads: [],
  selectedThread: null,
  replies: [],
  isLoadingThreads: false,
  isLoadingReplies: false,
  isCreatingDiscussion: false,
  newDiscussionTitle: '',
  newDiscussionBody: '',
  isSubmittingDiscussion: false,
  newReplyBody: '',
  isSubmittingReply: false,

  // Setters
  setThreads: (threads) => set({ threads }),
  setSelectedThread: (thread) => set({ selectedThread: thread }),
  setReplies: (replies) => set({ replies }),
  setIsCreatingDiscussion: (isCreating) => set({ isCreatingDiscussion: isCreating }),
  setNewDiscussionTitle: (title) => set({ newDiscussionTitle: title }),
  setNewDiscussionBody: (body) => set({ newDiscussionBody: body }),
  setNewReplyBody: (body) => set({ newReplyBody: body }),

  // Actions
  loadThreads: async (modelName: string, token?: string | null) => {
    if (!apiBase) return;
    const modelNameEncoded = encodeURIComponent(modelName);
    
    try {
      set({ isLoadingThreads: true });
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await axios.get(`${apiBase}/models/${modelNameEncoded}/discussions/`, { headers });
      const items = res.data as DiscussionThread[];
      
      set((state) => {
        const selectedThread = state.selectedThread 
          ? items.find((t) => t.uuid === state.selectedThread?.uuid) || items[0] || null
          : items[0] || null;
        
        return {
          threads: items,
          selectedThread,
        };
      });
    } catch (e) {
      console.error('Failed to load discussions', e);
      toaster.create({
        title: i18n.t('auth:discussions.toasts.loadFailed'),
        type: 'error',
      });
    } finally {
      set({ isLoadingThreads: false });
    }
  },

  loadReplies: async (modelName: string, threadUuid: string, token?: string | null) => {
    if (!apiBase) return;
    const modelNameEncoded = encodeURIComponent(modelName);
    
    try {
      set({ isLoadingReplies: true });
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await axios.get(`${apiBase}/models/${modelNameEncoded}/discussions/${threadUuid}/replies/`, { headers });
      set({ replies: res.data as DiscussionReply[] });
    } catch (e) {
      console.error('Failed to load replies', e);
      toaster.create({
        title: i18n.t('auth:discussions.toasts.loadRepliesFailed'),
        type: 'error',
      });
    } finally {
      set({ isLoadingReplies: false });
    }
  },

  createDiscussion: async (modelName: string, token: string) => {
    const { newDiscussionTitle, newDiscussionBody } = get();
    
    if (!newDiscussionTitle.trim() || !newDiscussionBody.trim()) {
      toaster.create({ title: i18n.t('auth:discussions.toasts.titleAndBodyRequired'), type: 'error' });
      return;
    }

    if (!apiBase) {
      toaster.create({ title: i18n.t('auth:discussions.toasts.apiUrlMissing'), type: 'error' });
      return;
    }

    if (!token) {
      toaster.create({ title: i18n.t('auth:discussions.toasts.signInToCreate'), type: 'error' });
      return;
    }

    const modelNameEncoded = encodeURIComponent(modelName);

    try {
      set({ isSubmittingDiscussion: true });
      const res = await axios.post(
        `${apiBase}/models/${modelNameEncoded}/discussions/`,
        {
          title: newDiscussionTitle.trim(),
          body: newDiscussionBody.trim(),
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );
      toaster.create({ title: i18n.t('auth:discussions.toasts.created'), type: 'success' });
      const newThread = res.data as DiscussionThread;
      
      set((state) => ({
        threads: [newThread, ...state.threads],
        selectedThread: newThread,
        newDiscussionTitle: '',
        newDiscussionBody: '',
        isCreatingDiscussion: false,
      }));
    } catch (error) {
      console.error('Failed to create discussion', error);
      toaster.create({ title: i18n.t('auth:discussions.toasts.createFailed'), type: 'error' });
    } finally {
      set({ isSubmittingDiscussion: false });
    }
  },

  deleteThread: async (modelName: string, uuid: string, token: string) => {
    if (!apiBase) return;
    if (!token) return;

    const modelNameEncoded = encodeURIComponent(modelName);

    try {
      await axios.delete(`${apiBase}/models/${modelNameEncoded}/discussions/${uuid}/`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      
      set((state) => ({
        threads: state.threads.filter((t) => t.uuid !== uuid),
        selectedThread: state.selectedThread?.uuid === uuid ? null : state.selectedThread,
        replies: state.selectedThread?.uuid === uuid ? [] : state.replies,
      }));
    } catch (e) {
      console.error('Failed to delete discussion', e);
      toaster.create({
        title: i18n.t('auth:discussions.toasts.deleteFailed'),
        type: 'error',
      });
    }
  },

  postReply: async (modelName: string, token: string) => {
    const { newReplyBody, selectedThread } = get();
    const body = newReplyBody.trim();
    
    if (!body) return;
    if (!apiBase) return;
    if (!selectedThread) return;
    if (!token) {
      toaster.create({
        title: i18n.t('auth:discussions.toasts.signInToReply'),
        type: 'error',
      });
      return;
    }

    const modelNameEncoded = encodeURIComponent(modelName);

    try {
      set({ isSubmittingReply: true });
      const res = await axios.post(
        `${apiBase}/models/${modelNameEncoded}/discussions/${selectedThread.uuid}/replies/`,
        { body },
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );
      const created = res.data as DiscussionReply;
      
      set((state) => ({
        replies: [...state.replies, created],
        newReplyBody: '',
        threads: state.threads.map((t) =>
          t.uuid === selectedThread.uuid ? { ...t, reply_count: (t.reply_count ?? 0) + 1 } : t
        ),
      }));
    } catch (e) {
      console.error('Failed to post reply', e);
      toaster.create({
        title: i18n.t('auth:discussions.toasts.replyFailed'),
        type: 'error',
      });
    } finally {
      set({ isSubmittingReply: false });
    }
  },

  deleteReply: async (modelName: string, replyUuid: string, token: string) => {
    if (!apiBase) return;
    if (!token) return;

    const { selectedThread } = get();
    if (!selectedThread) return;

    const modelNameEncoded = encodeURIComponent(modelName);

    try {
      await axios.delete(
        `${apiBase}/models/${modelNameEncoded}/discussions/${selectedThread.uuid}/replies/${replyUuid}/`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );
      
      set((state) => ({
        replies: state.replies.filter((r) => r.uuid !== replyUuid),
        threads: state.threads.map((t) =>
          t.uuid === selectedThread.uuid
            ? { ...t, reply_count: Math.max(0, (t.reply_count ?? 0) - 1) }
            : t
        ),
      }));
    } catch (e) {
      console.error('Failed to delete reply', e);
      toaster.create({
        title: i18n.t('auth:discussions.toasts.deleteReplyFailed'),
        type: 'error',
      });
    }
  },

  reset: () => set({
    threads: [],
    selectedThread: null,
    replies: [],
    isLoadingThreads: false,
    isLoadingReplies: false,
    isCreatingDiscussion: false,
    newDiscussionTitle: '',
    newDiscussionBody: '',
    isSubmittingDiscussion: false,
    newReplyBody: '',
    isSubmittingReply: false,
  }),
}));

export default useDiscussionsStore;
