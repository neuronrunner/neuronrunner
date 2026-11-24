"use client";

import { env } from "@/lib/env";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { authedAxios } from "@/lib/axios";
import i18n from "@/i18n";
import useAuthStore from "./auth";

const API_BASE = env.API_URL || "";
const workspacesRequests = new Map<string | null, Promise<IWorkspace[]>>();
const requestScope = () => {
  const auth = useAuthStore.getState();
  return auth.user?.uuid || auth.token;
};

export type WorkspaceRole = "owner" | "admin" | "member";
export type WorkspaceSettingsTab = "workspace" | "team" | "provider-keys" | "secrets" | "logs";

export interface IWorkspaceMember {
  uuid: string;
  user_uuid: string;
  username: string;
  email: string;
  display_name: string;
  role: WorkspaceRole;
  joined_at: string;
}

export interface IWorkspaceInvitation {
  uuid: string;
  workspace_uuid: string;
  workspace_name: string;
  email: string;
  role: "admin" | "member";
  status: "pending" | "accepted" | "declined" | "expired";
  expires_at: string;
  invited_by_name: string;
  created_at: string;
}

export interface IWorkspace {
  uuid: string;
  name: string;
  slug: string;
  profile_picture?: string | null;
  profile_picture_blur_data_url?: string | null;
  balance: string;
  owner_uuid: string;
  user_role: WorkspaceRole;
  member_count: number;
  members: IWorkspaceMember[];
  pending_invitations: IWorkspaceInvitation[];
  created_at: string;
  updated_at: string;
}

interface WorkspacesState {
  workspaces: IWorkspace[];
  currentWorkspace: IWorkspace | null;
  currentWorkspaceUuid: string | null;
  isLoading: boolean;
  hasLoaded: boolean;
  errorMessage: string | null;
  isCreateDialogOpen: boolean;
  isMembersDialogOpen: boolean;
  isSandboxSettingsDialogOpen: boolean;
  isWorkspaceSettingsDialogOpen: boolean;
  workspaceSettingsTab: WorkspaceSettingsTab;
  insufficientBalancePrompt: { open: boolean; message: string | null };

  fetchWorkspaces: () => Promise<IWorkspace[]>;
  selectWorkspace: (workspaceUuid: string) => IWorkspace | null;
  createWorkspace: (name: string, profilePicture?: File | null) => Promise<IWorkspace | null>;
  updateWorkspace: (
    workspaceUuid: string,
    payload: { name?: string; profile_picture?: File | string | null }
  ) => Promise<IWorkspace | null>;
  inviteMember: (email: string, role?: "admin" | "member") => Promise<IWorkspaceInvitation | null>;
  cancelInvitation: (invitationUuid: string) => Promise<boolean>;
  removeMember: (userUuid: string) => Promise<boolean>;
  setCreateDialogOpen: (open: boolean) => void;
  setMembersDialogOpen: (open: boolean) => void;
  setSandboxSettingsDialogOpen: (open: boolean) => void;
  setWorkspaceSettingsDialogOpen: (open: boolean, tab?: WorkspaceSettingsTab) => void;
  setWorkspaceSettingsTab: (tab: WorkspaceSettingsTab) => void;
  openInsufficientBalancePrompt: (message?: string | null) => void;
  closeInsufficientBalancePrompt: () => void;
  resetError: () => void;
  resetWorkspaces: () => void;
}

