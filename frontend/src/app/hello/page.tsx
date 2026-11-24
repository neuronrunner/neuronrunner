"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate } from "react-router-dom";
import type { IconType } from "react-icons";
import {
  LuArrowLeft,
  LuArrowRight,
  LuCircleCheck,
  LuKeyRound,
  LuRoute,
  LuSearch,
  LuServer,
  LuSparkles,
  LuZap,
  LuWaves,
} from "react-icons/lu";
import { SiGooglegemini, SiOpenai } from "react-icons/si";
import { AntigravityBrandLogo, ClaudeBrandLogo, OpenAICodexBrandLogo } from "@/components/brand-logos";
import VmConnectTerminalDialog, { type ByosProvider } from "@/components/chat/vm-connect-terminal-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { LoadingDots } from "@/components/loading-dots";
import { authedAxios, API_BASE } from "@/lib/axios";
import { cn } from "@/lib/utils";
import useAuthStore from "@/stores/auth";
import useChatStore from "@/stores/chat";
import useLlmSetupStore, { needsLlmSetup } from "@/stores/llm-setup";
import useModelStore from "@/stores/search-models";
import useWorkspacesStore from "@/stores/workspaces";

type KeyProvider = "openrouter" | "openai" | "google" | "deepseek" | "groq" | "custom";

interface ProviderOption {
  id: KeyProvider;
  name: string;
  icon: IconType;
  keyUrl?: string;
  placeholder: string;
}

const KEY_PROVIDERS: ProviderOption[] = [
  { id: "openrouter", name: "OpenRouter", icon: LuRoute, keyUrl: "https://openrouter.ai/keys", placeholder: "sk-or-v1-…" },
  { id: "openai", name: "OpenAI", icon: SiOpenai, keyUrl: "https://platform.openai.com/api-keys", placeholder: "sk-…" },
  { id: "google", name: "Google Gemini", icon: SiGooglegemini, keyUrl: "https://aistudio.google.com/apikey", placeholder: "AIza…" },
  { id: "deepseek", name: "DeepSeek", icon: LuWaves, keyUrl: "https://platform.deepseek.com/api_keys", placeholder: "sk-…" },
  { id: "groq", name: "Groq", icon: LuZap, keyUrl: "https://console.groq.com/keys", placeholder: "gsk_…" },
  { id: "custom", name: "", icon: LuServer, placeholder: "" },
];

const SUBSCRIPTIONS: {
  id: ByosProvider;
  name: string;
  descKey: `hello.subscriptions.${"claude" | "codex" | "antigravity"}`;
  Logo: typeof ClaudeBrandLogo;
}[] = [
  { id: "anthropic_sub", name: "Claude Code", descKey: "hello.subscriptions.claude", Logo: ClaudeBrandLogo },
  { id: "openai_sub", name: "OpenAI Codex", descKey: "hello.subscriptions.codex", Logo: OpenAICodexBrandLogo },
  { id: "antigravity_sub", name: "Antigravity", descKey: "hello.subscriptions.antigravity", Logo: AntigravityBrandLogo },
];

interface RemoteModel {
  id: string;
  name: string;
  context_length: number | null;
  supports_vision: boolean;
  supports_tools: boolean | null;
  is_reasoning: boolean | null;
  /** USD per million tokens, when the provider publishes prices (OpenRouter does). */
  prompt_price: number | null;
  completion_price: number | null;
  is_free: boolean;
}

type Step = "choose" | "key" | "models";

const formatPrice = (price: number) => (price < 0.1 ? price.toFixed(3) : price.toFixed(2));

/**
 * Side calls (titles, summaries, memory) go to the cheapest paid model the user picked.
 * Free OpenRouter models are rate limited per day, so they are kept for chat.
 */
const pickAuxiliaryModel = (models: RemoteModel[]): RemoteModel | null => {
  const priced = models.filter((m) => !m.is_free && m.prompt_price !== null && m.completion_price !== null);
  if (priced.length === 0) return null;
  return priced.reduce((best, m) =>
    (m.prompt_price ?? 0) + (m.completion_price ?? 0) < (best.prompt_price ?? 0) + (best.completion_price ?? 0) ? m : best
  );
};

const errorMessage = (error: any, fallback: string) => {
  const data = error?.response?.data;
  if (typeof data?.error === "string") return data.error;
  if (typeof data?.detail === "string") return data.detail;
  if (data && typeof data === "object") {
    const first = Object.values(data).flat()[0];
    if (typeof first === "string") return first;
  }
  return fallback;
};

