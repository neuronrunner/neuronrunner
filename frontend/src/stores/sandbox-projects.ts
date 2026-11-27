"use client";

import { env } from "@/lib/env";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { authedAxios } from "@/lib/axios";
import useAuthStore from "./auth";
import useWorkspacesStore from "./workspaces";
import i18n from "@/i18n";

export interface IProject {
  uuid: string;
  slug: string;
  display_name: string;
  description: string;
  workspace_uuid?: string | null;
  vm_uuid?: string | null;
  vm_name?: string | null;
  filesystem_path: string;
  repo_full_name?: string;
  repo_url?: string;
  default_branch?: string;
  working_subdir?: string;
  setup_script?: string;
  maintenance_script?: string;
  setup_status?: "idle" | "running" | "ready" | "failed";
  setup_last_run_at?: string | null;
  setup_last_log?: string;
  state_saved_at?: string | null;
  state_size_bytes?: number | null;
  deps_lock_hash?: string;
  secret_count?: number;
  usage_guide?: string;
  conversation?: string | null;
  conversation_ids?: string[];
  sandbox_gpu: string;
  sandbox_cpu?: number;
  sandbox_memory?: number;
  sandbox_object_id: string;
  sandbox_last_active_at: string | null;
  r2_workspace_prefix: string;
  idle_timeout_seconds?: number;
  is_favorite: boolean;
  suggestions?: Array<{ label: string; prompt: string; category?: string }>;
  created_at: string;
  updated_at: string;
}

export interface IProjectFile {
  uuid: string;
  path: string;
  file_size_bytes: number;
  sha256: string;
  mime_type: string;
  is_directory: boolean;
  modified_at: string | null;
  created_at: string;
}

export interface ISandboxEvent {
  uuid: string;
  event_type: string;
  payload: Record<string, any>;
  duration_ms: number;
  success: boolean;
  error_message: string;
  created_at: string;
}

const API_BASE = env.API_URL || "";
const sandboxListRequests = new Map<string, Promise<IProject[]>>();
const sandboxListScope = (workspaceUuid: string) => {
  const auth = useAuthStore.getState();
  return `${auth.user?.uuid || auth.token}:${workspaceUuid}`;
};
const resolveWorkspaceUuid = async (workspaceUuid?: string) => {
  let uuid = workspaceUuid || useWorkspacesStore.getState().currentWorkspaceUuid;
  if (!uuid) {
    await useWorkspacesStore.getState().fetchWorkspaces();
    uuid = useWorkspacesStore.getState().currentWorkspaceUuid;
  }
  return uuid;
};
const fileTreeVersions = new Map<string, number>();
const invalidateFileTree = (uuid: string) => fileTreeVersions.set(uuid, (fileTreeVersions.get(uuid) || 0) + 1);

export interface IFileContent {
  uuid: string;
  path: string;
  mime_type: string;
  content: string;
  is_binary: boolean;
  file_size_bytes: number;
}

export interface IGPUOption {
  name: string;
  allowed: boolean;
  tier: string;
  base_cost_per_sec: number;
  base_cost_per_hour: number;
}

export interface IIdleLimits {
  cpu: number;
  gpu: number;
}

export interface FileMutationOptions {
  refresh?: boolean;
  onProgress?: (fraction: number) => void;
}

interface SandboxState {
  // Sandbox metadata & lists
  sandboxes: IProject[];
  sandboxesLoadedFor: string | null;
  currentSandbox: IProject | null;
  workspaceSandbox: IProject | null;
  files: IProjectFile[];
  expandedPaths: string[];
  gpuOptions: IGPUOption[];
  idleTimeoutLimits: IIdleLimits | null;
  idleTimeoutDefault: number;
  idleTimeoutMin: number;

  // Active files open in tabs
  openTabs: { [fileUuid: string]: { file: IProjectFile; initialContent: string; currentContent: string; isDirty: boolean; isContentLoaded: boolean } };
  activeTabUuid: string | null;

  isLoading: boolean;
  isContentLoading: boolean;
  isUploading: boolean;
  errorMessage: string | null;

  isSidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  isSidebarResizing: boolean;
  setSidebarResizing: (resizing: boolean) => void;
  isCreateProjectDialogOpen: boolean;
  setCreateProjectDialogOpen: (open: boolean) => void;
  isTerminalOpen: boolean;
  toggleTerminal: () => void;
  terminalHeight: number;
  setTerminalHeight: (height: number) => void;
  terminals: { id: string; name: string }[];
  activeTerminalId: string | null;
  addTerminal: () => void;
  removeTerminal: (id: string) => void;
  setActiveTerminal: (id: string | null) => void;
  sandboxConversations: Record<string, string[]>;
  linkConversationToSandbox: (sandboxUuid: string, conversationId: string) => void;

