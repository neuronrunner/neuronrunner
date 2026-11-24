import { create } from "zustand";
import { authedAxios, API_BASE } from "@/lib/axios";

/** What the hello (onboarding) page needs to know about the current workspace. */
export interface LlmSetupStatus {
  can_manage: boolean;
  configured_providers: string[];
  usable_model_count: number;
  usable_models: { name: string; display_name: string }[];
  /** Model for titles, summaries and memory; null means "same as the chat model". */
  auxiliary_model: { name: string; display_name: string; usable: boolean } | null;
}

interface LlmSetupState {
  workspaceUuid: string | null;
  status: LlmSetupStatus | null;
  loading: boolean;
  fetchStatus: (workspaceUuid: string, options?: { force?: boolean }) => Promise<LlmSetupStatus | null>;
  setAuxiliaryModel: (workspaceUuid: string, modelName: string | null) => Promise<LlmSetupStatus>;
  reset: () => void;
}

const pending = new Map<string, Promise<LlmSetupStatus | null>>();

/** True when the workspace has no model its own keys can run and must go through /hello. */
export function needsLlmSetup(status: LlmSetupStatus | null): boolean {
  return Boolean(status && status.usable_model_count === 0);
}

const useLlmSetupStore = create<LlmSetupState>()((set, get) => ({
  workspaceUuid: null,
  status: null,
  loading: false,

  fetchStatus: (workspaceUuid, options) => {
    const current = get();
    if (!options?.force && current.workspaceUuid === workspaceUuid && current.status) {
      return Promise.resolve(current.status);
    }
    const existing = pending.get(workspaceUuid);
    if (existing && !options?.force) return existing;

    set({ loading: true });
    const request = authedAxios
      .get<LlmSetupStatus>(`${API_BASE}/sandbox/workspaces/${workspaceUuid}/llm-setup/`)
      .then(({ data }) => {
        set({ workspaceUuid, status: data, loading: false });
        return data;
      })
      .catch(() => {
        // Never block the app on this check; the chat request itself is still guarded.
        set({ workspaceUuid, status: null, loading: false });
        return null;
      })
      .finally(() => pending.delete(workspaceUuid));
    pending.set(workspaceUuid, request);
    return request;
  },

  setAuxiliaryModel: async (workspaceUuid, modelName) => {
    const { data } = await authedAxios.put<LlmSetupStatus>(
      `${API_BASE}/sandbox/workspaces/${workspaceUuid}/llm-setup/`,
      { auxiliary_model: modelName }
    );
    set({ workspaceUuid, status: data });
    return data;
  },

  reset: () => set({ workspaceUuid: null, status: null, loading: false }),
}));

export default useLlmSetupStore;
