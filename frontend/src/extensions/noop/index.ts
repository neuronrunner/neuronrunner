import React from "react";
import { create } from "zustand";
import type { NeuronRunnerFrontendExtension } from "../types";

/**
 * Self-hosted (OSS) named runtimes: several local Docker sandboxes per workspace.
 *
 * Every workspace has a `default` runtime. Users can launch more named runtimes,
 * pick one, and stop or delete them. The selected runtime travels with requests
 * as the `X-Sandbox-Runtime` header, with chat requests as `vm_uuid`, and with
 * terminal sockets as the `vm_uuid` query parameter. The cloud edition replaces
 * this whole extension, so none of this runs there.
 */

export const DEFAULT_RUNTIME = "default";
export const RUNTIME_HEADER = "X-Sandbox-Runtime";
const SELECTION_KEY = "nr_selected_runtime";

export type LocalRuntimeStatus = "running" | "starting" | "stopped" | "not_created";

export interface LocalRuntime {
  uuid: string;
  name: string;
  container: string;
  status: LocalRuntimeStatus;
  created_at: string | null;
  is_default: boolean;
  last_active?: number | null;
}

interface RuntimeListPayload {
  items: LocalRuntime[];
  max_concurrent: number | null;
  running: number;
}

interface LocalRuntimesState {
  workspaceUuid: string | null;
  items: LocalRuntime[];
  maxConcurrent: number | null;
  running: number;
  /** Selected runtime name per workspace; missing means the default runtime. */
  selected: Record<string, string>;
  supported: boolean;
  loading: boolean;
  pending: string | null;
  error: string | null;
  fetch: (workspaceUuid?: string | null) => Promise<void>;
  select: (workspaceUuid: string, name: string) => void;
  launch: (workspaceUuid: string, name: string) => Promise<boolean>;
  stop: (workspaceUuid: string, name: string, options?: { remove?: boolean }) => Promise<boolean>;
}

const RUNTIME_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function normalizeRuntimeName(value: string): string | null {
  const name = value.trim().toLowerCase();
  if (!name || name.length > 24 || !RUNTIME_NAME.test(name)) return null;
  return name;
}

