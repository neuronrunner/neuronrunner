import { env } from "@/lib/env";
import { create } from "zustand";
import axios from "axios";
import type { IApiKey } from "@/types/api-key";
import type { IRequest, IRequestStats } from "@/types/request";

export type SettingsTab =
  | 'profile'
  | 'workspace'
  | 'team'
  | 'provider-keys'
  | 'secrets'
  | 'logs'
  | 'personalization'
  | 'security'
  | 'api-keys';

const DEFAULT_ITEMS_PER_PAGE = 25;

const DEFAULT_USAGE_DATE_RANGE_DAYS = 30;

const getDefaultUsageDateRange = () => {
  const now = new Date();
  const from = new Date(
    now.getTime() - DEFAULT_USAGE_DATE_RANGE_DAYS * 24 * 60 * 60 * 1000
  )
    .toISOString()
    .split("T")[0];
  const to = now.toISOString().split("T")[0];
  return { from, to };
};

interface SettingsState {
  firstName: string;
  setFirstName: (v: string) => void;
  lastName: string;
  setLastName: (v: string) => void;
  loading: boolean;
  setLoading: (v: boolean) => void;

  settingsDialogOpen: boolean;
  setSettingsDialogOpen: (open: boolean, tab?: SettingsTab) => void;
  settingsDialogTab: SettingsTab;
  setSettingsDialogTab: (tab: SettingsTab) => void;

  currentPassword: string;
  setCurrentPassword: (v: string) => void;
  newPassword: string;
  setNewPassword: (v: string) => void;
  confirmNewPassword: string;
  setConfirmNewPassword: (v: string) => void;
  passwordLoading: boolean;
  setPasswordLoading: (v: boolean) => void;
  resetPasswordFields: () => void;

  profilePhoto: File | string | null;
  setProfilePhoto: (file: File | string | null) => void;
  bio: string;
  setBio: (bio: string) => void;
  username: string;
  setUsername: (v: string) => void;
  hydrating: boolean;
  setHydrating: (v: boolean) => void;
  hydrateProfile: (token: string) => Promise<void>;

  // API Keys
  apiKeys: IApiKey[];
  apiKeysLoading: boolean;
  apiKeyCreating: boolean;
  newlyCreatedKey: string | null;
  setNewlyCreatedKey: (v: string | null) => void;
  fetchApiKeys: (token: string) => Promise<void>;
  createApiKey: (token: string, name: string) => Promise<void>;
  deleteApiKey: (token: string, keyId: string) => Promise<void>;
  toggleApiKeyStatus: (token: string, keyId: string, isActive: boolean) => Promise<void>;

  // Profile & auth actions
  saveProfile: (token: string, username: string, setAuthUser: (u: any) => void) => Promise<any>;
  changePassword: (token: string) => Promise<void>;

  // Personalization
  preferredName: string;
  setPreferredName: (v: string) => void;
  memoryEnabled: boolean;
  setMemoryEnabled: (v: boolean) => void;
  terminalIdleTimeout: number;
  setTerminalIdleTimeout: (v: number) => void;
  memories: { uuid: string; content: string; category: string | null; label: string | null; importance_score: number; created_at: string; updated_at: string; last_accessed_at?: string | null }[];
  memoriesLoading: boolean;
  fetchMemories: (token: string) => Promise<void>;
  addMemory: (token: string, data: { content: string; category?: string | null; label?: string | null; importance_score?: number }) => Promise<void>;
  updateMemory: (token: string, memoryId: string, data: { content?: string; category?: string | null; label?: string | null; importance_score?: number }) => Promise<void>;
  deleteMemory: (token: string, memoryId: string) => Promise<void>;
  deleteAllMemories: (token: string) => Promise<void>;
  savePersonalization: (token: string) => Promise<void>;
  personalizationLoading: boolean;

  // Agent Notes (Hermes-style memory store)
  notes: { uuid: string; content: string; category: string | null; importance_score: number; created_at: string; updated_at: string; last_accessed_at?: string | null }[];
  notesLoading: boolean;
  fetchNotes: (token: string, sandboxUuid?: string) => Promise<void>;
  addNote: (token: string, data: { content: string; category?: string | null; importance_score?: number; sandbox_uuid?: string }) => Promise<void>;
  updateNote: (token: string, noteId: string, data: { content: string; category?: string | null; importance_score?: number; sandbox_uuid?: string }) => Promise<void>;
  deleteNote: (token: string, noteId: string, sandboxUuid?: string) => Promise<void>;
  deleteNoteByOldText: (token: string, oldText: string, sandboxUuid?: string) => Promise<void>;