  // Actions
  fetchSandboxes: (workspaceUuid?: string) => Promise<IProject[]>;
  ensureSandboxes: (workspaceUuid?: string) => Promise<IProject[]>;
  pickSandbox: (sandboxUuid?: string) => Promise<IProject | null>;
  createSandbox: (payload: {
    slug?: string;
    display_name?: string;
    description?: string;
    workspace_uuid?: string;
    vm_uuid?: string;
    filesystem_path: string;
    repo_full_name?: string;
    repo_url?: string;
    default_branch?: string;
    working_subdir?: string;
    setup_script?: string;
    maintenance_script?: string;
    usage_guide?: string;
    lazy?: boolean;
    source?: "new" | "existing" | "github" | "gitlab";
  }) => Promise<IProject | null>;
  updateSandbox: (
    sandboxUuid: string,
    payload: Partial<{
      display_name: string;
      description: string;
      repo_full_name: string;
      repo_url: string;
      default_branch: string;
      working_subdir: string;
      setup_script: string;
      maintenance_script: string;
      sandbox_gpu: string;
      sandbox_cpu: number;
      sandbox_memory: number;
      idle_timeout_seconds: number;
      conversation: string;
      remove_conversation: string;
      usage_guide: string;
      is_favorite: boolean;
    }>
  ) => Promise<IProject | null>;
  runEnvironmentSetup: (
    sandboxUuid: string,
    options?: { force?: boolean }
  ) => Promise<{ ready: boolean; log?: string; error?: string; environment?: IProject }>;
  clearEnvironmentDepsCache: (
    sandboxUuid: string
  ) => Promise<{ cleared: boolean; error?: string; environment?: IProject }>;
  deleteSandbox: (sandboxUuid: string) => Promise<boolean>;
  
  fetchFiles: (sandboxUuid: string, parentPath?: string) => Promise<void>;
  fetchFileContent: (sandboxUuid: string, fileUuid: string) => Promise<string | null>;
  fetchFileFullContent: (sandboxUuid: string, fileUuid: string) => Promise<{ content: string; isBinary: boolean } | null>;
  saveFileContent: (sandboxUuid: string, fileUuid: string, content: string, isBase64?: boolean) => Promise<boolean>;
  deleteFile: (sandboxUuid: string, filePath: string) => Promise<boolean>;
  uploadFile: (sandboxUuid: string, file: File, filename?: string, options?: FileMutationOptions) => Promise<IProjectFile | boolean | null>;
  renameFile: (sandboxUuid: string, filePath: string, newPath: string) => Promise<boolean>;
  createFileOrFolder: (sandboxUuid: string, path: string, isDirectory: boolean, options?: FileMutationOptions) => Promise<boolean>;
  cloneRepository: (sandboxUuid: string, repoUrl: string, onProgress?: (text: string) => void, destinationPath?: string, vmUuid?: string) => Promise<boolean>;
  fetchGithubRepos: (sandboxUuid: string) => Promise<{ connected: boolean; repos?: any[]; username?: string } | null>;
  disconnectGithub: (sandboxUuid: string) => Promise<boolean>;
  openFileInTab: (file: IProjectFile, content?: string | null) => void;
  setTabContentLoaded: (fileUuid: string, content: string) => void;
  updateTabContent: (fileUuid: string, content: string) => void;
  closeTab: (fileUuid: string) => void;
  setActiveTab: (fileUuid: string | null) => void;

  fetchGpuOptions: () => Promise<void>;
  startSandbox: (sandboxUuid: string) => Promise<IProject | null>;
  resetError: () => void;
}

