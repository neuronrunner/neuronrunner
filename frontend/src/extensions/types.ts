import type React from "react";
import type { IconType } from "react-icons";

export interface ExtensionRouteSpec {
  path: string;
  element: React.ReactNode;
}

export interface ExtensionSettingsTabSpec {
  id: string;
  labelKey: string;
  sectionKey: "workspace" | "account";
  icon: IconType;
  Component: React.ComponentType;
}

export interface ExtensionToolbarActionSpec {
  id: string;
  labelKey: string;
  icon: IconType;
  iconColor: string;
  onClick: () => void;
}

export interface ExtensionRuntimeBridge {
  getSelectedRuntimeUuid: () => string | null;
  getRequestHeaders: (workspaceUuid: string) => Record<string, string>;
  fetchRuntimes: (workspaceUuid?: string) => Promise<void>;
  resolveProjectRuntimeLabel: (project: { vm_uuid?: string | null }) => string | null;
  onToolEvent: (toolName: string) => void;
  useRuntimeList: () => { items: Array<{ uuid: string; name?: string; status?: string }>; selectedUuid: string | null };
}

export interface ExtensionQuotaBridge {
  notifyQuotaIfNeeded: (err: unknown, message?: string | null) => void;
  handleApiError: (status: number | undefined, error: unknown, originalRequest?: Record<string, unknown>) => void;
}

export interface NeuronRunnerFrontendExtension {
  edition: "oss" | "cloud";
  routes: ExtensionRouteSpec[];
  NavigationEffects: React.ComponentType;
  settingsTabs: ExtensionSettingsTabSpec[];
  WorkspaceToolbarLeading: React.ComponentType;
  getWorkspaceToolbarActions: (helpers: { openDesktopTab?: () => void }) => ExtensionToolbarActionSpec[];
  DesktopTabPanel: React.ComponentType<{ sandboxUuid?: string | null }>;
  SidebarPlanBadge: React.ComponentType<{ workspace: unknown; isLoading?: boolean }>;
  runtimeBridge: ExtensionRuntimeBridge;
  quotaBridge: ExtensionQuotaBridge;
}