  // Usage/Requests
  requests: IRequest[];
  requestsLoading: boolean;
  totalRequests?: number; // Total request count from backend
  requestStats?: IRequestStats;
  usageDateRange: { from: string; to: string };
  setUsageDateRange: (range: { from: string; to: string }) => void;
  usageCurrentPage: number;
  setUsageCurrentPage: (page: number) => void;
  usageIsInitialLoad: boolean;
  setUsageIsInitialLoad: (isInitialLoad: boolean) => void;
  fetchRequests: (token: string, itemsPerPage?: number, page?: number, from?: string, to?: string) => Promise<void>;
  fetchRequestStats: (token: string, from?: string, to?: string) => Promise<void>;
}

const useSettingsStore = create<SettingsState>((set, get) => ({
  firstName: "",
  setFirstName: (v) => set({ firstName: v }),
  lastName: "",
  setLastName: (v) => set({ lastName: v }),
  bio: "",
  setBio: (bio) => set({ bio }),
  loading: false,
  setLoading: (v) => set({ loading: v }),

  settingsDialogOpen: false,
  setSettingsDialogOpen: (open: boolean, tab?: SettingsTab) =>
    set((state) => ({
      settingsDialogOpen: open,
      settingsDialogTab: tab || state.settingsDialogTab,
    })),
  settingsDialogTab: 'workspace',
  setSettingsDialogTab: (tab: SettingsTab) => set({ settingsDialogTab: tab }),

  hydrating: false,
  setHydrating: (v) => set({ hydrating: v }),

  currentPassword: "",
  setCurrentPassword: (v) => set({ currentPassword: v }),
  newPassword: "",
  setNewPassword: (v) => set({ newPassword: v }),
  confirmNewPassword: "",
  setConfirmNewPassword: (v) => set({ confirmNewPassword: v }),
  passwordLoading: false,
  setPasswordLoading: (v) => set({ passwordLoading: v }),
  resetPasswordFields: () =>
    set({
      currentPassword: "",
      newPassword: "",
      confirmNewPassword: "",
    }),

  profilePhoto: null,
  setProfilePhoto: (file) => set({ profilePhoto: file }),

  username: "",
  setUsername: (v) => set({ username: v }),

  // Personalization
  preferredName: "",
  setPreferredName: (v) => set({ preferredName: v }),
  memoryEnabled: true,
  setMemoryEnabled: (v) => set({ memoryEnabled: v }),
  terminalIdleTimeout: typeof window !== "undefined" ? Number(localStorage.getItem("terminalIdleTimeout") || 60) : 60,
  setTerminalIdleTimeout: (v) => {
    if (typeof window !== "undefined") {
      localStorage.setItem("terminalIdleTimeout", String(v));
    }
    set({ terminalIdleTimeout: v });
  },
  memories: [],
  memoriesLoading: false,
  personalizationLoading: false,

  // Agent Notes
  notes: [],
  notesLoading: false,

  // API Keys
  apiKeys: [],
  apiKeysLoading: false,
  apiKeyCreating: false,
  newlyCreatedKey: null,
  setNewlyCreatedKey: (v) => set({ newlyCreatedKey: v }),

  // Usage/Requests
  requests: [],
  requestsLoading: false,
  totalRequests: 0,
  usageDateRange: getDefaultUsageDateRange(),
  setUsageDateRange: (range) => set({ usageDateRange: range }),
  usageCurrentPage: 1,
  setUsageCurrentPage: (page) => set({ usageCurrentPage: page }),
  usageIsInitialLoad: true,
  setUsageIsInitialLoad: (usageIsInitialLoad) => set({ usageIsInitialLoad }),
  fetchApiKeys: async (token: string) => {
    set({ apiKeysLoading: true });
    try {
      const response = await axios.get(
        `${env.API_URL}/users/api-keys/`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      set({ apiKeys: response.data });
    } catch {
      // Silent error
    } finally {
      set({ apiKeysLoading: false });
    }
  },

  createApiKey: async (token: string, name: string) => {
    set({ apiKeyCreating: true });
    try {
      const response = await axios.post(
        `${env.API_URL}/users/api-keys/`,
        { name },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      set({ newlyCreatedKey: response.data.key });
      // Refresh list
      get().fetchApiKeys(token);
    } catch (error: any) {
      // Silent error
    } finally {
      set({ apiKeyCreating: false });
    }
  },

  deleteApiKey: async (token: string, keyId: string) => {
    try {
      await axios.delete(
        `${env.API_URL}/users/api-keys/${keyId}/`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      set({ apiKeys: get().apiKeys.filter((k) => k.id !== keyId) });
    } catch {
      // Silent error
    }
  },

  toggleApiKeyStatus: async (token: string, keyId: string, isActive: boolean) => {
    try {
      // Optimistic update
      set({
        apiKeys: get().apiKeys.map((k) =>
          k.id === keyId ? { ...k, is_active: isActive } : k
        ),
      });

      await axios.patch(
        `${env.API_URL}/users/api-keys/${keyId}/`,
        { is_active: isActive },
        { headers: { Authorization: `Bearer ${token}` } }
      );
    } catch {
      // Revert on failure
      set({
        apiKeys: get().apiKeys.map((k) =>
          k.id === keyId ? { ...k, is_active: !isActive } : k
        ),
      });
    }
  },

  fetchRequests: async (token: string, itemsPerPage: number = DEFAULT_ITEMS_PER_PAGE, page: number = 1, from?: string, to?: string) => {
    set({ requestsLoading: true });
    try {
      const params: Record<string, any> = {
        limit: itemsPerPage,
        offset: (page - 1) * itemsPerPage,
      };

      if (from) params.from = from + " 00:00:00";
      if (to) params.to = to + " 23:59:59";

      const response = await axios.get(
        `${env.API_URL}/requests/`,
        { headers: { Authorization: `Bearer ${token}` }, params }
      );
      set({ requests: response.data.requests, totalRequests: response.data.total });
    } catch {
      // Silent error
    } finally {
      set({ requestsLoading: false });
    }
  },

  fetchRequestStats: async (token: string, from?: string, to?: string) => {
    try {
      const params: Record<string, any> = {};
      if (from) params.from = from + " 00:00:00";
      if (to) params.to = to + " 23:59:59";

      const response = await axios.get(
        `${env.API_URL}/requests/stats/`,
        { headers: { Authorization: `Bearer ${token}` }, params }
      );
      set({ requestStats: response.data });
    } catch (error) {
      // Silent error
    }
  },

  hydrateProfile: async (token: string) => {
    set({ hydrating: true });
    try {
      const response = await axios.get(
        `${env.API_URL}/users/me/`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      get().setFirstName(response.data.first_name || "");
      get().setLastName(response.data.last_name || "");
      set({ username: response.data.username || "" });
      get().setProfilePhoto(response.data.profile_picture || null);
      get().setBio(response.data.bio || "");
      set({ preferredName: response.data.preferred_name || "" });
      set({ memoryEnabled: response.data.memory_enabled ?? true });
    } catch (e) {
      // Handle error if needed
    } finally {
      set({ hydrating: false });
    }
  },

  saveProfile: async (token: string, username: string, setAuthUser: (u: any) => void) => {
    set({ loading: true });
    try {
      const { firstName, lastName, bio, profilePhoto } = get();
      let response;

      if (profilePhoto instanceof File) {
        const formData = new FormData();
        formData.append("first_name", firstName);
        formData.append("last_name", lastName);
        formData.append("username", username);
        formData.append("bio", bio);
        formData.append("profile_picture", profilePhoto);

        response = await axios.patch(
          `${env.API_URL}/users/me/`,
          formData,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );
      } else {
        const payload: Record<string, any> = {
          first_name: firstName,
          last_name: lastName,
          username: username,
          bio: bio,
        };
        if (profilePhoto === null) {
          payload.profile_picture = "";
        }

        response = await axios.patch(
          `${env.API_URL}/users/me/`,
          payload,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );
      }

      setAuthUser(response.data);
      if (response.data.profile_picture !== undefined) {
        set({ profilePhoto: response.data.profile_picture || null });
      }
      return response.data;
    } finally {
      set({ loading: false });
    }
  },

  changePassword: async (token: string) => {
    if (!get().currentPassword || !get().newPassword || !get().confirmNewPassword) {
      return;
    }
    if (get().newPassword !== get().confirmNewPassword) {
      return;
    }
    set({ passwordLoading: true });
    try {
      await axios.post(
        `${env.API_URL}/users/change-password/`,
        {
          current_password: get().currentPassword,
          new_password: get().newPassword,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );
      get().resetPasswordFields();
    } catch (error: any) {
      // Silent error
    } finally {
      set({ passwordLoading: false });
    }
  },

  fetchMemories: async (token: string) => {
    set({ memoriesLoading: true });
    try {
      const response = await axios.get(
        `${env.API_URL}/memories/`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      set({ memories: response.data });
    } catch {
      // Silent error
    } finally {
      set({ memoriesLoading: false });
    }
  },

  addMemory: async (token: string, data: { content: string; category?: string | null; label?: string | null; importance_score?: number }) => {
    try {
      const response = await axios.post(
        `${env.API_URL}/memories/`,
        data,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const created = response.data;
      const existing = get().memories;
      if (existing.some((m) => m.uuid === created.uuid)) {
        set({
          memories: existing.map((m) => (m.uuid === created.uuid ? { ...m, ...created } : m)),
        });
      } else {
        set({ memories: [created, ...existing] });
      }
    } catch {
      // Silent error
    }
  },

  deleteMemory: async (token: string, memoryId: string) => {
    try {
      await axios.delete(
        `${env.API_URL}/memories/${memoryId}/`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      set({ memories: get().memories.filter((m) => m.uuid !== memoryId) });
    } catch {
      // Silent error
    }
  },

  updateMemory: async (token: string, memoryId: string, data: { content?: string; category?: string | null; label?: string | null; importance_score?: number }) => {
    try {
      const response = await axios.patch(
        `${env.API_URL}/memories/${memoryId}/update/`,
        data,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      set({
        memories: get().memories.map((m) =>
          m.uuid === memoryId ? { ...m, ...response.data } : m
        ),
      });
    } catch {
      // Silent error
    }
  },

  deleteAllMemories: async (token: string) => {
    try {
      await axios.delete(
        `${env.API_URL}/memories/all/`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      set({ memories: [] });
    } catch {
      // Silent error
    }
  },

  // ─── Agent Notes ──────────────────────────────────────────────────────

  fetchNotes: async (token: string, sandboxUuid?: string) => {
    set({ notesLoading: true });
    try {
      const url = sandboxUuid
        ? `${env.API_URL}/tools/note/list/?sandbox_uuid=${sandboxUuid}`
        : `${env.API_URL}/tools/note/list/`;
      const response = await axios.get(
        url,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      set({ notes: response.data.notes || [] });
    } catch {
      // Silent error
    } finally {
      set({ notesLoading: false });
    }
  },

  addNote: async (token: string, data: { content: string; category?: string | null; importance_score?: number; sandbox_uuid?: string }) => {
    try {
      await axios.post(
        `${env.API_URL}/tools/note/add/`,
        data,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      await get().fetchNotes(token, data.sandbox_uuid);
    } catch (error: any) {
      // Silent error
    }
  },

  updateNote: async (token: string, noteId: string, data: { content: string; category?: string | null; importance_score?: number; sandbox_uuid?: string }) => {
    try {
      const response = await axios.post(
        `${env.API_URL}/tools/note/replace/`,
        {
          uuid: noteId,
          new_content: data.content,
          category: data.category,
          importance_score: data.importance_score,
          sandbox_uuid: data.sandbox_uuid,
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      set({
        notes: get().notes.map((n) =>
          n.uuid === noteId ? { ...n, ...response.data } : n
        ),
      });
    } catch {
      // Silent error
    }
  },

  deleteNote: async (token: string, noteId: string, sandboxUuid?: string) => {
    try {
      await axios.post(
        `${env.API_URL}/tools/note/remove/`,
        { uuid: noteId, sandbox_uuid: sandboxUuid },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      set({ notes: get().notes.filter((n) => n.uuid !== noteId) });
    } catch {
      // Silent error
    }
  },

  deleteNoteByOldText: async (token: string, oldText: string, sandboxUuid?: string) => {
    try {
      await axios.post(
        `${env.API_URL}/tools/note/remove/`,
        { old_text: oldText, sandbox_uuid: sandboxUuid },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      await get().fetchNotes(token, sandboxUuid);
    } catch (error: any) {
      // Silent error
    }
  },

  savePersonalization: async (token: string) => {
    set({ personalizationLoading: true });
    try {
      await axios.patch(
        `${env.API_URL}/users/me/`,
        {
          preferred_name: get().preferredName,
          memory_enabled: get().memoryEnabled,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );
    } catch {
      // Silent error
    } finally {
      set({ personalizationLoading: false });
    }
  },
}));

export default useSettingsStore;
