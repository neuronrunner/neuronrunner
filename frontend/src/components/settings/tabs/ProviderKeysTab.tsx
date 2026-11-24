"use client";

import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { authedAxios, API_BASE } from "@/lib/axios";
import useWorkspacesStore from "@/stores/workspaces";
import useModelStore from "@/stores/search-models";
import { ReasoningConfigFields } from "@/components/models/reasoning-config-fields";
import AuxiliaryModelSetting from "@/components/settings/auxiliary-model-setting";
import {
  LEGACY_DEFAULT_TIERS,
  buildReasoningConfigPayload,
  getModelReasoningSpec,
  type EditableReasoningMode,
  type ReasoningTier,
} from "@/lib/reasoning";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  LuKey,
  LuCpu,
  LuPlus,
  LuTrash2,
  LuLoaderCircle,
  LuZap,
  LuCircleCheck,
  LuCircleAlert,
  LuArrowRight,
} from "react-icons/lu";

interface ProviderKey {
  uuid: string;
  provider: string;
  auth_type?: "api_key" | "subscription";
  masked_key: string;
  base_url?: string;
  updated_at: string;
}

interface CustomModel {
  uuid: string;
  name: string;
  display_name: string;
  provider: string;
  is_byos?: boolean;
  provider_key?: {
    uuid: string;
    provider: string;
    masked_key: string;
    base_url?: string;
  } | null;
  external_model_id: string;
  external_url?: string;
  context_length: number;
  max_tokens: number;
  is_reasoning: boolean;
  reasoning_mode?: string;
  reasoning_tiers?: ReasoningTier[];
  default_reasoning_effort?: ReasoningTier;
  supports_tools: boolean;
  created_at: string;
}

const providerIds = [
  { id: "openrouter", name: "OpenRouter" },
  { id: "openai", name: "OpenAI" },
  { id: "groq", name: "Groq" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "google", name: "Google Gemini" },
  { id: "custom", nameKey: "providerKeys.providers.custom" as const },
];

const BYOS_PROVIDER_IDS = new Set(["anthropic_sub", "openai_sub", "antigravity_sub"]);

const isByosProviderId = (prov: string) => BYOS_PROVIDER_IDS.has(prov);