const useSandboxProjectsStore = create<SandboxState>()(
  persist(
    (set, get) => ({
  sandboxes: [],
  sandboxesLoadedFor: null,
  currentSandbox: null,
  workspaceSandbox: null,
  files: [],
  expandedPaths: [],
  gpuOptions: [],
  idleTimeoutLimits: null,
  idleTimeoutDefault: 10,
  idleTimeoutMin: 5,

  sandboxConversations: {},

  openTabs: {},
  activeTabUuid: null,

  isLoading: false,
  isContentLoading: false,
  isUploading: false,
  errorMessage: null,

  isSidebarOpen: false,
  setSidebarOpen: (open) => set({ isSidebarOpen: open }),
  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
  sidebarWidth: 420,
  setSidebarWidth: (width) => set({ sidebarWidth: width }),
  isSidebarResizing: false,
  setSidebarResizing: (resizing) => set({ isSidebarResizing: resizing }),
  isCreateProjectDialogOpen: false,
  setCreateProjectDialogOpen: (open) => set({ isCreateProjectDialogOpen: open }),
  isTerminalOpen: false,
  toggleTerminal: () => set((state) => {
    const willOpen = !state.isTerminalOpen;
    if (willOpen && state.terminals.length === 0) {
      return {
        isTerminalOpen: true,
        terminals: [{ id: "1", name: "bash-1" }],
        activeTerminalId: "1",
      };
    }
    return { isTerminalOpen: willOpen };
  }),
  terminalHeight: 300,
  setTerminalHeight: (height) => set({ terminalHeight: height }),
  terminals: [],
  activeTerminalId: null,
  addTerminal: () => set((state) => {
    const maxId = state.terminals.reduce((max, t) => {
      const n = parseInt(t.id, 10);
      return Number.isNaN(n) ? max : Math.max(max, n);
    }, 0);
    const nextId = (maxId + 1).toString();
    const newTerminal = { id: nextId, name: `bash-${nextId}` };
    return {
      terminals: [...state.terminals, newTerminal],
      activeTerminalId: nextId,
      isTerminalOpen: true,
    };
  }),
  removeTerminal: (id) => set((state) => {
    const newTerminals = state.terminals.filter((t) => t.id !== id);
    if (newTerminals.length === 0) {
      return {
        terminals: [],
        activeTerminalId: null,
        isTerminalOpen: false,
      };
    }
    const newActiveId = state.activeTerminalId === id ? newTerminals[newTerminals.length - 1].id : state.activeTerminalId;
    return {
      terminals: newTerminals,
      activeTerminalId: newActiveId,
    };
  }),
  setActiveTerminal: (id) => set({ activeTerminalId: id }),

  resetError: () => set({ errorMessage: null }),

  ensureSandboxes: async (workspaceUuid) => {
    const uuid = await resolveWorkspaceUuid(workspaceUuid);
    if (!uuid) return [];
    if (get().sandboxesLoadedFor === sandboxListScope(uuid)) return get().sandboxes;
    return get().fetchSandboxes(uuid);
  },

  fetchSandboxes: async (workspaceUuid) => {
    const activeWorkspaceUuid = await resolveWorkspaceUuid(workspaceUuid);
    if (!activeWorkspaceUuid) return [];
    const scope = sandboxListScope(activeWorkspaceUuid);
    const pending = sandboxListRequests.get(scope);
    if (pending) return pending;
    const request = (async () => {
      set({ isLoading: true, errorMessage: null });
      try {
        let sandboxesList: IProject[] = [];
        let workspaceSandbox: IProject | null = null;
        let idleTimeoutLimits = null;
        let idleTimeoutDefault = 10;
        let idleTimeoutMin = 5;

        try {
          const { data } = await authedAxios.get(`${API_BASE}/sandbox/sandbox-tools/list/`, {
            params: { workspace_uuid: activeWorkspaceUuid },
          });
          if (Array.isArray(data)) {
            sandboxesList = data;
          } else if (data && Array.isArray(data.sandboxes)) {
            sandboxesList = data.sandboxes;
            workspaceSandbox = data.workspace_sandbox || null;
            idleTimeoutLimits = data.idle_timeout_limits || null;
            idleTimeoutDefault = data.idle_timeout_default || 10;
            idleTimeoutMin = data.idle_timeout_min || 5;
          }
        } catch (agentToolsErr) {
          console.warn("sandbox-tools/list request failed, falling back to /sandboxes/:", agentToolsErr);
          const { data } = await authedAxios.get(`${API_BASE}/sandbox/sandboxes/`, {
            params: { workspace_uuid: activeWorkspaceUuid },
          });
          sandboxesList = Array.isArray(data) ? data : (data?.results ?? []);
        }

        const conversationMap = Object.fromEntries(
          [...sandboxesList, ...(workspaceSandbox ? [workspaceSandbox] : [])].map((workspace) => {
            const ids = new Set(workspace.conversation_ids || []);
            if (workspace.conversation) ids.add(workspace.conversation);
            return [workspace.uuid, Array.from(ids)];
          })
        );

        const current = get().currentSandbox;
        const currentSandbox =
          sandboxesList.find((project) => project.uuid === current?.uuid) || null;

        if (scope !== sandboxListScope(activeWorkspaceUuid) || activeWorkspaceUuid !== useWorkspacesStore.getState().currentWorkspaceUuid) return [];
        set({
          sandboxes: sandboxesList,
          sandboxesLoadedFor: scope,
          ...(get().workspaceSandbox?.uuid !== workspaceSandbox?.uuid ? { files: [], expandedPaths: [] } : {}),
          workspaceSandbox,
          currentSandbox,
          sandboxConversations: conversationMap,
          idleTimeoutLimits,
          idleTimeoutDefault,
          idleTimeoutMin,
          isLoading: false,
        });
        return sandboxesList;
      } catch (err: any) {
        set({
          errorMessage: err?.response?.data?.error || err?.response?.data?.detail || i18n.t("workspace:stores.sandboxProjects.loadSandboxesFailed"),
          isLoading: false,
        });
        return [];
      }
    })().finally(() => { sandboxListRequests.delete(scope); });
    sandboxListRequests.set(scope, request);
    return request;
  },

  pickSandbox: async (sandboxUuid) => {
    const workspaceUuid = useWorkspacesStore.getState().currentWorkspace?.uuid || useWorkspacesStore.getState().currentWorkspaceUuid;
    set({ isLoading: true, errorMessage: null });
    try {
      const { data } = await authedAxios.post(`${API_BASE}/sandbox/sandbox-tools/list/`, {
        action: "pick",
        sandbox_uuid: sandboxUuid,
        workspace_uuid: workspaceUuid,
      });
      if (workspaceUuid !== (useWorkspacesStore.getState().currentWorkspace?.uuid || useWorkspacesStore.getState().currentWorkspaceUuid)) return null;
      set({ currentSandbox: data, expandedPaths: [], isLoading: false });
      if (data?.uuid) {
        const ids = new Set<string>(data.conversation_ids || []);
        if (data.conversation) ids.add(data.conversation);
        set((state) => ({
          sandboxConversations: {
            ...state.sandboxConversations,
            [data.uuid]: Array.from(ids),
          },
        }));
      }
      if (data?.uuid) {
        await get().fetchFiles(data.uuid);
      }
      return data;
    } catch (err: any) {
      set({
        errorMessage: err?.response?.data?.error || i18n.t("workspace:stores.sandboxProjects.pickSandboxFailed"),
        isLoading: false,
      });
      return null;
    }
  },

  startSandbox: async (sandboxUuid) => {
    set({ isLoading: true, errorMessage: null });
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const { data } = await authedAxios.post(
        `${API_BASE}/sandbox/sandboxes/${sandboxUuid}/start/`,
        { timezone }
      );
      set((state) => ({
        currentSandbox: state.currentSandbox?.uuid === sandboxUuid ? data : state.currentSandbox,
        workspaceSandbox: state.workspaceSandbox?.uuid === sandboxUuid ? data : state.workspaceSandbox,
        isLoading: false,
      }));
      return data;
    } catch (err: any) {
      set({
        errorMessage: err?.response?.data?.error || i18n.t("workspace:stores.sandboxProjects.startSandboxFailed"),
        isLoading: false,
      });
      return null;
    }
  },

  createSandbox: async (payload) => {
    set({ isLoading: true, errorMessage: null });
    try {
      const { data } = await authedAxios.post(`${API_BASE}/sandbox/sandbox-tools/list/`, {
        action: "create",
        ...payload,
        workspace_uuid: payload.workspace_uuid || useWorkspacesStore.getState().currentWorkspace?.uuid,
        vm_uuid: payload.vm_uuid,
      });
      set((state) => ({
        sandboxes: [data, ...state.sandboxes],
        currentSandbox: data,
        sandboxConversations: {
          ...state.sandboxConversations,
          [data.uuid]: data.conversation_ids || [],
        },
        isLoading: false,
      }));
      if (data?.uuid && !payload.lazy && !payload.repo_url && !payload.repo_full_name) {
        await get().fetchFiles(data.uuid);
      }
      return data;
    } catch (err: any) {
      set({
        errorMessage: err?.response?.data?.error || err?.response?.data?.detail || i18n.t("workspace:stores.sandboxProjects.createProjectFailed"),
        isLoading: false,
      });
      return null;
    }
  },

  linkConversationToSandbox: (sandboxUuid, conversationId) => {
    set((state) => {
      const existing = state.sandboxConversations[sandboxUuid] || [];
      const updated = existing.includes(conversationId)
        ? existing
        : [conversationId, ...existing];

      return {
        sandboxConversations: {
          ...state.sandboxConversations,
          [sandboxUuid]: updated,
        },
        sandboxes: state.sandboxes.map((sb) =>
          sb.uuid === sandboxUuid ? { ...sb, conversation: conversationId } : sb
        ),
        currentSandbox:
          state.currentSandbox?.uuid === sandboxUuid
            ? { ...state.currentSandbox, conversation: conversationId }
            : state.currentSandbox,
      };
    });
  },

  updateSandbox: async (sandboxUuid, payload) => {
    // If conversation is being linked, update local state immediately so UI updates without delay
    if (payload.conversation) {
      get().linkConversationToSandbox(sandboxUuid, payload.conversation);
    }
    set({ isLoading: true, errorMessage: null });
    try {
      const { data } = await authedAxios.patch(
        `${API_BASE}/sandbox/sandboxes/${sandboxUuid}/`,
        payload
      );
      set((state) => {
        let updatedConvMap = state.sandboxConversations;
        if (data.conversation) {
          const existing = updatedConvMap[sandboxUuid] || [];
          if (!existing.includes(data.conversation)) {
            updatedConvMap = {
              ...updatedConvMap,
              [sandboxUuid]: [data.conversation, ...existing],
            };
          }
        }
        return {
          sandboxes: state.sandboxes.map((sb) => (sb.uuid === sandboxUuid ? data : sb)),
          currentSandbox: state.currentSandbox?.uuid === sandboxUuid ? data : state.currentSandbox,
          workspaceSandbox: state.workspaceSandbox?.uuid === sandboxUuid ? data : state.workspaceSandbox,
          sandboxConversations: updatedConvMap,
          isLoading: false,
        };
      });
      return data;
    } catch (err: any) {
      set({
        errorMessage: err?.response?.data?.error || i18n.t("workspace:stores.sandboxProjects.updateSandboxFailed"),
        isLoading: false,
      });
      return null;
    }
  },

  runEnvironmentSetup: async (sandboxUuid, options) => {
    set((state) => ({
      sandboxes: state.sandboxes.map((sb) => (sb.uuid === sandboxUuid ? { ...sb, setup_status: "running" } : sb)),
      currentSandbox:
        state.currentSandbox?.uuid === sandboxUuid
          ? { ...state.currentSandbox, setup_status: "running" }
          : state.currentSandbox,
    }));
    try {
      const { data } = await authedAxios.post(`${API_BASE}/sandbox/sandboxes/${sandboxUuid}/run-setup/`, {
        force: options?.force ?? true,
      });
      const envObj: IProject | undefined = data?.environment;
      if (envObj) {
        set((state) => ({
          sandboxes: state.sandboxes.map((sb) => (sb.uuid === sandboxUuid ? envObj : sb)),
          currentSandbox: state.currentSandbox?.uuid === sandboxUuid ? envObj : state.currentSandbox,
        }));
      }
      return { ready: Boolean(data?.ready), log: data?.log, error: data?.error, environment: envObj };
    } catch (err: any) {
      const errData = err?.response?.data;
      const envObj: IProject | undefined = errData?.environment;
      if (envObj) {
        set((state) => ({
          sandboxes: state.sandboxes.map((sb) => (sb.uuid === sandboxUuid ? envObj : sb)),
          currentSandbox: state.currentSandbox?.uuid === sandboxUuid ? envObj : state.currentSandbox,
        }));
      }
      return {
        ready: false,
        log: errData?.log,
        error: errData?.error || err?.message || "Setup failed.",
        environment: envObj,
      };
    }
  },

  clearEnvironmentDepsCache: async (sandboxUuid) => {
    try {
      const { data } = await authedAxios.post(`${API_BASE}/sandbox/sandboxes/${sandboxUuid}/clear-deps-cache/`);
      const envObj: IProject | undefined = data?.environment;
      if (envObj) {
        set((state) => ({
          sandboxes: state.sandboxes.map((sb) => (sb.uuid === sandboxUuid ? envObj : sb)),
          currentSandbox: state.currentSandbox?.uuid === sandboxUuid ? envObj : state.currentSandbox,
        }));
      }
      return { cleared: true, environment: envObj };
    } catch (err: any) {
      return {
        cleared: false,
        error: err?.response?.data?.error || err?.message || "Failed to clear dependency cache.",
      };
    }
  },

  deleteSandbox: async (sandboxUuid) => {
    set({ isLoading: true, errorMessage: null });
    try {
      await authedAxios.delete(`${API_BASE}/sandbox/sandboxes/${sandboxUuid}/`);
      set((state) => ({
        sandboxes: state.sandboxes.filter((sb) => sb.uuid !== sandboxUuid),
        currentSandbox: state.currentSandbox?.uuid === sandboxUuid ? null : state.currentSandbox,
        sandboxConversations: Object.fromEntries(Object.entries(state.sandboxConversations).filter(([uuid]) => uuid !== sandboxUuid)),
        isLoading: false,
      }));
      return true;
    } catch (err: any) {
      set({
        errorMessage: err?.response?.data?.error || err?.response?.data?.detail || i18n.t("workspace:stores.sandboxProjects.removeProjectFailed"),
        isLoading: false,
      });
      return false;
    }
  },

  fetchFiles: async (sandboxUuid, parentPath) => {
    sandboxUuid = get().workspaceSandbox?.uuid || sandboxUuid;
    const treeVersion = fileTreeVersions.get(sandboxUuid) || 0;
    try {
      let url = `${API_BASE}/sandbox/sandboxes/${sandboxUuid}/files/`;
      if (parentPath) {
        url += `?parent=${encodeURIComponent(parentPath)}`;
      }
      const { data } = await authedAxios.get(url);
      const fetchedFiles: IProjectFile[] = Array.isArray(data) ? data : (data?.results ?? []);
      set((state) => {
        if ((fileTreeVersions.get(sandboxUuid) || 0) !== treeVersion || (state.workspaceSandbox?.uuid || state.currentSandbox?.uuid) !== sandboxUuid) return {};
        if (!parentPath) {
          return { files: fetchedFiles };
        }
        const existingMap = new Map(state.files.map((f) => [f.path, f]));
        fetchedFiles.forEach((f) => existingMap.set(f.path, f));
        return { files: Array.from(existingMap.values()) };
      });
    } catch (err: any) {
      set({ errorMessage: err?.response?.data?.error || i18n.t("workspace:stores.sandboxProjects.loadFilesFailed") });
    }
  },

  fetchFileContent: async (sandboxUuid, fileUuid) => {
    set({ isContentLoading: true, errorMessage: null });
    try {
      const encodedId = btoa(fileUuid);
      const { data } = await authedAxios.get(
        `${API_BASE}/sandbox/sandboxes/${sandboxUuid}/files/${encodedId}/content/`
      );
      set({ isContentLoading: false });
      return data.content || "";
    } catch (err: any) {
      set({
        errorMessage: err?.response?.data?.error || i18n.t("workspace:stores.sandboxProjects.loadFileContentFailed"),
        isContentLoading: false,
      });
      return null;
    }
  },

  fetchFileFullContent: async (sandboxUuid, fileUuid) => {
    set({ isContentLoading: true, errorMessage: null });
    try {
      const encodedId = btoa(String.fromCharCode(...new TextEncoder().encode(fileUuid)))
        .replace(/\+/g, "-").replace(/\//g, "_");
      const { data } = await authedAxios.get(
        `${API_BASE}/sandbox/sandboxes/${sandboxUuid}/files/${encodedId}/content/`
      );
      set({ isContentLoading: false });
      return {
        content: data.content || "",
        isBinary: Boolean(data.is_binary),
      };
    } catch (err: any) {
      set({
        errorMessage: err?.response?.data?.error || i18n.t("workspace:stores.sandboxProjects.loadFileContentFailed"),
        isContentLoading: false,
      });
      return null;
    }
  },

  saveFileContent: async (sandboxUuid, fileUuid, content, isBase64) => {
    set({ isLoading: true, errorMessage: null });
    try {
      const encodedId = btoa(fileUuid);
      await authedAxios.put(
        `${API_BASE}/sandbox/sandboxes/${sandboxUuid}/files/${encodedId}/content/`,
        { content, is_base64: Boolean(isBase64) }
      );
      set((state) => {
        const tab = state.openTabs[fileUuid];
        if (tab) {
          return {
            openTabs: {
              ...state.openTabs,
              [fileUuid]: {
                ...tab,
                initialContent: content,
                isDirty: false,
              },
            },
            isLoading: false,
          };
        }
        return { isLoading: false };
      });
      // Refresh the file size in the list
      await get().fetchFiles(sandboxUuid);
      return true;
    } catch (err: any) {
      set({
        errorMessage: err?.response?.data?.error || i18n.t("workspace:stores.sandboxProjects.saveFileContentFailed"),
        isLoading: false,
      });
      return false;
    }
  },

  deleteFile: async (sandboxUuid, filePath) => {
    invalidateFileTree(sandboxUuid);
    set({ isLoading: true, errorMessage: null });
    let reconciled = false;
    try {
      const encodedId = btoa(String.fromCharCode(...new TextEncoder().encode(filePath)))
        .replace(/\+/g, "-").replace(/\//g, "_");
      await authedAxios.delete(
        `${API_BASE}/sandbox/sandboxes/${sandboxUuid}/files/${encodedId}/`
      );
      // A successful HTTP response is insufficient: verify the entire subtree
      // against fresh workspace data before reporting success or closing editors.
      const { data } = await authedAxios.get(`${API_BASE}/sandbox/sandboxes/${sandboxUuid}/files/`);
      const refreshed: IProjectFile[] | null = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : null;
      if (!refreshed) throw new Error(i18n.t("workspace:stores.sandboxProjects.verifyDeleteFailed"));
      const { files: currentFiles, openTabs } = get();
      invalidateFileTree(sandboxUuid);
      set((state) => (state.workspaceSandbox?.uuid || state.currentSandbox?.uuid) === sandboxUuid
        ? { files: refreshed, isLoading: false } : { isLoading: false });
      reconciled = true;
      if (refreshed.some(file => file.path.replace(/\/+$/, "") === filePath || file.path.startsWith(`${filePath}/`))) {
        throw new Error(i18n.t("workspace:stores.sandboxProjects.fileStillExists"));
      }
      const matchedFile = currentFiles.find(file => file.path === filePath);
      if (matchedFile && openTabs[matchedFile.uuid]) get().closeTab(matchedFile.uuid);
      return true;
    } catch (err: any) {
      const message = err?.response?.data?.error || err?.response?.data?.detail || err?.message || i18n.t("workspace:stores.sandboxProjects.deleteFileFailed");
      // A storage error can follow a partial deletion. Show the actual current
      // tree while retaining the error, rather than keeping an obsolete row.
      if (!reconciled) {
        try {
          const { data } = await authedAxios.get(`${API_BASE}/sandbox/sandboxes/${sandboxUuid}/files/`);
          const fresh = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : null;
          if (fresh) {
            invalidateFileTree(sandboxUuid);
            set(state => (state.workspaceSandbox?.uuid || state.currentSandbox?.uuid) === sandboxUuid ? { files: fresh } : {});
          }
        } catch { /* Keep the last known tree if storage is unavailable. */ }
      }
      set({
        errorMessage: message,
        isLoading: false,
      });
      return false;
    }
  },

  uploadFile: async (sandboxUuid, file, filename, options) => {
    set({ isUploading: true, errorMessage: null });
    try {
      const formData = new FormData();
      formData.append("file", file);
      if (filename) {
        formData.append("filename", filename);
      }
      const { data } = await authedAxios.post(
        `${API_BASE}/sandbox/sandboxes/${sandboxUuid}/files/upload/`,
        formData,
        { onUploadProgress: event => {
          if (event.total) options?.onProgress?.(Math.min(1, event.loaded / event.total));
        } }
      );
      set({ isUploading: false });
      if (options?.refresh !== false) await get().fetchFiles(sandboxUuid);
      return data ?? true;
    } catch (err: any) {
      set({
        errorMessage: err?.response?.data?.error || err?.response?.data?.detail || i18n.t("workspace:stores.sandboxProjects.uploadFileFailed"),
        isUploading: false,
      });
      return null;
    }
  },

  renameFile: async (sandboxUuid, filePath, newPath) => {
    set({ isLoading: true, errorMessage: null });
    try {
      const encodedId = btoa(filePath);
      await authedAxios.patch(
        `${API_BASE}/sandbox/sandboxes/${sandboxUuid}/files/${encodedId}/`,
        { new_path: newPath }
      );
      set({ isLoading: false });
      // Refresh files list
      await get().fetchFiles(sandboxUuid);
      return true;
    } catch (err: any) {
      set({
        errorMessage: err?.response?.data?.error || i18n.t("workspace:stores.sandboxProjects.renameFileFailed"),
        isLoading: false,
      });
      return false;
    }
  },

  createFileOrFolder: async (sandboxUuid, path, isDirectory, options) => {
    set({ isLoading: true, errorMessage: null });
    try {
      await authedAxios.post(
        `${API_BASE}/sandbox/sandboxes/${sandboxUuid}/files/`,
        { path, is_directory: isDirectory }
      );
      set({ isLoading: false });
      if (options?.refresh !== false) await get().fetchFiles(sandboxUuid);
      return true;
    } catch (err: any) {
      set({
        errorMessage: err?.response?.data?.error || i18n.t("workspace:stores.sandboxProjects.createFileFailed"),
        isLoading: false,
      });
      return false;
    }
  },

  cloneRepository: async (sandboxUuid, repoUrl, onProgress, destinationPath, vmUuid) => {
    const workspaceUuid = useWorkspacesStore.getState().currentWorkspace?.uuid || useWorkspacesStore.getState().currentWorkspaceUuid || undefined;
    set({ isLoading: true, errorMessage: null });
    try {
      const token = useAuthStore.getState().token || localStorage.getItem("token") || "";
      const response = await fetch(`${API_BASE}/sandbox/sandboxes/${sandboxUuid}/git-clone/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          repo_url: repoUrl,
          ...(destinationPath ? { destination_path: destinationPath } : {}),
          ...(vmUuid ? { vm_uuid: vmUuid } : {}),
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const message = errData.error || errData.detail || i18n.t("workspace:stores.sandboxProjects.cloneFailed");
        if (response.status === 402) {
          useWorkspacesStore.getState().openInsufficientBalancePrompt?.(message);
        }
        throw new Error(message);
      }

      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let output = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          output += text;
          if (onProgress) {
            onProgress(text);
          }
        }
        const tail = decoder.decode();
        output += tail;
        if (tail) onProgress?.(tail);
        if (output.includes("[Error]")) {
          await get().fetchFiles(sandboxUuid);
          throw new Error(output.split("[Error]").pop()?.trim() || i18n.t("workspace:stores.sandboxProjects.cloneFailed"));
        }
        if (!output.includes("[Success]")) throw new Error(i18n.t("workspace:stores.sandboxProjects.cloneEndedError"));
      } else {
        throw new Error(i18n.t("workspace:stores.sandboxProjects.cloneStreamUnavailable"));
      }

      set({ isLoading: false });
      await get().fetchSandboxes(workspaceUuid);
      await get().fetchFiles(sandboxUuid);
      return true;
    } catch (err: any) {
      const errorMsg = err?.message || i18n.t("workspace:stores.sandboxProjects.cloneFailed");
      set({
        errorMessage: errorMsg,
        isLoading: false,
      });
      throw err;
    }
  },

  fetchGithubRepos: async (sandboxUuid) => {
    try {
      const { data } = await authedAxios.get(
        `${API_BASE}/sandbox/sandboxes/${sandboxUuid}/github/repos/`
      );
      return data;
    } catch (err: any) {
      set({ errorMessage: err?.response?.data?.error || i18n.t("workspace:stores.sandboxProjects.fetchReposFailed") });
      return null;
    }
  },

  disconnectGithub: async (sandboxUuid) => {
    try {
      await authedAxios.delete(
        `${API_BASE}/sandbox/sandboxes/${sandboxUuid}/github/repos/`
      );
      return true;
    } catch (err: any) {
      set({ errorMessage: err?.response?.data?.error || i18n.t("workspace:stores.sandboxProjects.disconnectGithubFailed") });
      return false;
    }
  },

  openFileInTab: (file, content = null) => {
    set((state) => {
      const tab = state.openTabs[file.uuid];
      if (tab) {
        return { activeTabUuid: file.uuid };
      }
      return {
        openTabs: {
          ...state.openTabs,
          [file.uuid]: {
            file,
            initialContent: content || "",
            currentContent: content || "",
            isDirty: false,
            isContentLoaded: content !== null && content !== undefined,
          },
        },
        activeTabUuid: file.uuid,
      };
    });
  },

  setTabContentLoaded: (fileUuid, content) => {
    set((state) => {
      const tab = state.openTabs[fileUuid];
      if (!tab) return {};
      return {
        openTabs: {
          ...state.openTabs,
          [fileUuid]: {
            ...tab,
            initialContent: content,
            currentContent: content,
            isContentLoaded: true,
          },
        },
      };
    });
  },

  updateTabContent: (fileUuid, content) => {
    set((state) => {
      const tab = state.openTabs[fileUuid];
      if (!tab) return {};
      const isDirty = tab.initialContent !== content;
      return {
        openTabs: {
          ...state.openTabs,
          [fileUuid]: {
            ...tab,
            currentContent: content,
            isDirty,
          },
        },
      };
    });
  },

  closeTab: (fileUuid) => {
    set((state) => {
      const newTabs = { ...state.openTabs };
      delete newTabs[fileUuid];

      let newActive = state.activeTabUuid;
      if (state.activeTabUuid === fileUuid) {
        const remainingUuids = Object.keys(newTabs);
        newActive = remainingUuids.length > 0 ? remainingUuids[remainingUuids.length - 1] : null;
      }

      return {
        openTabs: newTabs,
        activeTabUuid: newActive,
      };
    });
  },

  setActiveTab: (fileUuid) => {
    set({ activeTabUuid: fileUuid });
  },

  fetchGpuOptions: async () => {
    try {
      const { data } = await authedAxios.get(`${API_BASE}/sandbox/gpu-options/`);
      set({
        gpuOptions: data.gpus || [],
        idleTimeoutLimits: data.idle_timeout_limits || null,
        idleTimeoutDefault: data.idle_timeout_default || 10,
        idleTimeoutMin: data.idle_timeout_min || 5,
      });
    } catch (err: any) {
      set({ errorMessage: err?.response?.data?.error || i18n.t("workspace:stores.sandboxProjects.loadGpuOptionsFailed") });
    }
  },
  }),
  {
    name: "sandbox-projects-storage",
    version: 1,
    migrate: (persistedState, version) => {
      const state = persistedState as Partial<SandboxState>;
      return version < 1 ? { ...state, sidebarWidth: 420 } : state;
    },
    storage: createJSONStorage(() => typeof window !== "undefined" ? window.localStorage : {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    } as any),
    partialize: (state) => ({
      currentSandbox: state.currentSandbox,
      workspaceSandbox: state.workspaceSandbox,
      openTabs: state.openTabs,
      activeTabUuid: state.activeTabUuid,
      terminals: state.terminals,
      activeTerminalId: state.activeTerminalId,
      isSidebarOpen: state.isSidebarOpen,
      sidebarWidth: state.sidebarWidth,
      sandboxConversations: state.sandboxConversations,
    }),
  }
)
);

export default useSandboxProjectsStore;