const useWorkspacesStore = create<WorkspacesState>()(
  persist(
    (set, get) => ({
      workspaces: [],
      currentWorkspace: null,
      currentWorkspaceUuid: null,
      isLoading: false,
      hasLoaded: false,
      errorMessage: null,
      isCreateDialogOpen: false,
      isMembersDialogOpen: false,
      isSandboxSettingsDialogOpen: false,
      isWorkspaceSettingsDialogOpen: false,
      workspaceSettingsTab: "workspace",
      insufficientBalancePrompt: { open: false, message: null },

      fetchWorkspaces: () => {
        const scope = requestScope();
        const pending = workspacesRequests.get(scope);
        if (pending) return pending;
        const request = (async () => {
          set({ isLoading: true, errorMessage: null });
          try {
            const { data } = await authedAxios.get(`${API_BASE}/sandbox/workspaces/`);
            if (scope !== requestScope()) return [];
            const workspaces: IWorkspace[] = Array.isArray(data) ? data : data?.results ?? [];
            const requestedUuid = get().currentWorkspaceUuid;
            const currentWorkspace =
              workspaces.find((workspace) => workspace.uuid === requestedUuid) || workspaces[0] || null;
            set({
              workspaces,
              currentWorkspace,
              currentWorkspaceUuid: currentWorkspace?.uuid || null,
              isLoading: false,
              hasLoaded: true,
            });
            return workspaces;
          } catch (error: any) {
            if (scope !== requestScope()) return [];
            set({
              errorMessage: error?.response?.data?.error || i18n.t("workspace:stores.workspaces.loadFailed"),
              isLoading: false,
              hasLoaded: true,
            });
            return [];
          }
        })().finally(() => { workspacesRequests.delete(scope); });
        workspacesRequests.set(scope, request);
        return request;
      },

      selectWorkspace: (workspaceUuid) => {
        const workspace = get().workspaces.find((item) => item.uuid === workspaceUuid) || null;
        if (workspace) {
          set({ currentWorkspace: workspace, currentWorkspaceUuid: workspace.uuid });
        }
        return workspace;
      },

      createWorkspace: async (name, profilePicture) => {
        set({ errorMessage: null });
        try {
          let responseData: any;
          if (profilePicture instanceof File) {
            const formData = new FormData();
            formData.append("name", name);
            formData.append("profile_picture", profilePicture);
            const { data } = await authedAxios.post(`${API_BASE}/sandbox/workspaces/`, formData, {
              headers: { "Content-Type": "multipart/form-data" },
            });
            responseData = data;
          } else {
            const { data } = await authedAxios.post(`${API_BASE}/sandbox/workspaces/`, { name });
            responseData = data;
          }
          const workspace = responseData as IWorkspace;
          set((state) => ({
            workspaces: [workspace, ...state.workspaces],
            currentWorkspace: workspace,
            currentWorkspaceUuid: workspace.uuid,
          }));
          return workspace;
        } catch (error: any) {
          set({ errorMessage: error?.response?.data?.error || i18n.t("workspace:stores.workspaces.createFailed") });
          return null;
        }
      },

      updateWorkspace: async (workspaceUuid, payload) => {
        set({ errorMessage: null });
        try {
          let resData: any;
          const hasFile = payload.profile_picture instanceof File;
          const hasStringPic = typeof payload.profile_picture === "string" || payload.profile_picture === null;
          if (hasFile || hasStringPic) {
            const formData = new FormData();
            if (payload.name !== undefined) formData.append("name", payload.name);
            if (hasFile) {
              formData.append("profile_picture", payload.profile_picture as Blob);
            } else if (hasStringPic) {
              formData.append("profile_picture", payload.profile_picture ?? "");
            }
            const { data } = await authedAxios.patch(
              `${API_BASE}/sandbox/workspaces/${workspaceUuid}/`,
              formData,
              { headers: { "Content-Type": "multipart/form-data" } }
            );
            resData = data;
          } else {
            const { data } = await authedAxios.patch(
              `${API_BASE}/sandbox/workspaces/${workspaceUuid}/`,
              { ...(payload.name !== undefined ? { name: payload.name } : {}) }
            );
            resData = data;
          }
          const updatedWorkspace = resData as IWorkspace;
          set((state) => ({
            workspaces: state.workspaces.map((w) => (w.uuid === workspaceUuid ? updatedWorkspace : w)),
            currentWorkspace: state.currentWorkspace?.uuid === workspaceUuid ? updatedWorkspace : state.currentWorkspace,
          }));
          return updatedWorkspace;
        } catch (error: any) {
          const msg = error?.response?.data?.error || i18n.t("workspace:stores.workspaces.updateFailed");
          set({ errorMessage: msg });
          throw error;
        }
      },

      inviteMember: async (email, role = "member") => {
        const workspace = get().currentWorkspace;
        if (!workspace) return null;
        set({ errorMessage: null });
        try {
          const { data } = await authedAxios.post(
            `${API_BASE}/sandbox/workspaces/${workspace.uuid}/members/`,
            { email, role }
          );
          await get().fetchWorkspaces();
          return data as IWorkspaceInvitation;
        } catch (error: any) {
          set({ errorMessage: error?.response?.data?.error || i18n.t("workspace:stores.workspaces.inviteFailed") });
          return null;
        }
      },

      cancelInvitation: async (invitationUuid) => {
        const workspace = get().currentWorkspace;
        if (!workspace) return false;
        set({ errorMessage: null });
        try {
          await authedAxios.delete(
            `${API_BASE}/sandbox/workspaces/${workspace.uuid}/invitations/${invitationUuid}/`
          );
          await get().fetchWorkspaces();
          return true;
        } catch (error: any) {
          set({ errorMessage: error?.response?.data?.error || i18n.t("workspace:stores.workspaces.cancelInviteFailed") });
          return false;
        }
      },

      removeMember: async (userUuid) => {
        const workspace = get().currentWorkspace;
        if (!workspace) return false;
        set({ errorMessage: null });
        try {
          await authedAxios.delete(
            `${API_BASE}/sandbox/workspaces/${workspace.uuid}/members/${userUuid}/`
          );
          await get().fetchWorkspaces();
          return true;
        } catch (error: any) {
          set({ errorMessage: error?.response?.data?.error || i18n.t("workspace:stores.workspaces.removeMemberFailed") });
          return false;
        }
      },

      setCreateDialogOpen: (open) => set({ isCreateDialogOpen: open }),
      setMembersDialogOpen: (open) =>
        set(
          open
            ? {
                isWorkspaceSettingsDialogOpen: true,
                workspaceSettingsTab: "team",
                isMembersDialogOpen: false,
              }
            : { isMembersDialogOpen: false }
        ),
      setSandboxSettingsDialogOpen: (open) => set({ isSandboxSettingsDialogOpen: open }),
      setWorkspaceSettingsDialogOpen: (open, tab = "workspace") => set({ isWorkspaceSettingsDialogOpen: open, ...(open ? { workspaceSettingsTab: tab } : {}) }),
      setWorkspaceSettingsTab: (tab) => set({ workspaceSettingsTab: tab }),
      openInsufficientBalancePrompt: (message = null) =>
        set({ insufficientBalancePrompt: { open: true, message: message ?? null } }),
      closeInsufficientBalancePrompt: () =>
        set({ insufficientBalancePrompt: { open: false, message: null } }),
      resetError: () => set({ errorMessage: null }),
      resetWorkspaces: () => {
        workspacesRequests.clear();
        set({
          workspaces: [],
          currentWorkspace: null,
          currentWorkspaceUuid: null,
          isLoading: false,
          hasLoaded: false,
          errorMessage: null,
          insufficientBalancePrompt: { open: false, message: null },
        });
        if (typeof window !== "undefined") {
          try {
            localStorage.removeItem("team-workspaces-storage");
          } catch {}
        }
      },
    }),
    {
      name: "team-workspaces-storage",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ currentWorkspaceUuid: state.currentWorkspaceUuid }),
    }
  )
);

export default useWorkspacesStore;

if (typeof (useAuthStore as any)?.subscribe === "function") {
  let lastUserScope = requestScope();
  (useAuthStore as any).subscribe((state: any) => {
    const currentScope = state?.user?.uuid || state?.token || null;
    if (currentScope !== lastUserScope) {
      lastUserScope = currentScope;
      useWorkspacesStore.getState().resetWorkspaces();
      if (currentScope) {
        void useWorkspacesStore.getState().fetchWorkspaces();
      }
    }
  });

  if (typeof window !== "undefined" && lastUserScope) {
    void useWorkspacesStore.getState().fetchWorkspaces();
  }
}