export default function ProviderKeysTab() {
  const { t } = useTranslation("settings");
  const workspace = useWorkspacesStore((s) => s.currentWorkspace);
  const [activeTab, setActiveTab] = useState<"keys" | "models">("keys");

  // Provider keys state
  const [keys, setKeys] = useState<ProviderKey[]>([]);
  const [provider, setProvider] = useState("openrouter");
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");

  // Custom models state
  const [customModels, setCustomModels] = useState<CustomModel[]>([]);
  const [isAddingModel, setIsAddingModel] = useState(false);

  // New model form state (key-based model creation)
  const [selectedKeyId, setSelectedKeyId] = useState("");
  const [modelDisplayName, setModelDisplayName] = useState("");
  const [modelExternalId, setModelExternalId] = useState("");
  const [modelContextLength, setModelContextLength] = useState(128000);
  const [modelIsReasoning, setModelIsReasoning] = useState(false);
  const [modelReasoningMode, setModelReasoningMode] = useState<EditableReasoningMode>("effort");
  const [modelReasoningTiers, setModelReasoningTiers] = useState<ReasoningTier[]>([...LEGACY_DEFAULT_TIERS]);
  const [modelDefaultReasoningEffort, setModelDefaultReasoningEffort] = useState<ReasoningTier>("medium");
  const [modelSupportsTools, setModelSupportsTools] = useState(true);

  // Testing & status state
  const [loadingData, setLoadingData] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message?: string; error?: string } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const canManage = workspace?.user_role === "owner" || workspace?.user_role === "admin";
  const keysEndpoint = `${API_BASE}/sandbox/workspaces/${workspace?.uuid}/provider-keys/`;
  const modelsEndpoint = `${API_BASE}/sandbox/workspaces/${workspace?.uuid}/custom-models/`;
  const testEndpoint = `${API_BASE}/sandbox/workspaces/${workspace?.uuid}/custom-models/test/`;

  const loadData = () => {
    if (!workspace || !canManage) return;
    setLoadingData(true);
    Promise.allSettled([
      authedAxios
        .get(keysEndpoint)
        .then(({ data }) => {
          const fetchedKeys: ProviderKey[] = ((data.keys || []) as ProviderKey[]).filter(
            (k) => k.auth_type !== "subscription" && !isByosProviderId(k.provider)
          );
          setKeys(fetchedKeys);
          if (fetchedKeys.length > 0 && !selectedKeyId) {
            setSelectedKeyId(fetchedKeys[0].uuid);
          }
        }),
      authedAxios
        .get(modelsEndpoint)
        .then(({ data }) => {
          const fetchedModels: CustomModel[] = ((data.models || []) as CustomModel[]).filter(
            (m) => !m.is_byos && !isByosProviderId(m.provider)
          );
          setCustomModels(fetchedModels);
        }),
    ]).finally(() => {
      setLoadingData(false);
    });
  };

  useEffect(() => {
    loadData();
  }, [workspace?.uuid, canManage]);

  // Keep selectedKeyId in sync if keys change
  useEffect(() => {
    if (keys.length > 0 && (!selectedKeyId || !keys.some((k) => k.uuid === selectedKeyId))) {
      setSelectedKeyId(keys[0].uuid);
    }
  }, [keys, selectedKeyId]);

  if (!workspace) return <p>{t("providerKeys.selectWorkspace")}</p>;
  if (!canManage)
    return (
      <p className="text-sm text-muted-foreground">
        {t("providerKeys.noPermission")}
      </p>
    );

  // Save provider key
  async function saveKey(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const value = secret;
    const url = baseUrl;
    setSecret("");
    try {
      const payload: Record<string, string> = { provider, api_key: value };
      if (provider === "custom") payload.base_url = url;

      const { data } = await authedAxios.put(keysEndpoint, payload);
      setKeys((prev) => [...prev.filter((k) => k.provider !== provider), data]);
      setNotice(t("providerKeys.notices.keySaved", { provider }));
      loadData();
    } catch (err: any) {
      const apiErr = err?.response?.data?.api_key?.[0] || err?.response?.data?.error;
      setError(apiErr || t("providerKeys.errors.keySaveFailed"));
    } finally {
      setBusy(false);
    }
  }

  // Remove provider key
  async function removeKey(prov: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await authedAxios.delete(keysEndpoint, { data: { provider: prov } });
      setKeys((prev) => prev.filter((k) => k.provider !== prov));
      setNotice(t("providerKeys.notices.keyRemoved", { provider: prov }));
      loadData();
    } catch {
      setError(t("providerKeys.errors.keyRemoveFailed"));
    } finally {
      setBusy(false);
    }
  }

  // Add custom model with selected key
  async function saveCustomModel(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!selectedKeyId) {
      setError(t("providerKeys.errors.selectKeyFirst"));
      return;
    }
    if (!modelDisplayName.trim() || !modelExternalId.trim()) {
      setError(t("providerKeys.errors.modelFieldsRequired"));
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        key_id: selectedKeyId,
        display_name: modelDisplayName.trim(),
        external_model_id: modelExternalId.trim(),
        context_length: modelContextLength,
        max_tokens: 4096,
        ...buildReasoningConfigPayload(
          modelIsReasoning,
          modelReasoningMode,
          modelReasoningTiers,
          modelDefaultReasoningEffort
        ),
        supports_tools: modelSupportsTools,
      };
      const { data } = await authedAxios.post(modelsEndpoint, payload);
      setCustomModels((prev) => [data, ...prev.filter((m) => m.name !== data.name)]);
      setNotice(t("providerKeys.notices.modelAdded", { name: modelDisplayName }));
      setIsAddingModel(false);
      setModelDisplayName("");
      setModelExternalId("");
      setModelIsReasoning(false);
      setModelReasoningMode("effort");
      setModelReasoningTiers([...LEGACY_DEFAULT_TIERS]);
      setModelDefaultReasoningEffort("medium");
      setTestResult(null);
      // Refresh global model store so Chat composer dropdown updates immediately
      useModelStore.getState().fetchFirstPage();
    } catch (err: any) {
      setError(err?.response?.data?.error || t("providerKeys.errors.modelSaveFailed"));
    } finally {
      setBusy(false);
    }
  }

  // Remove custom model
  async function removeCustomModel(name: string, displayName: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await authedAxios.delete(`${modelsEndpoint}${name}/`);
      setCustomModels((prev) => prev.filter((m) => m.name !== name));
      setNotice(t("providerKeys.notices.modelRemoved", { name: displayName }));
      useModelStore.getState().fetchFirstPage();
    } catch {
      setError(t("providerKeys.errors.modelRemoveFailed"));
    } finally {
      setBusy(false);
    }
  }

  // Test custom model connection using the selected key
  async function testConnection(keyId = selectedKeyId, externalId = modelExternalId) {
    if (!keyId) {
      setError(t("providerKeys.errors.selectKeyFirst"));
      return;
    }
    if (!externalId) {
      setError(t("providerKeys.errors.enterExternalId"));
      return;
    }
    setTestBusy(true);
    setTestResult(null);
    setError("");
    try {
      const { data } = await authedAxios.post(testEndpoint, {
        key_id: keyId,
        external_model_id: externalId,
      });
      setTestResult(data);
    } catch (err: any) {
      setTestResult({
        success: false,
        error: err?.response?.data?.error || t("providerKeys.errors.testFailed"),
      });
    } finally {
      setTestBusy(false);
    }
  }

  const selectedKey = keys.find((k) => k.uuid === selectedKeyId);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-base font-semibold">{t("providerKeys.title")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("providerKeys.subtitle", { workspace: workspace.name })}
        </p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border/60">
        <button
          onClick={() => setActiveTab("keys")}
          className={`flex items-center gap-2 border-b-2 px-4 py-2 text-xs font-medium transition-colors ${
            activeTab === "keys"
              ? "border-primary text-foreground font-semibold"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <LuKey className="h-3.5 w-3.5" />
          {t("providerKeys.tabs.keys", { count: keys.length })}
        </button>
        <button
          onClick={() => setActiveTab("models")}
          className={`flex items-center gap-2 border-b-2 px-4 py-2 text-xs font-medium transition-colors ${
            activeTab === "models"
              ? "border-primary text-foreground font-semibold"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <LuCpu className="h-3.5 w-3.5" />
          {t("providerKeys.tabs.models", { count: customModels.length })}
        </button>
      </div>

      {/* Notifications */}
      {error && (
        <div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-3 text-xs text-destructive">
          <LuCircleAlert className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 p-3 text-xs text-emerald-400">
          <LuCircleCheck className="h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {/* TAB 1: PROVIDER API KEYS (BYOK) */}
      {activeTab === "keys" && (
        <div className="space-y-6">
          <form onSubmit={saveKey} className="space-y-3 rounded-xl border p-4 bg-muted/10">
            <label className="block text-xs font-medium" htmlFor="byok-provider">
              {t("providerKeys.keyForm.providerLabel")}
            </label>
            <Select
              value={provider}
              onValueChange={(val) => setProvider(val)}
              disabled={busy}
            >
              <SelectTrigger id="byok-provider" className="h-9 w-full rounded-lg bg-background text-xs">
                <SelectValue placeholder={t("providerKeys.keyForm.providerPlaceholder")} />
              </SelectTrigger>
              <SelectContent className="z-[1300]">
                {providerIds.map((item) => (
                  <SelectItem key={item.id} value={item.id} className="text-xs">
                    {item.nameKey ? t(item.nameKey) : item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {provider === "custom" && (
              <>
                <label className="block text-xs font-medium" htmlFor="byok-base-url">
                  {t("providerKeys.keyForm.baseUrlLabel")}
                </label>
                <Input
                  id="byok-base-url"
                  type="url"
                  placeholder={t("providerKeys.keyForm.baseUrlPlaceholder")}
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  disabled={busy}
                  required
                />
              </>
            )}

            <label className="block text-xs font-medium" htmlFor="byok-secret">
              {t("providerKeys.keyForm.apiKeyLabel")}{" "}
              {provider === "custom" && t("providerKeys.keyForm.apiKeyOptionalSuffix")}
            </label>
            <Input
              id="byok-secret"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={
                provider === "custom"
                  ? t("providerKeys.keyForm.apiKeyPlaceholderCustom")
                  : t("providerKeys.keyForm.apiKeyPlaceholder")
              }
              disabled={busy}
              minLength={provider === "custom" ? 0 : 12}
              maxLength={512}
              required={provider !== "custom"}
            />
            <p className="text-xs text-muted-foreground">
              {t("providerKeys.keyForm.encryptionNote")}
            </p>
            <Button type="submit" disabled={busy || (provider !== "custom" && !secret.trim())}>
              {busy
                ? t("providerKeys.keyForm.saving")
                : keys.some((k) => k.provider === provider)
                ? t("providerKeys.keyForm.updateKey")
                : t("providerKeys.keyForm.saveKey")}
            </Button>
          </form>

          {/* Configured Keys List */}
          <div className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">{t("providerKeys.configuredKeysTitle")}</h3>
            {loadingData ? (
              <div className="space-y-2">
                {[1, 2].map((i) => (
                  <Skeleton key={i} className="h-16 rounded-xl w-full" />
                ))}
              </div>
            ) : keys.length === 0 ? (
              <p className="text-xs text-muted-foreground/80 py-2">{t("providerKeys.noKeys")}</p>
            ) : (
              keys.map((key) => (
                <div key={key.uuid} className="flex items-center justify-between gap-3 rounded-xl border p-3">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium capitalize">{key.provider}</p>
                      <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        {t("providerKeys.connected")}
                      </span>
                    </div>
                    {key.base_url && <p className="text-xs font-mono text-muted-foreground">{key.base_url}</p>}
                    <p className="text-xs text-muted-foreground">{key.masked_key}</p>
                  </div>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => void removeKey(key.provider)}>
                    {t("providerKeys.remove")}
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* TAB 2: CUSTOM MODELS */}
      {activeTab === "models" && (
        <div className="space-y-6">
          {keys.length > 0 && <AuxiliaryModelSetting workspaceUuid={workspace.uuid} />}

          {/* Add Model Prompt if No Keys Exist */}
          {keys.length === 0 ? (
            <div className="rounded-xl border border-dashed p-6 text-center space-y-3 bg-muted/5">
              <div className="mx-auto w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                <LuKey className="h-5 w-5" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold">{t("providerKeys.noKeysPrompt.title")}</p>
                <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                  {t("providerKeys.noKeysPrompt.description")}
                </p>
              </div>
              <Button size="sm" onClick={() => setActiveTab("keys")} className="gap-1.5">
                <span>{t("providerKeys.noKeysPrompt.cta")}</span>
                <LuArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : !isAddingModel ? (
            <Button
              variant="outline"
              className="w-full flex items-center justify-center gap-2 border-dashed py-5"
              onClick={() => setIsAddingModel(true)}
            >
              <LuPlus className="h-4 w-4" />
              <span>{t("providerKeys.addModelButton")}</span>
            </Button>
          ) : (
            /* Add Custom Model Form with Key Selection */
            <form onSubmit={saveCustomModel} className="space-y-4 rounded-xl border p-4 bg-muted/10">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">{t("providerKeys.modelForm.title")}</h3>
                <Button variant="ghost" size="sm" onClick={() => setIsAddingModel(false)}>
                  {t("providerKeys.modelForm.cancel")}
                </Button>
              </div>

              {/* Key Selector */}
              <div>
                <label className="block text-xs font-medium mb-1.5">{t("providerKeys.modelForm.selectKeyLabel")}</label>
                <Select
                  value={selectedKeyId}
                  onValueChange={(val) => {
                    setSelectedKeyId(val);
                    setTestResult(null);
                  }}
                  disabled={busy}
                >
                  <SelectTrigger className="h-9 w-full rounded-lg bg-background text-xs">
                    <SelectValue placeholder={t("providerKeys.modelForm.selectKeyPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent className="z-[1300]">
                    {keys.map((k) => (
                      <SelectItem key={k.uuid} value={k.uuid} className="text-xs">
                        <span className="font-semibold uppercase">{k.provider}</span>{" "}
                        <span className="text-muted-foreground">({k.masked_key})</span>
                        {k.base_url ? ` • ${k.base_url}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedKey && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    <Trans
                      ns="settings"
                      i18nKey="providerKeys.modelForm.routedThrough"
                      values={{ provider: selectedKey.provider }}
                      components={{
                        strong: <span className="font-semibold capitalize text-foreground" />,
                      }}
                    />
                  </p>
                )}
              </div>

              {/* Model details */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">{t("providerKeys.modelForm.displayNameLabel")}</label>
                  <Input
                    placeholder={t("providerKeys.modelForm.displayNamePlaceholder")}
                    value={modelDisplayName}
                    onChange={(e) => setModelDisplayName(e.target.value)}
                    required
                    disabled={busy}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{t("providerKeys.modelForm.externalIdLabel")}</label>
                  <Input
                    placeholder={t("providerKeys.modelForm.externalIdPlaceholder")}
                    value={modelExternalId}
                    onChange={(e) => setModelExternalId(e.target.value)}
                    required
                    disabled={busy}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">{t("providerKeys.modelForm.contextLengthLabel")}</label>
                  <Input
                    type="number"
                    value={modelContextLength}
                    onChange={(e) => setModelContextLength(Number(e.target.value))}
                    disabled={busy}
                  />
                </div>
                <div className="flex items-center gap-2 pt-6">
                  <input
                    type="checkbox"
                    id="model-reasoning"
                    checked={modelIsReasoning}
                    onChange={(e) => setModelIsReasoning(e.target.checked)}
                    className="rounded border"
                    disabled={busy}
                  />
                  <label htmlFor="model-reasoning" className="text-xs font-medium cursor-pointer">
                    {t("providerKeys.modelForm.reasoningLabel")}
                  </label>
                </div>
                <div className="flex items-center gap-2 pt-6">
                  <input
                    type="checkbox"
                    id="model-tools"
                    checked={modelSupportsTools}
                    onChange={(e) => setModelSupportsTools(e.target.checked)}
                    className="rounded border"
                    disabled={busy}
                  />
                  <label htmlFor="model-tools" className="text-xs font-medium cursor-pointer">
                    {t("providerKeys.modelForm.toolsLabel")}
                  </label>
                </div>
              </div>

              {modelIsReasoning && (
                <ReasoningConfigFields
                  reasoningMode={modelReasoningMode}
                  supportedTiers={modelReasoningTiers}
                  defaultTier={modelDefaultReasoningEffort}
                  onChange={(next) => {
                    setModelReasoningMode(next.mode);
                    setModelReasoningTiers(next.tiers);
                    setModelDefaultReasoningEffort(next.defaultTier);
                  }}
                  disabled={busy}
                />
              )}

              {/* Test result banner */}
              {testResult && (
                <div
                  className={`p-3 rounded-lg text-xs flex items-center gap-2 ${
                    testResult.success ? "bg-emerald-500/10 text-emerald-400" : "bg-destructive/10 text-destructive"
                  }`}
                >
                  {testResult.success ? (
                    <LuCircleCheck className="h-4 w-4 shrink-0" />
                  ) : (
                    <LuCircleAlert className="h-4 w-4 shrink-0" />
                  )}
                  <span>{testResult.success ? testResult.message : testResult.error}</span>
                </div>
              )}

              <div className="flex items-center gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={testBusy || busy || !modelExternalId || !selectedKeyId}
                  onClick={() => void testConnection(selectedKeyId, modelExternalId)}
                >
                  {testBusy ? (
                    <>
                      <LuLoaderCircle className="h-3.5 w-3.5 mr-1.5 animate-spin" /> {t("providerKeys.modelForm.testing")}
                    </>
                  ) : (
                    <>
                      <LuZap className="h-3.5 w-3.5 mr-1.5" /> {t("providerKeys.modelForm.testConnection")}
                    </>
                  )}
                </Button>
                <Button type="submit" size="sm" disabled={busy || !selectedKeyId}>
                  {busy ? t("providerKeys.modelForm.saving") : t("providerKeys.modelForm.saveModel")}
                </Button>
              </div>
            </form>
          )}

          {/* Configured Models List */}
          <div className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">{t("providerKeys.activeModelsTitle")}</h3>
            {loadingData ? (
              <div className="space-y-2">
                {[1, 2].map((i) => (
                  <Skeleton key={i} className="h-16 rounded-xl w-full" />
                ))}
              </div>
            ) : customModels.length === 0 ? (
              <p className="text-xs text-muted-foreground/80 py-2">{t("providerKeys.noModels")}</p>
            ) : (
              customModels.map((model) => {
                const boundKey = model.provider_key;
                const reasoningSpec = model.is_reasoning ? getModelReasoningSpec(model) : null;
                return (
                  <div
                    key={model.uuid}
                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border p-3 hover:border-zinc-700 transition-colors"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold">{model.display_name}</p>
                        <span className="rounded-full px-2 py-0.5 text-[10px] font-medium bg-indigo-500/15 text-indigo-400 border border-indigo-500/30">
                          BYOK
                        </span>
                        <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-zinc-800 text-zinc-300 uppercase">
                          {model.provider}
                        </span>
                        {reasoningSpec?.isReasoning && (
                          <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-purple-500/15 text-purple-400">
                            {t("providerKeys.modelCard.thinking")} (
                            {reasoningSpec.tiers
                              .map((tier) => t(`chat:composer.reasoning.${tier}`, { defaultValue: tier }))
                              .join(" / ")}
                            )
                          </span>
                        )}
                      </div>
                      <p className="text-xs font-mono text-muted-foreground truncate">{model.external_model_id}</p>
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground/80 flex-wrap">
                        {boundKey ? (
                          <span>
                            <Trans
                              ns="settings"
                              i18nKey="providerKeys.modelCard.keyLabel"
                              values={{ provider: boundKey.provider, maskedKey: boundKey.masked_key }}
                              components={{
                                strong: <strong className="capitalize text-foreground" />,
                              }}
                            />
                          </span>
                        ) : (
                          <span>
                            <Trans
                              ns="settings"
                              i18nKey="providerKeys.modelCard.providerLabel"
                              values={{ provider: model.provider }}
                              components={{
                                strong: <strong className="capitalize text-foreground" />,
                              }}
                            />
                          </span>
                        )}
                        <span>•</span>
                        <span>{t("providerKeys.modelCard.context", { count: (model.context_length / 1000).toFixed(0) })}</span>
                        <span>•</span>
                        <span>
                          {t("providerKeys.modelCard.tools", {
                            supported: model.supports_tools
                              ? t("providerKeys.modelCard.yes")
                              : t("providerKeys.modelCard.no"),
                          })}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs"
                        disabled={testBusy || busy}
                        onClick={() =>
                          void testConnection(
                            model.provider_key?.uuid || model.provider,
                            model.external_model_id
                          )
                        }
                      >
                        <LuZap className="h-3 w-3 mr-1" /> {t("providerKeys.modelCard.test")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs text-destructive hover:bg-destructive/10"
                        disabled={busy}
                        onClick={() => void removeCustomModel(model.name, model.display_name)}
                      >
                        <LuTrash2 className="h-3 w-3 mr-1" /> {t("providerKeys.remove")}
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