export default function HelloPage() {
  const { t } = useTranslation("workspace");
  const navigate = useNavigate();
  const { user, token } = useAuthStore();
  // The uuid is persisted and available before the workspace list loads.
  const workspaceUuid = useWorkspacesStore((s) => s.currentWorkspaceUuid);
  const workspaceName = useWorkspacesStore((s) => s.currentWorkspace?.name ?? "");
  const hasLoadedWorkspaces = useWorkspacesStore((s) => s.hasLoaded);
  const setupStatus = useLlmSetupStore((s) => s.status);
  const fetchStatus = useLlmSetupStore((s) => s.fetchStatus);
  const setupLoading = useLlmSetupStore((s) => s.loading);

  const [step, setStep] = useState<Step>("choose");
  const [provider, setProvider] = useState<ProviderOption | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [remoteModels, setRemoteModels] = useState<RemoteModel[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);
  const [byosProvider, setByosProvider] = useState<ByosProvider | null>(null);

  useEffect(() => {
    if (user && token && !hasLoadedWorkspaces) void useWorkspacesStore.getState().fetchWorkspaces();
  }, [user, token, hasLoadedWorkspaces]);

  useEffect(() => {
    if (workspaceUuid) void fetchStatus(workspaceUuid);
  }, [workspaceUuid, fetchStatus]);

  const workspaceBase = workspaceUuid ? `${API_BASE}/sandbox/workspaces/${workspaceUuid}` : "";

  const freeCount = useMemo(() => remoteModels.filter((m) => m.is_free).length, [remoteModels]);

  const filteredModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    return remoteModels.filter(
      (m) =>
        (!freeOnly || m.is_free) &&
        (!query || m.id.toLowerCase().includes(query) || m.name.toLowerCase().includes(query))
    );
  }, [remoteModels, search, freeOnly]);

  if (!user || !token) return <Navigate replace to="/" />;

  /** Refresh everything that depends on the workspace's keys, select a model and open chat. */
  const finish = async (preferredModel?: string) => {
    if (!workspaceUuid) return;
    const [status] = await Promise.all([
      fetchStatus(workspaceUuid, { force: true }),
      useModelStore.getState().fetchFirstPage(),
    ]);
    const modelName = preferredModel || status?.usable_models[0]?.name;
    if (modelName) useChatStore.getState().setSelectedModel(modelName);
    navigate("/new", { replace: true });
  };

  const pickProvider = (option: ProviderOption) => {
    setProvider(option);
    setApiKey("");
    setBaseUrl("");
    setError("");
    setStep("key");
  };

  const connectKey = async () => {
    if (!workspaceUuid || !provider) return;
    setBusy(true);
    setError("");
    let saved = false;
    try {
      await authedAxios.put(`${workspaceBase}/provider-keys/`, {
        provider: provider.id,
        api_key: apiKey.trim(),
        base_url: provider.id === "custom" ? baseUrl.trim() : "",
      });
      saved = true;
      const { data } = await authedAxios.post(`${workspaceBase}/provider-keys/remote-models/`, { provider: provider.id });
      const models: RemoteModel[] = data.models || [];
      setRemoteModels(models);
      setSelected([]);
      setSearch("");
      setFreeOnly(false);
      // Built-in catalog models for this provider may already be usable with the key.
      const status = await fetchStatus(workspaceUuid, { force: true });
      if (models.length === 0 && status && status.usable_model_count > 0) {
        await finish();
        return;
      }
      setStep("models");
    } catch (err: any) {
      // Don't leave a key the provider rejected (or we could not verify) in the workspace.
      if (saved && err?.response?.status === 400) {
        await authedAxios.delete(`${workspaceBase}/provider-keys/`, { data: { provider: provider.id } }).catch(() => undefined);
      }
      setError(errorMessage(err, t("hello.errors.connect")));
    } finally {
      setBusy(false);
    }
  };

  const toggleModel = (id: string) => {
    setSelected((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  };

  const addModelsAndStart = async () => {
    if (!workspaceUuid || !provider) return;
    setBusy(true);
    setError("");
    try {
      let firstName: string | undefined;
      const added = new Map<string, string>();
      for (const id of selected) {
        const model = remoteModels.find((m) => m.id === id);
        if (!model) continue;
        const { data } = await authedAxios.post(`${workspaceBase}/custom-models/`, {
          provider: provider.id,
          display_name: model.name.slice(0, 120),
          external_model_id: model.id,
          context_length: Math.min(Math.max(model.context_length || 128000, 1024), 2097152),
          max_tokens: 8192,
          is_reasoning: Boolean(model.is_reasoning),
          supports_vision: model.supports_vision,
          supports_tools: model.supports_tools ?? true,
          custom_base_url: provider.id === "custom" ? baseUrl.trim() : "",
        });
        firstName = firstName || data?.name;
        if (data?.name) added.set(model.id, data.name);
      }
      const auxiliary = pickAuxiliaryModel(remoteModels.filter((m) => added.has(m.id)));
      if (auxiliary && !setupStatus?.auxiliary_model) {
        // Best effort: without it, side calls simply use the chat model.
        await useLlmSetupStore
          .getState()
          .setAuxiliaryModel(workspaceUuid, added.get(auxiliary.id)!)
          .catch(() => undefined);
      }
      await finish(firstName);
    } catch (err: any) {
      setError(errorMessage(err, t("hello.errors.addModels")));
    } finally {
      setBusy(false);
    }
  };

  const catalogReady = (setupStatus?.usable_model_count ?? 0) > 0;
  const providerName = provider ? (provider.id === "custom" ? t("hello.providers.custom") : provider.name) : "";

  const body = (() => {
    if (!workspaceUuid || (!setupStatus && setupLoading)) {
      return (
        <div className="flex justify-center py-16">
          <LoadingDots />
        </div>
      );
    }

    if (setupStatus && !setupStatus.can_manage && needsLlmSetup(setupStatus)) {
      return (
        <div className="rounded-2xl border border-border/70 bg-card/60 p-6 text-center">
          <LuKeyRound className="mx-auto h-6 w-6 text-indigo-400" />
          <h2 className="mt-3 text-base font-semibold">{t("hello.member.title")}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{t("hello.member.description", { workspace: workspaceName })}</p>
        </div>
      );
    }

    if (step === "key" && provider) {
      const Icon = provider.icon;
      return (
        <div className="space-y-5 rounded-2xl border border-border/70 bg-card/60 p-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-400">
              <Icon className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-base font-semibold">{t("hello.key.title", { provider: providerName })}</h2>
              <p className="text-xs text-muted-foreground">{t("hello.key.stored")}</p>
            </div>
          </div>

          {provider.id === "custom" && (
            <label className="block space-y-1.5">
              <span className="text-xs font-medium">{t("hello.key.baseUrl")}</span>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://my-server.example.com/v1"
                autoFocus
              />
            </label>
          )}

          <label className="block space-y-1.5">
            <span className="text-xs font-medium">
              {provider.id === "custom" ? t("hello.key.apiKeyOptional") : t("hello.key.apiKey")}
            </span>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={provider.placeholder}
              autoComplete="off"
              autoFocus={provider.id !== "custom"}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) void connectKey();
              }}
            />
          </label>

          {provider.keyUrl && (
            <a
              href={provider.keyUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-indigo-500 hover:underline dark:text-indigo-400"
            >
              {t("hello.key.getKey", { provider: provider.name })}
              <LuArrowRight className="h-3 w-3" />
            </a>
          )}

          {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500 dark:text-red-400">{error}</p>}

          <div className="flex items-center justify-between gap-3 pt-1">
            <Button variant="ghost" onClick={() => setStep("choose")} disabled={busy}>
              <LuArrowLeft className="mr-1.5 h-4 w-4" />
              {t("hello.back")}
            </Button>
            <Button
              onClick={() => void connectKey()}
              loading={busy}
              disabled={busy || (provider.id === "custom" ? !baseUrl.trim() : apiKey.trim().length < 12)}
            >
              {t("hello.key.connect")}
            </Button>
          </div>
        </div>
      );
    }

    if (step === "models" && provider) {
      return (
        <div className="space-y-4 rounded-2xl border border-border/70 bg-card/60 p-6">
          <div className="flex items-start gap-3">
            <LuCircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
            <div>
              <h2 className="text-base font-semibold">{t("hello.models.title", { provider: providerName })}</h2>
              <p className="text-sm text-muted-foreground">
                {catalogReady
                  ? t("hello.models.descriptionWithCatalog", { count: setupStatus?.usable_model_count ?? 0 })
                  : t("hello.models.description")}
              </p>
            </div>
          </div>

          {remoteModels.length > 0 ? (
            <>
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative flex-1">
                  <LuSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t("hello.models.search", { count: remoteModels.length })}
                    className="pl-9"
                  />
                </div>
                {freeCount > 0 && (
                  <button
                    type="button"
                    aria-pressed={freeOnly}
                    onClick={() => setFreeOnly((v) => !v)}
                    className={cn(
                      "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors",
                      freeOnly
                        ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                        : "border-border/70 text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {t("hello.models.freeOnly", { count: freeCount })}
                  </button>
                )}
              </div>
              {freeCount > 0 && <p className="text-xs text-muted-foreground">{t("hello.models.freeHint")}</p>}
              <ul className="max-h-80 divide-y divide-border/60 overflow-y-auto rounded-xl border border-border/70">
                {filteredModels.slice(0, 200).map((model) => {
                  const checked = selected.includes(model.id);
                  return (
                    <li key={model.id}>
                      <label className={cn("flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm hover:bg-muted/50", checked && "bg-indigo-500/5")}>
                        <Checkbox checked={checked} onCheckedChange={() => toggleModel(model.id)} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate font-medium">{model.name}</span>
                            {model.is_free && (
                              <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-300">
                                {t("hello.models.free")}
                              </span>
                            )}
                          </span>
                          <span className="block truncate font-mono text-[11px] text-muted-foreground">{model.id}</span>
                        </span>
                        <span className="shrink-0 text-right font-mono text-[11px] leading-tight text-muted-foreground">
                          {!model.is_free && model.prompt_price !== null && model.completion_price !== null && (
                            <span className="block">
                              ${formatPrice(model.prompt_price)} / ${formatPrice(model.completion_price)}
                            </span>
                          )}
                          {model.context_length ? <span className="block">{Math.round(model.context_length / 1000)}K</span> : null}
                        </span>
                      </label>
                    </li>
                  );
                })}
                {filteredModels.length === 0 && (
                  <li className="px-3 py-6 text-center text-sm text-muted-foreground">{t("hello.models.noMatch")}</li>
                )}
              </ul>
            </>
          ) : (
            <p className="rounded-xl border border-dashed border-border/70 px-3 py-6 text-center text-sm text-muted-foreground">
              {t("hello.models.empty")}
            </p>
          )}

          {remoteModels.some((m) => m.prompt_price !== null) && (
            <p className="text-[11px] text-muted-foreground">{t("hello.models.priceHint")}</p>
          )}

          {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500 dark:text-red-400">{error}</p>}

          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">{t("hello.models.selected", { count: selected.length })}</span>
            <div className="flex gap-2">
              {catalogReady && selected.length === 0 && (
                <Button variant="outline" onClick={() => void finish()} disabled={busy}>
                  {t("hello.models.skip")}
                </Button>
              )}
              <Button onClick={() => void addModelsAndStart()} loading={busy} disabled={busy || selected.length === 0}>
                {t("hello.models.start")}
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-8">
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold">{t("hello.choose.apiKeyTitle")}</h2>
            <p className="text-xs text-muted-foreground">{t("hello.choose.apiKeyDescription")}</p>
          </div>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {KEY_PROVIDERS.map((option) => {
              const Icon = option.icon;
              const connected = setupStatus?.configured_providers.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => pickProvider(option)}
                  className="group relative flex items-start gap-3 rounded-xl border border-border/70 bg-card/60 p-3.5 text-left transition-colors hover:border-indigo-500/50 hover:bg-card"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground group-hover:bg-indigo-500/10 group-hover:text-indigo-400">
                    <Icon className="h-[18px] w-[18px]" />
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-sm font-semibold">
                      {option.id === "custom" ? t("hello.providers.custom") : option.name}
                      {option.id === "openrouter" && (
                        <span className="rounded-full bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium text-indigo-500 dark:text-indigo-300">
                          {t("hello.recommended")}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                      {connected ? t("hello.connected") : t(`hello.providerDescriptions.${option.id}`)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold">{t("hello.choose.subscriptionTitle")}</h2>
            <p className="text-xs text-muted-foreground">{t("hello.choose.subscriptionDescription")}</p>
          </div>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
            {SUBSCRIPTIONS.map(({ id, name, descKey, Logo }) => (
              <button
                key={id}
                type="button"
                onClick={() => setByosProvider(id)}
                className="group flex items-center gap-3 rounded-xl border border-border/70 bg-card/60 p-3.5 text-left transition-colors hover:border-indigo-500/50 hover:bg-card"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Logo className="h-5 w-5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{name}</span>
                  <span className="block text-xs text-muted-foreground">{t(descKey)}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>
    );
  })();

  return (
    <main className="mx-auto flex min-h-[calc(100dvh-var(--app-header-height,0px))] w-full max-w-3xl flex-col justify-center px-4 py-12 text-foreground">
      <header className="mb-8 text-center">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 text-xs font-medium text-indigo-500 dark:text-indigo-300">
          <LuSparkles className="h-3.5 w-3.5" />
          {t("hello.badge")}
        </span>
        <h1 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">{t("hello.title")}</h1>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">{t("hello.subtitle")}</p>
      </header>

      {body}

      {step === "choose" && catalogReady && (
        <div className="mt-6 text-center">
          <Button variant="ghost" onClick={() => void finish()}>
            {t("hello.continue")}
            <LuArrowRight className="ml-1.5 h-4 w-4" />
          </Button>
        </div>
      )}

      <VmConnectTerminalDialog
        open={Boolean(byosProvider)}
        provider={byosProvider}
        workspaceUuid={workspaceUuid}
        onOpenChange={(open) => {
          if (!open) setByosProvider(null);
        }}
        onConnected={async () => {
          setByosProvider(null);
          await finish();
        }}
      />
    </main>
  );
}
