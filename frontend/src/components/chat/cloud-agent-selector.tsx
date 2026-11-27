"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuCheck,
  LuChevronDown,
  LuKeyRound,
  LuLoader,
  LuRefreshCw,
} from "react-icons/lu";
import { AntigravityBrandLogo, ClaudeBrandLogo, OpenAICodexBrandLogo } from "@/components/brand-logos";
import VmConnectTerminalDialog, { type ByosProvider } from "@/components/chat/vm-connect-terminal-dialog";
import NeuronLogo from "@/components/neuron-logo";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toaster } from "@/components/ui/toaster";
import { authedAxios } from "@/lib/axios";
import { env } from "@/lib/env";
import { DEFAULT_PLATFORM_MODELS } from "@/lib/default-models";
import useChatStore from "@/stores/chat";
import useModelStore from "@/stores/search-models";
import useWorkspacesStore from "@/stores/workspaces";

const API_BASE = env.API_URL || "";

export type AgentId = "neuron" | ByosProvider;
export type { ByosProvider };

interface ProviderKeySummary {
  uuid: string;
  provider: string;
  auth_type?: "api_key" | "subscription";
  masked_key?: string;
}

interface AgentDefinition {
  id: AgentId;
  labelKey: string;
  fallbackLabel: string;
  descKey: string;
  fallbackDesc: string;
  badgeText?: string;
  accentClasses: string;
  preferredModelSuffix?: string;
}

const AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    id: "neuron",
    labelKey: "home.agentSelector.agents.neuron.name",
    fallbackLabel: "Neuron Agent",
    descKey: "home.agentSelector.agents.neuron.desc",
    fallbackDesc: "Built-in cloud agent with Neuron Runner models",
    accentClasses:
      "border-foreground/15 bg-gradient-to-br from-foreground/[0.09] to-foreground/[0.03] text-foreground shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)]",
  },
  {
    id: "anthropic_sub",
    labelKey: "home.agentSelector.agents.claude.name",
    fallbackLabel: "Claude Code",
    descKey: "home.agentSelector.agents.claude.desc",
    fallbackDesc: "Claude Pro / Max subscription",
    accentClasses:
      "border-[#D97757]/30 bg-gradient-to-br from-[#D97757]/[0.16] to-[#D97757]/[0.05] text-[#D97757] shadow-[inset_0_1px_0_0_rgba(217,119,87,0.18)]",
    preferredModelSuffix: "byos-claude-sonnet",
  },
  {
    id: "openai_sub",
    labelKey: "home.agentSelector.agents.codex.name",
    fallbackLabel: "OpenAI Codex",
    descKey: "home.agentSelector.agents.codex.desc",
    fallbackDesc: "ChatGPT Plus / Pro subscription",
    accentClasses:
      "border-foreground/15 bg-gradient-to-br from-foreground/[0.09] to-foreground/[0.03] text-foreground shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)]",
    preferredModelSuffix: "gpt-5.4-codex",
  },
  {
    id: "antigravity_sub",
    labelKey: "home.agentSelector.agents.antigravity.name",
    fallbackLabel: "Antigravity",
    descKey: "home.agentSelector.agents.antigravity.desc",
    fallbackDesc: "Google Antigravity / Gemini OAuth",
    accentClasses:
      "border-blue-500/25 bg-gradient-to-br from-blue-500/[0.14] via-indigo-500/[0.08] to-amber-500/[0.08] shadow-[inset_0_1px_0_0_rgba(96,165,250,0.18)]",
    preferredModelSuffix: "antigravity-gemini-4-argon-medium",
  },
];

function extractErrorMessage(err: unknown, fallback: string): string {
  const detail = (err as { response?: { data?: { detail?: string; error?: string } } })?.response?.data;
  if (detail?.error) return detail.error;
  if (detail?.detail) return detail.detail;
  return err instanceof Error ? err.message : fallback;
}

function AgentBrandLogo({ id, size = 20 }: { id: AgentId; size?: number }) {
  if (id === "neuron") {
    return <NeuronLogo size={size} variant="symbol" className="text-foreground" />;
  }
  if (id === "anthropic_sub") {
    return <ClaudeBrandLogo className={size <= 16 ? "h-3.5 w-3.5" : "h-[19px] w-[19px]"} />;
  }
  if (id === "openai_sub") {
    return <OpenAICodexBrandLogo className={size <= 16 ? "h-3.5 w-3.5" : "h-[19px] w-[19px]"} />;
  }
  return <AntigravityBrandLogo className={size <= 16 ? "h-3.5 w-3.5" : "h-[19px] w-[19px]"} />;
}

interface CloudAgentSelectorProps {
  vmAttached?: boolean;
}