const readSelection = (): Record<string, string> => {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(SELECTION_KEY) : null;
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const writeSelection = (selected: Record<string, string>) => {
  try {
    window.localStorage.setItem(SELECTION_KEY, JSON.stringify(selected));
  } catch {
    // Storage can be unavailable (private mode); selection then lasts for this tab only.
  }
};

const errorMessage = (error: unknown, fallback: string): string => {
  const data = (error as { response?: { data?: { error?: string; message?: string } } })?.response?.data;
  return data?.error || data?.message || (error instanceof Error ? error.message : fallback);
};

const statusOf = (error: unknown): number | undefined =>
  (error as { response?: { status?: number } })?.response?.status;

// Imported lazily: lib/axios imports this extension, so a static import would be circular.
const api = async () => {
  const { authedAxios, API_BASE } = await import("@/lib/axios");
  return { http: authedAxios, base: `${API_BASE}/sandbox/workspaces` };
};

export const useLocalRuntimesStore = create<LocalRuntimesState>((set, get) => {
  const apply = (workspaceUuid: string, payload: RuntimeListPayload) => {
    const selected = { ...get().selected };
    const current = selected[workspaceUuid];
    // Forget a selection whose container was deleted elsewhere.
    if (current && !payload.items.some((item) => item.name === current)) {
      delete selected[workspaceUuid];
      writeSelection(selected);
    }
    set({
      workspaceUuid,
      items: payload.items,
      maxConcurrent: payload.max_concurrent ?? null,
      running: payload.running ?? 0,
      selected,
      supported: true,
      error: null,
    });
  };

  return {
    workspaceUuid: null,
    items: [],
    maxConcurrent: null,
    running: 0,
    selected: readSelection(),
    supported: true,
    loading: false,
    pending: null,
    error: null,

    fetch: async (workspaceUuid) => {
      if (!workspaceUuid) return;
      set({ loading: true });
      try {
        const { http, base } = await api();
        const { data } = await http.get<RuntimeListPayload>(`${base}/${workspaceUuid}/runtimes/`);
        apply(workspaceUuid, data);
      } catch (error) {
        if (statusOf(error) === 404) {
          set({ supported: false, items: [], workspaceUuid });
        } else {
          set({ error: errorMessage(error, "Could not load runtimes.") });
        }
      } finally {
        set({ loading: false });
      }
    },

    select: (workspaceUuid, name) => {
      const selected = { ...get().selected };
      if (!name || name === DEFAULT_RUNTIME) delete selected[workspaceUuid];
      else selected[workspaceUuid] = name;
      writeSelection(selected);
      set({ selected });
    },

    launch: async (workspaceUuid, rawName) => {
      const name = normalizeRuntimeName(rawName) ?? (rawName.trim() ? null : DEFAULT_RUNTIME);
      if (!name) {
        set({ error: "Use lowercase letters, digits and dashes (max 24 characters)." });
        return false;
      }
      set({ pending: name, error: null });
      try {
        const { http, base } = await api();
        const { data } = await http.post<RuntimeListPayload>(`${base}/${workspaceUuid}/runtimes/`, { name });
        apply(workspaceUuid, data);
        get().select(workspaceUuid, name);
        return true;
      } catch (error) {
        set({ error: errorMessage(error, "Could not start the runtime.") });
        return false;
      } finally {
        set({ pending: null });
      }
    },

    stop: async (workspaceUuid, name, options) => {
      set({ pending: name, error: null });
      try {
        const { http, base } = await api();
        const url = `${base}/${workspaceUuid}/runtimes/${encodeURIComponent(name)}/`;
        const { data } = options?.remove
          ? await http.delete<RuntimeListPayload>(url)
          : await http.post<RuntimeListPayload>(`${url}stop/`);
        apply(workspaceUuid, data);
        if (options?.remove && get().selected[workspaceUuid] === name) get().select(workspaceUuid, DEFAULT_RUNTIME);
        return true;
      } catch (error) {
        set({ error: errorMessage(error, "Could not stop the runtime.") });
        return false;
      } finally {
        set({ pending: null });
      }
    },
  };
});

/** The selected named runtime for a workspace, or null for the default runtime. */
export function selectedRuntimeFor(workspaceUuid: string | null | undefined): string | null {
  if (!workspaceUuid) return null;
  const name = useLocalRuntimesStore.getState().selected[workspaceUuid];
  return name && name !== DEFAULT_RUNTIME ? name : null;
}

const NullComponent = () => null;

// Loaded on first render so this module stays free of UI imports.
const LazyRuntimePicker = React.lazy(() => import("./RuntimePicker"));
const RuntimeToolbarSlot = () =>
  React.createElement(React.Suspense, { fallback: null }, React.createElement(LazyRuntimePicker));

const useRuntimeList = () => {
  const items = useLocalRuntimesStore((state) => state.items);
  const workspaceUuid = useLocalRuntimesStore((state) => state.workspaceUuid);
  const selected = useLocalRuntimesStore((state) => (workspaceUuid ? state.selected[workspaceUuid] : undefined));
  return { items, selectedUuid: selected && selected !== DEFAULT_RUNTIME ? selected : null };
};

export const frontendExtension: NeuronRunnerFrontendExtension = {
  edition: "oss",
  routes: [],
  NavigationEffects: NullComponent,
  settingsTabs: [],
  WorkspaceToolbarLeading: RuntimeToolbarSlot,
  getWorkspaceToolbarActions: () => [],
  DesktopTabPanel: NullComponent,
  SidebarPlanBadge: NullComponent,
  runtimeBridge: {
    getSelectedRuntimeUuid: () => selectedRuntimeFor(useLocalRuntimesStore.getState().workspaceUuid),
    getRequestHeaders: (workspaceUuid): Record<string, string> => {
      const name = selectedRuntimeFor(workspaceUuid);
      return name ? { [RUNTIME_HEADER]: name } : {};
    },
    fetchRuntimes: (workspaceUuid) => useLocalRuntimesStore.getState().fetch(workspaceUuid),
    resolveProjectRuntimeLabel: () => null,
    onToolEvent: () => {},
    useRuntimeList,
  },
  quotaBridge: {
    notifyQuotaIfNeeded: () => {},
    handleApiError: () => {},
  },
};

export default frontendExtension;
