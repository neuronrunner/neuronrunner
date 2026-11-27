"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate } from "react-router-dom";
import type { IconType } from "react-icons";
import {
  LuArrowLeft,
  LuArrowRight,
  LuArrowUpRight,
  LuCheck,
  LuCircleCheck,
  LuEye,
  LuEyeOff,
  LuGitBranch,
  LuGithub,
  LuKeyRound,
  LuLoaderCircle,
  LuLock,
  LuRoute,
  LuSearch,
  LuServer,
  LuShieldCheck,
  LuSparkles,
  LuTerminal,
  LuWaves,
  LuZap,
} from "react-icons/lu";
import { SiGitlab, SiGooglegemini, SiOpenai } from "react-icons/si";
import { AntigravityBrandLogo, ClaudeBrandLogo, OpenAICodexBrandLogo } from "@/components/brand-logos";
import VmConnectTerminalDialog, { type ByosProvider } from "@/components/chat/vm-connect-terminal-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { LoadingDots } from "@/components/loading-dots";
import frontendExtension from "@cloud";
import { authedAxios, API_BASE } from "@/lib/axios";
import {
  connectGithubAccount,
  getGithubAccountStatus,
  notifyGithubAccountsChanged,
  type GithubAccount,
} from "@/lib/github-connection";
import {
  connectGitlabAccount,
  getGitlabAccountStatus,
  notifyGitlabAccountsChanged,
  type GitlabAccount,
} from "@/lib/gitlab-connection";
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
  featured?: boolean;
  iconSurface: string;
  hoverBorder: string;
  hoverGlow: string;
}

const KEY_PROVIDERS: ProviderOption[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    icon: LuRoute,
    keyUrl: "https://openrouter.ai/keys",
    placeholder: "sk-or-v1-…",
    featured: true,
    iconSurface: "border-indigo-500/30 bg-indigo-500/[0.12] text-indigo-500 dark:text-indigo-300",
    hoverBorder: "hover:border-indigo-400/70 dark:hover:border-indigo-400/60",
    hoverGlow: "from-indigo-500/[0.14] via-violet-500/[0.04] to-transparent",
  },
  {
    id: "openai",
    name: "OpenAI",
    icon: SiOpenai,
    keyUrl: "https://platform.openai.com/api-keys",
    placeholder: "sk-…",
    iconSurface: "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    hoverBorder: "hover:border-emerald-500/45",
    hoverGlow: "from-emerald-500/[0.10] via-emerald-500/[0.02] to-transparent",
  },
  {
    id: "google",
    name: "Google Gemini",
    icon: SiGooglegemini,
    keyUrl: "https://aistudio.google.com/apikey",
    placeholder: "AIza…",
    iconSurface: "border-sky-500/25 bg-sky-500/10 text-sky-600 dark:text-sky-400",
    hoverBorder: "hover:border-sky-500/45",
    hoverGlow: "from-sky-500/[0.10] via-blue-500/[0.02] to-transparent",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    icon: LuWaves,
    keyUrl: "https://platform.deepseek.com/api_keys",
    placeholder: "sk-…",
    iconSurface: "border-blue-500/25 bg-blue-500/10 text-blue-600 dark:text-blue-400",
    hoverBorder: "hover:border-blue-500/45",
    hoverGlow: "from-blue-500/[0.10] via-indigo-500/[0.02] to-transparent",
  },
  {
    id: "groq",
    name: "Groq",
    icon: LuZap,
    keyUrl: "https://console.groq.com/keys",
    placeholder: "gsk_…",
    iconSurface: "border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    hoverBorder: "hover:border-amber-500/45",
    hoverGlow: "from-amber-500/[0.10] via-orange-500/[0.02] to-transparent",
  },
  {
    id: "custom",
    name: "",
    icon: LuServer,
    placeholder: "",
    iconSurface: "border-violet-500/25 bg-violet-500/10 text-violet-600 dark:text-violet-400",
    hoverBorder: "hover:border-violet-500/45",
    hoverGlow: "from-violet-500/[0.10] via-fuchsia-500/[0.02] to-transparent",
  },
];