export default function CloudAgentSelector({ vmAttached = false }: CloudAgentSelectorProps) {
  const { t } = useTranslation("landing");
  const selectedModel = useChatStore((s) => s.selectedModel);
  const setSelectedModel = useChatStore((s) => s.setSelectedModel);
  const fetchModelDetails = useChatStore((s) => s.fetchModelDetails);
  const models = useModelStore((s) => s.models);
  const currentWorkspace = useWorkspacesStore((s) => s.currentWorkspace);
  const workspaceUuid = currentWorkspace?.uuid;
  const canManageKeys = currentWorkspace?.user_role === "owner" || currentWorkspace?.user_role === "admin";

  const [open, setOpen] = useState(false);
  const [providerKeys, setProviderKeys] = useState<ProviderKeySummary[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [refreshingAgent, setRefreshingAgent] = useState<ByosProvider | null>(null);
  const [vmDialogProvider, setVmDialogProvider] = useState<ByosProvider | null>(null);

  const lastNeuronModelRef = useRef<string>(DEFAULT_PLATFORM_MODELS[0]?.name || "deepseek-v4.1-flash-1017");

  const activeModelObj = useMemo(
    () => models.find((m) => m.name === selectedModel),
    [models, selectedModel]
  );

  const activeAgentId: AgentId = useMemo(() => {
    const providerName = activeModelObj?.provider_name;
    if (providerName === "anthropic_sub" || selectedModel.includes("-byos-claude-")) {
      return "anthropic_sub";
    }
    if (providerName === "openai_sub" || selectedModel.includes("-byos-gpt-") || selectedModel.includes("-byos-codex-")) {
      return "openai_sub";
    }
    if (providerName === "antigravity_sub" || selectedModel.includes("-byos-antigravity-")) {
      return "antigravity_sub";
    }
    return "neuron";
  }, [activeModelObj?.provider_name, selectedModel]);

  useEffect(() => {
    if (activeAgentId === "neuron" && selectedModel) {
      lastNeuronModelRef.current = selectedModel;
    }
  }, [activeAgentId, selectedModel]);

  const fetchProviderKeys = useCallback(async () => {
    if (!workspaceUuid) return;
    setLoadingKeys(true);
    try {
      const res = await authedAxios.get<{ keys?: ProviderKeySummary[] }>(
        `${API_BASE}/sandbox/workspaces/${workspaceUuid}/provider-keys/`
      );
      setProviderKeys(res.data?.keys || []);
    } catch {
      // Non-admins or offline workspaces may not return keys.
    } finally {
      setLoadingKeys(false);
    }
  }, [workspaceUuid]);

  useEffect(() => {
    if (open && workspaceUuid) {
      void fetchProviderKeys();
    }
  }, [open, workspaceUuid, fetchProviderKeys]);

  const isAgentConnected = useCallback(
    (id: AgentId): boolean => {
      if (id === "neuron") return true;
      if (providerKeys.some((k) => k.provider === id)) return true;
      return models.some((m) => m.provider_name === id);
    },
    [providerKeys, models]
  );

  const agentModelCount = useCallback(
    (id: AgentId): number => {
      if (id === "neuron") {
        return models.filter(
          (m) => !m.is_byos && !["anthropic_sub", "openai_sub", "antigravity_sub"].includes(m.provider_name || "")
        ).length;
      }
      const uniqueBaseNames = new Set(
        models
          .filter((m) => m.provider_name === id)
          .map((m) =>
            (m.display_name || m.name)
              .replace(/\s*\(BYOS\)\s*$/i, "")
              .replace(/\s+\((minimal|low|medium|high|xhigh|max)\)$/i, "")
              .trim()
              .toLowerCase()
          )
      );
      return uniqueBaseNames.size;
    },
    [models]
  );

  const findModelForByosProvider = useCallback(
    (provider: ByosProvider): string | null => {
      const def = AGENT_DEFINITIONS.find((a) => a.id === provider);
      const currentModels = useModelStore.getState().models;
      const matches = currentModels.filter((m) => m.provider_name === provider);
      if (matches.length > 0) {
        const preferred = def?.preferredModelSuffix
          ? matches.find((m) => m.name.endsWith(def.preferredModelSuffix!))
          : undefined;
        return (preferred || matches[0]).name;
      }
      return null;
    },
    []
  );

  const refreshLiveModelsForAgent = useCallback(
    async (provider: ByosProvider, showToast = false) => {
      if (!workspaceUuid || !canManageKeys) return;
      setRefreshingAgent(provider);
      try {
        const res = await authedAxios.post<{
          count?: number;
          live_sync?: boolean;
          warning?: string | null;
        }>(
          `${API_BASE}/sandbox/workspaces/${workspaceUuid}/provider-keys/refresh-models/`,
          { provider }
        );
        await useModelStore.getState().fetchFirstPage();
        const latestModels = useModelStore.getState().models.filter((m) => m.provider_name === provider);
        const currentSelected = useChatStore.getState().selectedModel;
        if (latestModels.length > 0 && !latestModels.some((m) => m.name === currentSelected)) {
          const nextModel = latestModels[0].name;
          setSelectedModel(nextModel);
          void fetchModelDetails(nextModel);
        }
        if (showToast) {
          if (res.data?.live_sync) {
            toaster.create({
              title: `${latestModels.length} live models synced`,
              type: "success",
            });
          } else if (res.data?.warning) {
            toaster.create({
              title: "Live model sync unavailable",
              description: res.data.warning,
              type: "warning",
            });
          }
        }
      } catch (err) {
        if (showToast) {
          toaster.create({
            title: extractErrorMessage(err, "Failed to sync models"),
            type: "error",
          });
        }
      } finally {
        setRefreshingAgent(null);
      }
    },
    [canManageKeys, fetchModelDetails, setSelectedModel, workspaceUuid]
  );

  const activateAgentModel = useCallback(
    (agentId: AgentId) => {
      if (agentId === "neuron") {
        const target = lastNeuronModelRef.current || DEFAULT_PLATFORM_MODELS[0]?.name || "deepseek-v4.1-flash-1017";
        setSelectedModel(target);
        void fetchModelDetails(target);
        setOpen(false);
        return;
      }
      const modelName = findModelForByosProvider(agentId);
      if (modelName) {
        setSelectedModel(modelName);
        void fetchModelDetails(modelName);
      }
      setOpen(false);
      void refreshLiveModelsForAgent(agentId);
    },
    [fetchModelDetails, findModelForByosProvider, refreshLiveModelsForAgent, setSelectedModel]
  );

  const finishVmConnect = useCallback(
    async (provider: ByosProvider) => {
      const def = AGENT_DEFINITIONS.find((a) => a.id === provider);
      const agentLabel = def ? t(def.labelKey, { defaultValue: def.fallbackLabel }) : provider;
      await Promise.all([fetchProviderKeys(), useModelStore.getState().fetchFirstPage()]);
      activateAgentModel(provider);
      toaster.create({
        title: t("home.agentSelector.oauth.connectedToast", {
          agent: agentLabel,
          defaultValue: "{{agent}} connected and selected",
        }),
        type: "success",
        duration: 3500,
      });
    },
    [activateAgentModel, fetchProviderKeys, t]
  );

  const openVmConnect = (provider: ByosProvider) => {
    if (!workspaceUuid) {
      toaster.create({
        title: t("home.agentSelector.oauth.noWorkspace", {
          defaultValue: "Select or sign in to a workspace first to connect a subscription.",
        }),
        type: "error",
      });
      return;
    }
    if (!canManageKeys) {
      toaster.create({
        title: t("home.agentSelector.oauth.adminOnly", {
          defaultValue: "Only workspace owners or admins can connect CLI subscriptions.",
        }),
        type: "error",
      });
      return;
    }
    setOpen(false);
    setVmDialogProvider(provider);
  };

  const handleAgentClick = (agent: AgentDefinition) => {
    if (agent.id === "neuron") {
      activateAgentModel("neuron");
      return;
    }
    if (isAgentConnected(agent.id)) {
      activateAgentModel(agent.id);
      return;
    }
    openVmConnect(agent.id);
  };

  const activeDef = AGENT_DEFINITIONS.find((a) => a.id === activeAgentId) || AGENT_DEFINITIONS[0];

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t("home.agentSelector.ariaLabel", { defaultValue: "Select cloud agent" })}
            className="group inline-flex items-center gap-2 rounded-full border border-border/75 bg-card/65 py-1 pl-2.5 pr-2.5 font-mono text-[11px] text-muted-foreground shadow-sm backdrop-blur-md transition-all hover:border-foreground/25 hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
              <AgentBrandLogo id={activeDef.id} size={14} />
              <span className="absolute -bottom-0.5 -right-0.5 flex h-1.5 w-1.5 rounded-full bg-emerald-500 ring-2 ring-background" />
            </span>
            <span className="max-w-[140px] truncate font-medium tracking-tight text-foreground/95">
              {t(activeDef.labelKey, { defaultValue: activeDef.fallbackLabel })}
            </span>
            <LuChevronDown className="h-3 w-3 shrink-0 opacity-60 transition-transform duration-200 group-data-[state=open]:rotate-180" />
          </button>
        </PopoverTrigger>

        <PopoverContent
          align="end"
          sideOffset={8}
          className="w-[392px] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-2xl border-border/80 bg-popover/95 p-0 shadow-[0_24px_64px_-12px_rgba(0,0,0,0.55)] backdrop-blur-2xl"
        >
          <div className="flex flex-col">
            <div className="flex items-center justify-between border-b border-border/60 bg-gradient-to-b from-muted/30 to-transparent px-4 py-3">
              <div>
                <p className="text-[13px] font-semibold tracking-tight text-foreground">
                  {t("home.agentSelector.title", { defaultValue: "Cloud Agent" })}
                </p>
                <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.75)]" />
                  <span>{vmAttached ? t("home.status.vmAttached") : t("home.status.ready")}</span>
                </p>
              </div>
              {loadingKeys && <LuLoader className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            </div>

            <div className="space-y-1.5 p-2">
              {AGENT_DEFINITIONS.map((agent) => {
                const isSelected = activeAgentId === agent.id;
                const connected = isAgentConnected(agent.id);
                const count = agentModelCount(agent.id);
                const isRefreshing = refreshingAgent === agent.id;

                return (
                  <div
                    key={agent.id}
                    className={`group relative flex items-center gap-1 rounded-xl border p-1 transition-all duration-150 ${
                      isSelected
                        ? "border-emerald-500/40 bg-gradient-to-r from-emerald-500/[0.09] via-emerald-500/[0.04] to-transparent shadow-[inset_0_1px_0_0_rgba(16,185,129,0.12)]"
                        : "border-transparent hover:border-border/70 hover:bg-muted/45"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => handleAgentClick(agent)}
                      className="flex min-w-0 flex-1 items-center gap-3 px-2 py-1.5 text-left"
                    >
                      <span
                        className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-transform duration-150 group-hover:scale-[1.03] ${agent.accentClasses}`}
                      >
                        <AgentBrandLogo id={agent.id} size={20} />
                      </span>

                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[13px] font-semibold leading-none tracking-tight text-foreground">
                            {t(agent.labelKey, { defaultValue: agent.fallbackLabel })}
                          </span>
                          {connected && count > 0 && (
                            <span className="rounded-md border border-border/70 bg-muted/60 px-1.5 py-0.5 font-mono text-[9.5px] font-medium leading-none text-muted-foreground">
                              {count} models
                            </span>
                          )}
                          {agent.badgeText && (
                            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[9px] font-medium text-amber-400">
                              {agent.badgeText}
                            </span>
                          )}
                        </span>
                        <span className="mt-1 block truncate text-[11px] leading-snug text-muted-foreground/90">
                          {t(agent.descKey, { defaultValue: agent.fallbackDesc })}
                        </span>
                      </span>

                      {connected ? (
                        isSelected ? (
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/15 text-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.2)]">
                            <LuCheck className="h-3.5 w-3.5" />
                          </span>
                        ) : (
                          <span className="shrink-0 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-0.5 font-mono text-[10px] font-medium text-emerald-400">
                            {agent.id === "neuron"
                              ? t("home.agentSelector.readyBadge", { defaultValue: "Ready" })
                              : t("home.agentSelector.connectedBadge", { defaultValue: "Connected" })}
                          </span>
                        )
                      ) : (
                        <span className="shrink-0 rounded-full border border-border/80 bg-background/85 px-2.5 py-1 font-mono text-[10px] font-medium text-foreground/85 shadow-sm transition-all group-hover:border-foreground/30 group-hover:bg-background group-hover:text-foreground">
                          {t("home.agentSelector.oauthConnectBadge", { defaultValue: "Connect in VM" })}
                        </span>
                      )}
                    </button>

                    {agent.id !== "neuron" && connected && (
                      <div className="mr-1.5 flex shrink-0 items-center gap-0.5 rounded-lg border border-border/50 bg-background/45 p-0.5 backdrop-blur-sm">
                        <button
                          type="button"
                          title="Sync live models"
                          aria-label="Sync live models"
                          disabled={isRefreshing}
                          onClick={() => void refreshLiveModelsForAgent(agent.id as ByosProvider, true)}
                          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                        >
                          <LuRefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
                        </button>
                        <button
                          type="button"
                          title={t("home.agentSelector.reconnect", { defaultValue: "Reconnect in VM" })}
                          aria-label={t("home.agentSelector.reconnect", { defaultValue: "Reconnect in VM" })}
                          onClick={() => openVmConnect(agent.id as ByosProvider)}
                          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          <LuKeyRound className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <VmConnectTerminalDialog
        open={Boolean(vmDialogProvider)}
        provider={vmDialogProvider}
        workspaceUuid={workspaceUuid}
        onOpenChange={(next) => {
          if (!next) setVmDialogProvider(null);
        }}
        onConnected={finishVmConnect}
      />
    </>
  );
}