const SUBSCRIPTIONS: {
  id: ByosProvider;
  name: string;
  descKey: `hello.subscriptions.${"claude" | "codex" | "antigravity"}`;
  Logo: typeof ClaudeBrandLogo;
  hoverBorder: string;
  hoverGlow: string;
  logoSurface: string;
}[] = [
  {
    id: "anthropic_sub",
    name: "Claude Code",
    descKey: "hello.subscriptions.claude",
    Logo: ClaudeBrandLogo,
    hoverBorder: "hover:border-[#D97757]/55",
    hoverGlow: "from-[#D97757]/[0.12] via-[#D97757]/[0.02] to-transparent",
    logoSurface: "border-[#D97757]/25 bg-[#D97757]/[0.08]",
  },
  {
    id: "openai_sub",
    name: "OpenAI Codex",
    descKey: "hello.subscriptions.codex",
    Logo: OpenAICodexBrandLogo,
    hoverBorder: "hover:border-foreground/30",
    hoverGlow: "from-foreground/[0.07] via-foreground/[0.02] to-transparent",
    logoSurface: "border-border/80 bg-muted/60",
  },
  {
    id: "antigravity_sub",
    name: "Antigravity",
    descKey: "hello.subscriptions.antigravity",
    Logo: AntigravityBrandLogo,
    hoverBorder: "hover:border-sky-500/50",
    hoverGlow: "from-sky-500/[0.11] via-indigo-500/[0.03] to-transparent",
    logoSurface: "border-sky-500/25 bg-sky-500/[0.08]",
  },
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

type Step = "git" | "choose" | "key" | "models";

const STEP_INDEX: Record<Step, number> = {
  git: 0,
  choose: 0,
  key: 1,
  models: 2,
};

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

  const isCloud = frontendExtension.edition === "cloud";
  const [step, setStep] = useState<Step>(() => (isCloud ? "git" : "choose"));
  const [provider, setProvider] = useState<ProviderOption | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [remoteModels, setRemoteModels] = useState<RemoteModel[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);
  const [byosProvider, setByosProvider] = useState<ByosProvider | null>(null);
  const [githubAccount, setGithubAccount] = useState<GithubAccount | null>(null);
  const [githubConfigured, setGithubConfigured] = useState(true);
  const [gitlabAccount, setGitlabAccount] = useState<GitlabAccount | null>(null);
  const [gitlabConfigured, setGitlabConfigured] = useState(false);
  const [gitStatusLoaded, setGitStatusLoaded] = useState(false);
  const [connectingGit, setConnectingGit] = useState<"github" | "gitlab" | null>(null);
  const [gitError, setGitError] = useState("");

  useEffect(() => {
    if (user && token && !hasLoadedWorkspaces) void useWorkspacesStore.getState().fetchWorkspaces();
  }, [user, token, hasLoadedWorkspaces]);

  useEffect(() => {
    if (workspaceUuid) void fetchStatus(workspaceUuid);
  }, [workspaceUuid, fetchStatus]);

  useEffect(() => {
    if (!user || !token) return;
    const controller = new AbortController();
    let active = true;
    void Promise.allSettled([
      getGithubAccountStatus(controller.signal),
      getGitlabAccountStatus(controller.signal),
    ]).then(([ghRes, glRes]) => {
      if (!active || controller.signal.aborted) return;
      const ghAcc = ghRes.status === "fulfilled" ? (ghRes.value.accounts[0] ?? null) : null;
      const ghCfg = ghRes.status === "fulfilled" ? ghRes.value.configured : true;
      const glAcc = glRes.status === "fulfilled" ? (glRes.value.accounts[0] ?? null) : null;
      const glCfg = glRes.status === "fulfilled" ? glRes.value.configured : false;
      setGithubAccount(ghAcc);
      setGithubConfigured(ghCfg);
      setGitlabAccount(glAcc);
      setGitlabConfigured(glCfg);
      setGitStatusLoaded(true);
      if (isCloud) {
        const hasGit = Boolean(ghAcc || glAcc);
        const anyGitConfigured = ghCfg || glCfg;
        setStep((current) => {
          if (current === "git" && (hasGit || !anyGitConfigured)) return "choose";
          return current;
        });
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [user, token, isCloud]);

  const handleConnectGit = async (gitProvider: "github" | "gitlab") => {
    setConnectingGit(gitProvider);
    setGitError("");
    try {
      let connectedAccount: GithubAccount | GitlabAccount | null = null;
      if (gitProvider === "github") {
        await connectGithubAccount();
        notifyGithubAccountsChanged();
        const res = await getGithubAccountStatus();
        connectedAccount = res.accounts[0] ?? null;
        setGithubAccount(connectedAccount);
      } else {
        await connectGitlabAccount();
        notifyGitlabAccountsChanged();
        const res = await getGitlabAccountStatus();
        connectedAccount = res.accounts[0] ?? null;
        setGitlabAccount(connectedAccount);
      }
      if (isCloud && connectedAccount) {
        setStep("choose");
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        setGitError(errorMessage(err, err?.message || t("hello.git.connectError")));
      }
    } finally {
      setConnectingGit(null);
    }
  };

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
    setShowKey(false);
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
  const activeStepIndex = STEP_INDEX[step];
  const gitConnected = Boolean(githubAccount || gitlabAccount);
  const hasCloudGitStep = isCloud && (githubConfigured || gitlabConfigured);

  const renderGitButtons = () => (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {/* GitHub */}
      <button
        type="button"
        disabled={!githubConfigured || connectingGit !== null}
        onClick={() => void handleConnectGit("github")}
        className={cn(
          "group relative flex items-center gap-3 overflow-hidden rounded-2xl border p-3.5 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 disabled:cursor-not-allowed disabled:opacity-60",
          githubAccount
            ? "border-emerald-500/35 bg-gradient-to-b from-emerald-500/[0.06] via-card/95 to-card/75 hover:border-emerald-500/55"
            : "border-border/75 bg-gradient-to-b from-card/90 to-card/60 hover:-translate-y-0.5 hover:border-foreground/30 hover:bg-card/95 hover:shadow-lg hover:shadow-black/10 dark:hover:shadow-black/40"
        )}
      >
        <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border/80 bg-muted/60 text-foreground transition-transform duration-200 group-hover:scale-105">
          <LuGithub className="h-5 w-5" />
        </span>
        <span className="relative min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold tracking-tight text-foreground">GitHub</span>
            {githubAccount && (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/[0.12] px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {t("hello.connected")}
              </span>
            )}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {githubAccount
              ? `@${githubAccount.login || "GitHub"}`
              : !githubConfigured
                ? t("hello.git.notConfigured")
                : t("hello.git.githubDesc")}
          </span>
        </span>
        {connectingGit === "github" ? (
          <LuLoaderCircle className="relative h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <LuArrowRight className="relative h-4 w-4 shrink-0 text-muted-foreground/50 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-foreground" />
        )}
      </button>

      {/* GitLab */}
      <button
        type="button"
        disabled={!gitlabConfigured || connectingGit !== null}
        onClick={() => void handleConnectGit("gitlab")}
        className={cn(
          "group relative flex items-center gap-3 overflow-hidden rounded-2xl border p-3.5 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 disabled:cursor-not-allowed disabled:opacity-60",
          gitlabAccount
            ? "border-emerald-500/35 bg-gradient-to-b from-emerald-500/[0.06] via-card/95 to-card/75 hover:border-emerald-500/55"
            : "border-border/75 bg-gradient-to-b from-card/90 to-card/60 hover:-translate-y-0.5 hover:border-orange-500/45 hover:bg-card/95 hover:shadow-lg hover:shadow-black/10 dark:hover:shadow-black/40"
        )}
      >
        <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-orange-500/25 bg-orange-500/10 text-orange-500 transition-transform duration-200 group-hover:scale-105">
          <SiGitlab className="h-5 w-5" />
        </span>
        <span className="relative min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold tracking-tight text-foreground">GitLab</span>
            {gitlabAccount ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/[0.12] px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {t("hello.connected")}
              </span>
            ) : !gitlabConfigured ? (
              <span className="inline-flex items-center rounded-full border border-border/70 bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {t("hello.git.notConfigured")}
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {gitlabAccount
              ? `@${gitlabAccount.login || "GitLab"}`
              : t("hello.git.gitlabDesc")}
          </span>
        </span>
        {connectingGit === "gitlab" ? (
          <LuLoaderCircle className="relative h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <LuArrowRight className="relative h-4 w-4 shrink-0 text-muted-foreground/50 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-foreground" />
        )}
      </button>
    </div>
  );

  const body = (() => {
    if (!workspaceUuid || (!setupStatus && setupLoading) || (isCloud && !gitStatusLoaded)) {
      return (
        <div className="flex justify-center py-20">
          <LoadingDots />
        </div>
      );
    }

    if (setupStatus && !setupStatus.can_manage && needsLlmSetup(setupStatus)) {
      return (
        <div className="mx-auto max-w-lg rounded-2xl border border-border/75 bg-gradient-to-b from-card/95 to-card/75 p-8 text-center shadow-xl shadow-black/5 backdrop-blur-md dark:shadow-black/40">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-indigo-500/25 bg-indigo-500/10 text-indigo-500 dark:text-indigo-400">
            <LuKeyRound className="h-5 w-5" />
          </div>
          <h2 className="mt-4 text-lg font-semibold tracking-tight">{t("hello.member.title")}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {t("hello.member.description", { workspace: workspaceName })}
          </p>
        </div>
      );
    }

    if (step === "key" && provider) {
      const Icon = provider.icon;
      return (
        <div className="mx-auto max-w-xl overflow-hidden rounded-2xl border border-border/75 bg-gradient-to-b from-card/95 to-card/75 shadow-2xl shadow-black/5 backdrop-blur-md ring-1 ring-inset ring-white/[0.04] dark:shadow-black/50">
          <div className="relative border-b border-border/60 px-6 py-5 sm:px-7">
            <div
              aria-hidden="true"
              className={cn("pointer-events-none absolute inset-0 bg-gradient-to-br opacity-80", provider.hoverGlow)}
            />
            <div className="relative flex items-center gap-3.5">
              <span
                className={cn(
                  "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border shadow-xs",
                  provider.iconSurface
                )}
              >
                <Icon className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h2 className="text-base font-semibold tracking-tight sm:text-lg">
                  {t("hello.key.title", { provider: providerName })}
                </h2>
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <LuShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                  <span>{t("hello.key.stored")}</span>
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-5 p-6 sm:p-7">
            {provider.id === "custom" && (
              <label className="block space-y-2">
                <span className="text-xs font-medium text-foreground/90">{t("hello.key.baseUrl")}</span>
                <Input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://my-server.example.com/v1"
                  className="h-11 rounded-xl border-border/80 bg-background/70 font-mono text-sm"
                  autoFocus
                />
              </label>
            )}

            <label className="block space-y-2">
              <span className="text-xs font-medium text-foreground/90">
                {provider.id === "custom" ? t("hello.key.apiKeyOptional") : t("hello.key.apiKey")}
              </span>
              <div className="relative">
                <Input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={provider.placeholder}
                  className="h-11 rounded-xl border-border/80 bg-background/70 pr-10 font-mono text-sm"
                  autoComplete="off"
                  autoFocus={provider.id !== "custom"}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !busy) void connectKey();
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowKey((prev) => !prev)}
                  tabIndex={-1}
                  aria-label={showKey ? "Hide API key" : "Show API key"}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
                >
                  {showKey ? <LuEyeOff className="h-4 w-4" /> : <LuEye className="h-4 w-4" />}
                </button>
              </div>
            </label>

            {provider.keyUrl && (
              <div>
                <a
                  href={provider.keyUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.06] px-3 py-1.5 text-xs font-medium text-indigo-600 transition-colors hover:border-indigo-500/40 hover:bg-indigo-500/10 dark:text-indigo-300"
                >
                  {t("hello.key.getKey", { provider: provider.name })}
                  <LuArrowUpRight className="h-3.5 w-3.5" />
                </a>
              </div>
            )}

            {error && (
              <p className="rounded-xl border border-red-500/25 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}

            <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-5">
              <Button variant="ghost" className="rounded-xl" onClick={() => setStep("choose")} disabled={busy}>
                <LuArrowLeft className="mr-1.5 h-4 w-4" />
                {t("hello.back")}
              </Button>
              <Button
                className="rounded-xl px-5 shadow-sm"
                onClick={() => void connectKey()}
                loading={busy}
                disabled={busy || (provider.id === "custom" ? !baseUrl.trim() : apiKey.trim().length < 12)}
              >
                {t("hello.key.connect")}
                <LuArrowRight className="ml-1.5 h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      );
    }

    if (step === "models" && provider) {
      return (
        <div className="mx-auto max-w-2xl overflow-hidden rounded-2xl border border-border/75 bg-gradient-to-b from-card/95 to-card/75 shadow-2xl shadow-black/5 backdrop-blur-md ring-1 ring-inset ring-white/[0.04] dark:shadow-black/50">
          <div className="border-b border-border/60 bg-emerald-500/[0.04] px-6 py-5 sm:px-7">
            <div className="flex items-start gap-3.5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/[0.12] text-emerald-500 dark:text-emerald-400">
                <LuCircleCheck className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h2 className="text-base font-semibold tracking-tight sm:text-lg">
                  {t("hello.models.title", { provider: providerName })}
                </h2>
                <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
                  {catalogReady
                    ? t("hello.models.descriptionWithCatalog", { count: setupStatus?.usable_model_count ?? 0 })
                    : t("hello.models.description")}
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-4 p-6 sm:p-7">
            {remoteModels.length > 0 ? (
              <>
                <div className="flex flex-col gap-2.5 sm:flex-row">
                  <div className="relative flex-1">
                    <LuSearch className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder={t("hello.models.search", { count: remoteModels.length })}
                      className="h-10 rounded-xl border-border/80 bg-background/70 pl-10 text-sm"
                    />
                  </div>
                  {freeCount > 0 && (
                    <button
                      type="button"
                      aria-pressed={freeOnly}
                      onClick={() => setFreeOnly((v) => !v)}
                      className={cn(
                        "inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl border px-3.5 text-xs font-medium transition-all",
                        freeOnly
                          ? "border-emerald-500/50 bg-emerald-500/[0.12] text-emerald-600 shadow-xs dark:text-emerald-300"
                          : "border-border/80 bg-background/50 text-muted-foreground hover:border-border hover:text-foreground"
                      )}
                    >
                      {freeOnly && <LuCheck className="h-3.5 w-3.5" />}
                      {t("hello.models.freeOnly", { count: freeCount })}
                    </button>
                  )}
                </div>

                {freeCount > 0 && <p className="text-xs text-muted-foreground">{t("hello.models.freeHint")}</p>}

                <ul className="max-h-80 divide-y divide-border/50 overflow-y-auto rounded-xl border border-border/75 bg-background/50">
                  {filteredModels.slice(0, 200).map((model) => {
                    const checked = selected.includes(model.id);
                    return (
                      <li key={model.id}>
                        <label
                          className={cn(
                            "flex cursor-pointer items-center gap-3 px-3.5 py-3 text-sm transition-colors hover:bg-muted/45",
                            checked && "bg-indigo-500/[0.08] hover:bg-indigo-500/[0.11]"
                          )}
                        >
                          <Checkbox checked={checked} onCheckedChange={() => toggleModel(model.id)} />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                              <span className="truncate font-medium text-foreground">{model.name}</span>
                              {model.is_free && (
                                <span className="shrink-0 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-300">
                                  {t("hello.models.free")}
                                </span>
                              )}
                            </span>
                            <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                              {model.id}
                            </span>
                          </span>
                          <span className="flex shrink-0 flex-col items-end gap-0.5 text-right font-mono text-[11px] tabular-nums leading-tight text-muted-foreground">
                            {!model.is_free && model.prompt_price !== null && model.completion_price !== null && (
                              <span className="text-foreground/80">
                                ${formatPrice(model.prompt_price)} / ${formatPrice(model.completion_price)}
                              </span>
                            )}
                            {model.context_length ? (
                              <span className="rounded bg-muted/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                {Math.round(model.context_length / 1000)}K
                              </span>
                            ) : null}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                  {filteredModels.length === 0 && (
                    <li className="px-4 py-8 text-center text-sm text-muted-foreground">{t("hello.models.noMatch")}</li>
                  )}
                </ul>
              </>
            ) : (
              <p className="rounded-xl border border-dashed border-border/80 bg-background/40 px-4 py-8 text-center text-sm text-muted-foreground">
                {t("hello.models.empty")}
              </p>
            )}

            {remoteModels.some((m) => m.prompt_price !== null) && (
              <p className="text-[11px] leading-relaxed text-muted-foreground">{t("hello.models.priceHint")}</p>
            )}

            {error && (
              <p className="rounded-xl border border-red-500/25 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
              <span className="inline-flex items-center rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
                {t("hello.models.selected", { count: selected.length })}
              </span>
              <div className="flex items-center gap-2">
                {catalogReady && selected.length === 0 && (
                  <Button variant="outline" className="rounded-xl" onClick={() => void finish()} disabled={busy}>
                    {t("hello.models.skip")}
                  </Button>
                )}
                <Button
                  className="rounded-xl px-5 shadow-sm"
                  onClick={() => void addModelsAndStart()}
                  loading={busy}
                  disabled={busy || selected.length === 0}
                >
                  {t("hello.models.start")}
                  <LuArrowRight className="ml-1.5 h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (step === "git" && hasCloudGitStep) {
      return (
        <div className="mx-auto max-w-2xl overflow-hidden rounded-2xl border border-border/75 bg-gradient-to-b from-card/95 to-card/75 shadow-2xl shadow-black/5 backdrop-blur-md ring-1 ring-inset ring-white/[0.04] dark:shadow-black/50">
          <div className="border-b border-border/60 px-6 py-5 sm:px-7">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                  <LuGitBranch className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <h2 className="text-base font-semibold tracking-tight text-foreground sm:text-lg">
                    {t("hello.git.title")}
                  </h2>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground sm:text-sm">
                    {t("hello.git.cloudDescription")}
                  </p>
                </div>
              </div>
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-tight",
                  gitConnected
                    ? "border-emerald-500/35 bg-emerald-500/12 text-emerald-600 dark:text-emerald-300"
                    : "border-indigo-500/35 bg-indigo-500/12 text-indigo-600 dark:text-indigo-300"
                )}
              >
                {gitConnected ? <LuCircleCheck className="h-3.5 w-3.5" /> : <LuSparkles className="h-3.5 w-3.5" />}
                {gitConnected ? t("hello.git.creditUnlocked") : t("hello.git.creditBadge")}
              </span>
            </div>
          </div>

          <div className="space-y-4 p-6 sm:p-7">
            {renderGitButtons()}

            {gitError && (
              <p className="rounded-xl border border-red-500/25 bg-red-500/10 px-3.5 py-2.5 text-xs text-red-600 dark:text-red-400">
                {gitError}
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <LuShieldCheck className="h-4 w-4 shrink-0 text-emerald-500" />
                <span>{t("hello.git.stepHint")}</span>
              </p>
              {gitConnected && (
                <Button className="rounded-xl px-5 shadow-sm" onClick={() => setStep("choose")}>
                  {t("hello.git.continueToAi")}
                  <LuArrowRight className="ml-1.5 h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-6">
        {/* Git account connection (self-hosted shows inline; cloud completes Git in Step 1) */}
        {!hasCloudGitStep && (
          <>
            <section className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                    <LuGitBranch className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
                      {t("hello.git.title")}
                    </h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t("hello.git.description")}
                    </p>
                  </div>
                </div>
              </div>

              {renderGitButtons()}

              {gitError && (
                <p className="rounded-xl border border-red-500/25 bg-red-500/10 px-3.5 py-2.5 text-xs text-red-600 dark:text-red-400">
                  {gitError}
                </p>
              )}
            </section>

            {/* Hairline divider */}
            <div
              aria-hidden="true"
              className="h-px w-full bg-gradient-to-r from-transparent via-border/90 to-transparent"
            />
          </>
        )}

        {/* Subscription CLI providers */}
        <section className="space-y-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-cyan-500/25 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400">
              <LuTerminal className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
                {t("hello.choose.subscriptionTitle")}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("hello.choose.subscriptionDescription")}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {SUBSCRIPTIONS.map(({ id, name, descKey, Logo, hoverBorder, hoverGlow, logoSurface }) => {
              const connected = setupStatus?.configured_providers.includes(id);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setByosProvider(id)}
                  className={cn(
                    "group relative flex items-center gap-3 overflow-hidden rounded-2xl border p-3.5 text-left transition-all duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50",
                    connected
                      ? "border-emerald-500/35 bg-gradient-to-b from-emerald-500/[0.06] via-card/95 to-card/75 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] hover:border-emerald-500/55"
                      : "border-border/75 bg-gradient-to-b from-card/90 to-card/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] hover:bg-card/95 hover:shadow-lg hover:shadow-black/10 dark:hover:shadow-black/40",
                    hoverBorder
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "pointer-events-none absolute inset-0 bg-gradient-to-br opacity-0 transition-opacity duration-300 group-hover:opacity-100",
                      hoverGlow
                    )}
                  />

                  <span
                    className={cn(
                      "relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-transform duration-200 group-hover:scale-105",
                      logoSurface
                    )}
                  >
                    <Logo className="h-5 w-5" />
                  </span>

                  <span className="relative min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-semibold tracking-tight text-foreground">{name}</span>
                      {connected && (
                        <span
                          title={t("hello.connected")}
                          className="h-2 w-2 shrink-0 rounded-full bg-emerald-500"
                        />
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">{t(descKey)}</span>
                  </span>

                  <LuArrowRight className="relative h-4 w-4 shrink-0 text-muted-foreground/50 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-foreground" />
                </button>
              );
            })}
          </div>
        </section>

        {/* Hairline divider */}
        <div
          aria-hidden="true"
          className="h-px w-full bg-gradient-to-r from-transparent via-border/90 to-transparent"
        />

        {/* API key providers */}
        <section className="space-y-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-indigo-500/25 bg-indigo-500/10 text-indigo-500 dark:text-indigo-400">
              <LuKeyRound className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
                {t("hello.choose.apiKeyTitle")}
              </h2>
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <LuLock className="h-3 w-3 shrink-0 opacity-70" />
                <span>{t("hello.choose.apiKeyDescription")}</span>
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {KEY_PROVIDERS.map((option) => {
              const Icon = option.icon;
              const connected = setupStatus?.configured_providers.includes(option.id);
              const isFeatured = Boolean(option.featured && !connected);

              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => pickProvider(option)}
                  className={cn(
                    "group relative flex flex-col overflow-hidden rounded-2xl border p-3.5 text-left transition-all duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 sm:p-4",
                    isFeatured
                      ? "border-indigo-500/40 bg-gradient-to-b from-indigo-500/[0.08] via-card/95 to-card/75 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_12px_30px_-18px_rgba(99,102,241,0.45)] ring-1 ring-indigo-500/15 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_18px_36px_-18px_rgba(99,102,241,0.55)]"
                      : connected
                        ? "border-emerald-500/35 bg-gradient-to-b from-emerald-500/[0.06] via-card/95 to-card/75 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] hover:border-emerald-500/55 hover:shadow-lg hover:shadow-emerald-500/10"
                        : "border-border/75 bg-gradient-to-b from-card/90 to-card/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] hover:bg-card/95 hover:shadow-lg hover:shadow-black/10 dark:hover:shadow-black/40",
                    option.hoverBorder
                  )}
                >
                  {/* Subtle top-left hover wash */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "pointer-events-none absolute inset-0 bg-gradient-to-br opacity-0 transition-opacity duration-300 group-hover:opacity-100",
                      option.hoverGlow
                    )}
                  />

                  {/* Top row: Icon tile + Badge / Hover arrow */}
                  <div className="relative flex w-full items-center justify-between gap-2">
                    <span
                      className={cn(
                        "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition-transform duration-200 group-hover:scale-105",
                        option.iconSurface
                      )}
                    >
                      <Icon className="h-[18px] w-[18px]" />
                    </span>

                    <div className="flex items-center gap-1.5">
                      {connected ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/[0.12] px-2 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-600 dark:text-emerald-300">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                          {t("hello.connected")}
                        </span>
                      ) : option.featured ? (
                        <span className="inline-flex items-center rounded-full border border-indigo-500/35 bg-indigo-500/15 px-2.5 py-0.5 text-[10px] font-semibold tracking-wide text-indigo-600 dark:text-indigo-300">
                          {t("hello.recommended")}
                        </span>
                      ) : null}

                      <LuArrowUpRight className="h-4 w-4 text-muted-foreground/50 transition-all duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground" />
                    </div>
                  </div>

                  {/* Body: Name + Description */}
                  <div className="relative mt-3">
                    <span className="block text-[14.5px] font-semibold tracking-tight text-foreground">
                      {option.id === "custom" ? t("hello.providers.custom") : option.name}
                    </span>
                    <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                      {t(`hello.providerDescriptions.${option.id}`)}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    );
  })();

  return (
    <div className="relative isolate flex min-h-[calc(100dvh-var(--app-header-height,0px))] w-full flex-col justify-center overflow-hidden px-4 pb-10 pt-20 text-foreground sm:px-6 sm:pb-12 sm:pt-24">
      {/* Ambient architectural backdrop matching NeuronRunner's visual language */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[640px] bg-[radial-gradient(ellipse_55%_44%_at_50%_-6%,rgba(99,102,241,0.16),transparent_70%),radial-gradient(ellipse_38%_30%_at_78%_14%,rgba(34,211,238,0.09),transparent_68%)]"
      />
      <div
        aria-hidden="true"
        className="landing-grid pointer-events-none absolute inset-x-0 top-0 -z-10 h-[520px] opacity-60 dark:opacity-85"
      />

      <div className="mx-auto w-full max-w-4xl">
        <header className={cn("text-center", step === "choose" ? "mb-7 sm:mb-8" : "mb-6 sm:mb-7")}>
          <span className="anim-fade-in-up inline-flex items-center gap-2 rounded-full border border-indigo-500/30 bg-indigo-500/[0.09] px-3.5 py-1 font-mono text-[11px] font-medium tracking-wide text-indigo-600 shadow-[0_0_24px_-8px_rgba(99,102,241,0.6)] backdrop-blur-sm dark:text-indigo-300">
            <LuSparkles className="h-3.5 w-3.5" />
            {hasCloudGitStep && step === "git" ? t("hello.git.stepBadge") : t("hello.badge")}
          </span>

          <h1
            className="anim-fade-in-up mt-3 text-balance bg-gradient-to-b from-foreground via-foreground to-foreground/75 bg-clip-text pb-0.5 text-3xl font-semibold tracking-[-0.035em] text-transparent sm:text-[2.75rem] sm:leading-[1.08]"
            style={{ animationDelay: "0.05s" }}
          >
            {hasCloudGitStep && step === "git" ? t("hello.git.title") : t("hello.title")}
          </h1>

          <p
            className="anim-fade-in-up mx-auto mt-2.5 max-w-2xl text-balance text-sm leading-relaxed text-muted-foreground sm:text-[15px] sm:leading-6"
            style={{ animationDelay: "0.1s" }}
          >
            {hasCloudGitStep && step === "git" ? t("hello.git.stepSubtitle") : t("hello.subtitle")}
          </p>

          {/* Two-step Cloud onboarding indicator: 1. Connect Git -> 2. Connect AI */}
          {hasCloudGitStep && (
            <div className="mt-5 flex items-center justify-center gap-2.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => setStep("git")}
                className={cn(
                  "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-all",
                  step === "git"
                    ? "border-indigo-500/45 bg-indigo-500/12 text-indigo-600 shadow-xs dark:text-indigo-300"
                    : gitConnected
                      ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-600 hover:border-emerald-500/55 dark:text-emerald-300"
                      : "border-border/75 bg-card/60 text-muted-foreground hover:text-foreground"
                )}
              >
                <span
                  className={cn(
                    "flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold",
                    gitConnected
                      ? "bg-emerald-500 text-white"
                      : step === "git"
                        ? "bg-indigo-500 text-white"
                        : "bg-muted text-muted-foreground"
                  )}
                >
                  {gitConnected ? <LuCheck className="h-3 w-3" /> : "1"}
                </span>
                <span>{t("hello.steps.git")}</span>
              </button>

              <span
                aria-hidden="true"
                className={cn("h-px w-8 transition-colors", gitConnected ? "bg-emerald-500/60" : "bg-border/80")}
              />

              <button
                type="button"
                disabled={!gitConnected || busy}
                onClick={() => setStep("choose")}
                className={cn(
                  "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-all disabled:cursor-not-allowed disabled:opacity-55",
                  step !== "git"
                    ? "border-indigo-500/45 bg-indigo-500/12 text-indigo-600 shadow-xs dark:text-indigo-300"
                    : "border-border/75 bg-card/60 text-muted-foreground"
                )}
              >
                <span
                  className={cn(
                    "flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold",
                    step !== "git" ? "bg-indigo-500 text-white" : "bg-muted text-muted-foreground"
                  )}
                >
                  2
                </span>
                <span>{t("hello.steps.ai")}</span>
              </button>
            </div>
          )}

          {/* Subtle progress indicator during multi-step API key onboarding */}
          {(step === "key" || step === "models") && (
            <div className="mt-4 flex items-center justify-center gap-2" aria-hidden="true">
              {[0, 1, 2].map((idx) => (
                <span
                  key={idx}
                  className={cn(
                    "h-1.5 rounded-full transition-all duration-300",
                    idx === activeStepIndex
                      ? "w-8 bg-indigo-500 shadow-[0_0_12px_rgba(99,102,241,0.6)]"
                      : idx < activeStepIndex
                        ? "w-4 bg-emerald-500/80"
                        : "w-4 bg-border/80"
                  )}
                />
              ))}
            </div>
          )}
        </header>

        <div className="anim-fade-in-up" style={{ animationDelay: "0.14s" }}>
          {body}
        </div>

        {step === "choose" && catalogReady && (
          <div className="mt-6 text-center">
            <Button
              variant="ghost"
              className="group rounded-xl border border-border/70 bg-card/50 px-5 text-sm font-medium backdrop-blur-sm hover:border-border hover:bg-card"
              onClick={() => void finish()}
            >
              {t("hello.continue")}
              <LuArrowRight className="ml-1.5 h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
            </Button>
          </div>
        )}
      </div>

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
    </div>
  );
}
