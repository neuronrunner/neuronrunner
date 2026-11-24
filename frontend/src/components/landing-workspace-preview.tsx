"use client";

import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { IconType } from "react-icons";
import {
  LuArrowLeft,
  LuArrowRight,
  LuArrowUp,
  LuArrowUpRight,
  LuBrain,
  LuBug,
  LuCheck,
  LuChevronDown,
  LuChevronRight,
  LuChevronUp,
  LuChevronsUpDown,
  LuCircleDot,
  LuCode,
  LuEllipsis,
  LuExpand,
  LuFileCode2,
  LuFolder,
  LuFolderCode,
  LuFolderOpen,
  LuGitBranch,
  LuGitPullRequest,
  LuGlobe,
  LuMessageSquare,
  LuMic,
  LuMonitor,
  LuPanelLeftClose,
  LuPanelLeftOpen,
  LuPanelRightClose,
  LuPaperclip,
  LuPlug,
  LuPlus,
  LuRefreshCw,
  LuRotateCw,
  LuServer,
  LuTerminal,
} from "react-icons/lu";
import { cn } from "@/lib/utils";
import { AntigravityBrandLogo, ClaudeBrandLogo, OpenAICodexBrandLogo } from "@/components/brand-logos";
import NeuronLogo from "@/components/neuron-logo";

type ToolId = "files" | "git" | "browser" | "desktop" | "terminal";

const TOOLS = [
  { id: "files", labelKey: "preview.tools.files", icon: LuFolderOpen },
  { id: "git", labelKey: "preview.tools.git", icon: LuGitBranch },
  { id: "browser", labelKey: "preview.tools.browser", icon: LuGlobe },
  { id: "desktop", labelKey: "preview.tools.desktop", icon: LuMonitor },
  { id: "terminal", labelKey: "preview.tools.terminal", icon: LuTerminal },
] as const satisfies readonly { id: ToolId; labelKey: string; icon: IconType }[];

const MONO = "font-mono";
const MUTED = "text-muted-foreground";

type PreviewAgentId = "neuron" | "claude" | "codex" | "antigravity";

const PREVIEW_AGENTS = [
  {
    id: "neuron",
    labelKey: "home.agentSelector.agents.neuron.name",
    descKey: "home.agentSelector.agents.neuron.desc",
    modelName: "Kimi K3.1 Pro",
    connected: true,
    modelCount: undefined as number | undefined,
    accentClasses:
      "border-foreground/15 bg-gradient-to-br from-foreground/[0.09] to-foreground/[0.03] text-foreground shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)]",
  },
  {
    id: "claude",
    labelKey: "home.agentSelector.agents.claude.name",
    descKey: "home.agentSelector.agents.claude.desc",
    modelName: "Claude Fable 5.2",
    connected: true,
    modelCount: 3 as number | undefined,
    accentClasses:
      "border-[#D97757]/30 bg-gradient-to-br from-[#D97757]/[0.16] to-[#D97757]/[0.05] text-[#D97757] shadow-[inset_0_1px_0_0_rgba(217,119,87,0.18)]",
  },
  {
    id: "codex",
    labelKey: "home.agentSelector.agents.codex.name",
    descKey: "home.agentSelector.agents.codex.desc",
    modelName: "GPT-6 Astra",
    connected: true,
    modelCount: 4 as number | undefined,
    accentClasses:
      "border-foreground/15 bg-gradient-to-br from-foreground/[0.09] to-foreground/[0.03] text-foreground shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)]",
  },
  {
    id: "antigravity",
    labelKey: "home.agentSelector.agents.antigravity.name",
    descKey: "home.agentSelector.agents.antigravity.desc",
    modelName: "Gemini 4 Hydrogen",
    connected: false,
    modelCount: undefined as number | undefined,
    accentClasses:
      "border-blue-500/25 bg-gradient-to-br from-blue-500/[0.14] via-indigo-500/[0.08] to-amber-500/[0.08] shadow-[inset_0_1px_0_0_rgba(96,165,250,0.18)]",
  },
] as const;

interface PreviewVmDef {
  id: string;
  name: string;
  status: "running" | "stopped";
  specs: string;
  cpuPercent: number;
  memPercent: number;
}

const PREVIEW_VMS: readonly PreviewVmDef[] = [
  {
    id: "lightning-atlas",
    name: "lightning-atlas",
    status: "running",
    specs: "4 vCPU · 12 GB · 32 GB",
    cpuPercent: 18,
    memPercent: 42,
  },
];

function PreviewAgentLogo({ id, size = 14 }: { id: PreviewAgentId; size?: number }) {
  if (id === "neuron") {
    return <NeuronLogo size={size} variant="symbol" className="text-foreground" />;
  }
  const cls = size <= 16 ? "h-3.5 w-3.5" : "h-[18px] w-[18px]";
  if (id === "claude") return <ClaudeBrandLogo className={cls} />;
  if (id === "codex") return <OpenAICodexBrandLogo className={cls} />;
  return <AntigravityBrandLogo className={cls} />;
}

function PreviewCloudAgentSelector({
  selectedAgentId,
  onSelectAgent,
  open,
  onToggle,
  onClose,
}: {
  selectedAgentId: PreviewAgentId;
  onSelectAgent: (id: PreviewAgentId) => void;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("landing");
  const containerRef = useRef<HTMLDivElement>(null);
  const activeDef = PREVIEW_AGENTS.find((a) => a.id === selectedAgentId) || PREVIEW_AGENTS[0];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={t("home.agentSelector.ariaLabel")}
        className="group inline-flex items-center gap-2 rounded-full border border-border/75 bg-card/65 py-1 pl-2.5 pr-2.5 font-mono text-[11px] text-muted-foreground shadow-sm backdrop-blur-md transition-all hover:border-foreground/25 hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
          <PreviewAgentLogo id={activeDef.id} size={14} />
          <span className="absolute -bottom-0.5 -right-0.5 flex h-1.5 w-1.5 rounded-full bg-emerald-500 ring-2 ring-background" />
        </span>
        <span className="max-w-[140px] truncate font-medium tracking-tight text-foreground/95">
          {t(activeDef.labelKey)}
        </span>
        <LuChevronDown
          className={cn(
            "h-3 w-3 shrink-0 opacity-60 transition-transform duration-200",
            open && "rotate-180"
          )}
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t("home.agentSelector.title")}
          className="absolute right-0 top-full z-40 mt-2 w-[336px] max-w-[calc(100vw-3rem)] overflow-hidden rounded-2xl border border-border/80 bg-popover/95 shadow-[0_24px_64px_-12px_rgba(0,0,0,0.55)] backdrop-blur-2xl"
        >
          <div className="flex items-center justify-between border-b border-border/60 bg-gradient-to-b from-muted/30 to-transparent px-3.5 py-2.5">
            <div>
              <p className="text-[12px] font-semibold tracking-tight text-foreground">
                {t("home.agentSelector.title")}
              </p>
              <p className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                <span className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.75)]" />
                <span>{t("home.status.vmAttached")}</span>
              </p>
            </div>
          </div>

          <div className="space-y-1 p-1.5">
            {PREVIEW_AGENTS.map((agent) => {
              const isSelected = agent.id === selectedAgentId;
              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => {
                    onSelectAgent(agent.id);
                    onClose();
                  }}
                  className={cn(
                    "group flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-all duration-150",
                    isSelected
                      ? "border-emerald-500/40 bg-gradient-to-r from-emerald-500/[0.09] via-emerald-500/[0.04] to-transparent shadow-[inset_0_1px_0_0_rgba(16,185,129,0.12)]"
                      : "border-transparent hover:border-border/70 hover:bg-muted/45"
                  )}
                >
                  <span
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition-transform duration-150 group-hover:scale-[1.03]",
                      agent.accentClasses
                    )}
                  >
                    <PreviewAgentLogo id={agent.id} size={18} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[12px] font-semibold leading-none tracking-tight text-foreground">
                        {t(agent.labelKey)}
                      </span>
                      {agent.modelCount && (
                        <span className="rounded-md border border-border/70 bg-muted/60 px-1.5 py-0.5 font-mono text-[9px] font-medium leading-none text-muted-foreground">
                          {agent.modelCount} models
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block truncate text-[10.5px] leading-snug text-muted-foreground/90">
                      {t(agent.descKey)}
                    </span>
                  </span>

                  {agent.connected ? (
                    isSelected ? (
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/15 text-emerald-500 dark:text-emerald-400">
                        <LuCheck className="h-3 w-3" />
                      </span>
                    ) : (
                      <span className="shrink-0 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 font-mono text-[9.5px] font-medium text-emerald-600 dark:text-emerald-400">
                        {agent.id === "neuron"
                          ? t("home.agentSelector.readyBadge")
                          : t("home.agentSelector.connectedBadge")}
                      </span>
                    )
                  ) : isSelected ? (
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/15 text-emerald-500 dark:text-emerald-400">
                      <LuCheck className="h-3 w-3" />
                    </span>
                  ) : (
                    <span className="shrink-0 rounded-full border border-border/80 bg-background/85 px-2 py-0.5 font-mono text-[9.5px] font-medium text-foreground/85 shadow-sm">
                      {t("home.agentSelector.oauthConnectBadge")}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function PreviewVmHeaderControl({
  selectedVmId,
  onSelectVm,
  open,
  onToggle,
  onClose,
  compact = false,
}: {
  selectedVmId: string;
  onSelectVm: (id: string) => void;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslation("landing");
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedVm = PREVIEW_VMS.find((v) => v.id === selectedVmId) || PREVIEW_VMS[0];
  const runningCount = PREVIEW_VMS.filter((v) => v.status === "running").length;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={selectedVm.name}
        className={cn(
          "inline-flex h-7 shrink-0 items-center gap-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          compact
            ? "rounded-md px-1.5 text-muted-foreground hover:bg-background/60 hover:text-foreground"
            : "rounded-lg border border-border/50 bg-background/80 px-2.5 text-foreground shadow-2xs backdrop-blur hover:bg-muted/70"
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "h-2 w-2 rounded-full",
            selectedVm.status === "running"
              ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.7)] animate-pulse"
              : "bg-muted-foreground/40"
          )}
        />
        <LuServer className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {!compact && (
          <span className={cn(MONO, "max-w-[120px] truncate text-[10.5px] font-medium text-foreground")}>
            {selectedVm.name}
          </span>
        )}
        <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.2 font-mono text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
          {runningCount}
        </span>
        {!compact && (
          <LuChevronDown
            className={cn(
              "h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-200",
              open && "rotate-180"
            )}
          />
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t("preview.vmDropdown.machines")}
          className="absolute right-0 top-full z-40 mt-2 w-[310px] max-w-[calc(100vw-2.5rem)] overflow-hidden rounded-2xl border border-border/70 bg-popover/95 shadow-[0_24px_64px_-12px_rgba(0,0,0,0.5)] backdrop-blur-2xl"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/20 px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background text-foreground">
                <LuServer className="h-3 w-3" />
              </span>
              <span className="text-[12px] font-semibold tracking-tight text-foreground">
                {t("preview.vmDropdown.machines")}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {t("preview.vmDropdown.activeCount", { count: runningCount })}
              </span>
            </div>
          </div>

          <div className="divide-y divide-border/50">
            {PREVIEW_VMS.map((vm) => {
              const isSelected = vm.id === selectedVmId;
              const isRunning = vm.status === "running";
              return (
                <button
                  key={vm.id}
                  type="button"
                  onClick={() => {
                    onSelectVm(vm.id);
                    onClose();
                  }}
                  className={cn(
                    "flex w-full flex-col gap-2 px-3.5 py-3 text-left transition-colors",
                    isSelected ? "bg-muted/35" : "hover:bg-muted/20"
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className={cn(MONO, "truncate text-[11.5px] font-semibold text-foreground")}>
                        {vm.name}
                      </span>
                      <span
                        className={cn(
                          "inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.2 text-[9.5px] font-medium capitalize",
                          isRunning
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                            : "border-border/70 bg-muted text-muted-foreground"
                        )}
                      >
                        {t(`preview.vmDropdown.${vm.status}`)}
                      </span>
                    </div>
                    {isSelected && (
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/15 text-emerald-500 dark:text-emerald-400">
                        <LuCheck className="h-3 w-3" />
                      </span>
                    )}
                  </div>

                  <div className={cn(MONO, "text-[10px] text-muted-foreground")}>
                    {vm.specs}
                  </div>

                  {isRunning && (
                    <div className="grid grid-cols-2 gap-2 pt-0.5">
                      <div>
                        <div className="mb-1 flex justify-between font-mono text-[9px] text-muted-foreground">
                          <span>{t("preview.vmDropdown.cpu")}</span>
                          <span>{vm.cpuPercent}%</span>
                        </div>
                        <div className="h-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-emerald-500"
                            style={{ width: `${vm.cpuPercent}%` }}
                          />
                        </div>
                      </div>
                      <div>
                        <div className="mb-1 flex justify-between font-mono text-[9px] text-muted-foreground">
                          <span>{t("preview.vmDropdown.ram")}</span>
                          <span>{vm.memPercent}%</span>
                        </div>
                        <div className="h-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-indigo-500"
                            style={{ width: `${vm.memPercent}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sidebar                                                             */
/* ------------------------------------------------------------------ */

function SidebarItem({
  icon: Icon,
  label,
  active,
}: {
  icon: IconType;
  label: string;
  active?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-7 items-center gap-2.5 rounded-lg px-2.5 text-[11px] font-medium",
        active ? "bg-muted text-foreground" : "text-foreground/85"
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
    </div>
  );
}

function PreviewSidebar({ selectedVmName }: { selectedVmName: string }) {
  const { t } = useTranslation("landing");
  const historyItems = t("preview.sidebar.historyItems", { returnObjects: true }) as string[];

  return (
    <aside className="hidden w-[252px] shrink-0 flex-col border-r border-border/50 bg-background md:flex lg:w-[268px]">
      {/* Sidebar Header */}
      <div className="flex h-11 items-center justify-between border-b border-border/40 px-3">
        <div className="flex items-center gap-2 min-w-0">
          <NeuronLogo size={20} className="text-foreground shrink-0" />
          <div className={cn(MONO, "truncate text-[12px] tracking-tight text-foreground")}>
            <span className="font-bold">Neuron</span>{" "}
            <span className="font-light text-muted-foreground">Runner</span>
          </div>
        </div>
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground">
          <LuPanelLeftClose className="h-3.5 w-3.5" />
        </span>
      </div>

      {/* Primary Nav */}
      <div className="flex flex-col gap-0.5 p-2">
        <div className="mb-1 flex h-8 items-center gap-2 rounded-lg border border-border/60 bg-muted/60 px-2.5 text-[11px] font-medium text-foreground">
          <LuPlus className="h-3.5 w-3.5 text-muted-foreground" />
          {t("preview.sidebar.newChat")}
        </div>
        <SidebarItem icon={LuCircleDot} label={t("preview.sidebar.issues")} />
        <SidebarItem icon={LuGitPullRequest} label={t("preview.sidebar.pullRequests")} />
        <SidebarItem icon={LuPlug} label={t("preview.sidebar.integrations")} />
      </div>

      <div className="mx-2 my-1 h-px bg-border/50" />

      {/* Projects & History */}
      <div className="min-h-0 flex-1 overflow-hidden px-2 py-1.5">
        <div className="flex items-center justify-between px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
          <span>{t("preview.sidebar.projectsHeading", { count: 1 })}</span>
          <LuPlus className="h-3 w-3" />
        </div>
        <div className="mt-0.5 space-y-1">
          <div className="flex h-7 items-center gap-1.5 rounded-lg px-1.5 text-[11px] font-medium text-foreground">
            <LuChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            <LuFolderCode className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-semibold">neuronrunner</span>
            <span className="inline-flex shrink-0 items-center gap-1 rounded border border-border/60 bg-muted/60 px-1.5 py-0.5 font-mono text-[8.5px] font-normal text-muted-foreground">
              <LuServer className="h-2.5 w-2.5 shrink-0" />
              {selectedVmName}
            </span>
          </div>
          <div className="pl-6 text-[10px] text-muted-foreground/60">{t("preview.sidebar.noConversations")}</div>
        </div>

        <div className="mt-4 px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("preview.sidebar.historyHeading", { count: 20 })}
        </div>
        <div className="mt-0.5 space-y-0.5">
          {historyItems.map((title, idx) => (
            <div
              key={idx}
              className="truncate rounded-md px-2 py-1.5 text-[11px] text-foreground/85"
            >
              {title}
            </div>
          ))}
        </div>
      </div>

      {/* User / Workspace Footer */}
      <div className="p-2">
        <div className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-card/50 px-2.5 py-2">
          <div className="relative shrink-0">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-foreground">
              KK
            </span>
            <span className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-indigo-600 text-[7px] font-bold text-white ring-2 ring-background">
              KW
            </span>
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[11px] font-semibold text-foreground">Kaan Kutan</div>
            <div className="truncate text-[9px] text-muted-foreground">
              {t("preview.sidebar.workspaceSummary", { owner: "developer", balance: "Docker" })}
            </div>
          </div>
          <LuChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </div>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* Center Workspace (New Conversation + Cloud Agent Composer)          */
/* ------------------------------------------------------------------ */

const PREVIEW_SUGGESTION_ICONS: IconType[] = [
  LuCode,
  LuTerminal,
  LuCode,
  LuBug,
  LuBug,
];

function PreviewChat({
  selectedVmId,
  onSelectVm,
}: {
  selectedVmId: string;
  onSelectVm: (id: string) => void;
}) {
  const { t } = useTranslation("landing");
  const [selectedAgentId, setSelectedAgentId] = useState<PreviewAgentId>("neuron");
  const [openMenu, setOpenMenu] = useState<"vm" | "agent" | null>(null);
  const activeAgent = PREVIEW_AGENTS.find((a) => a.id === selectedAgentId) || PREVIEW_AGENTS[0];
  const suggestions = t("preview.chat.suggestions", { returnObjects: true }) as {
    label: string;
    prompt: string;
  }[];

  return (
    <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Subtle center ambient glow matching the real app */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,rgba(99,102,241,0.14),transparent_58%)]"
      />

      {/* Top Header */}
      <header className="relative z-30 flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border/40 px-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-indigo-500/25 bg-indigo-500/10 text-indigo-500 dark:text-indigo-400">
            <LuMessageSquare className="h-3.5 w-3.5" />
          </span>
          <span className="truncate text-[12px] font-semibold tracking-[-0.01em] text-foreground">
            {t("preview.chat.newConversation")}
          </span>
        </div>

        {/* Clickable VM Header Control Dropdown */}
        <PreviewVmHeaderControl
          selectedVmId={selectedVmId}
          onSelectVm={onSelectVm}
          open={openMenu === "vm"}
          onToggle={() => setOpenMenu((prev) => (prev === "vm" ? null : "vm"))}
          onClose={() => setOpenMenu((prev) => (prev === "vm" ? null : prev))}
        />
      </header>

      {/* Center Composer & Suggestions */}
      <div className="relative z-10 mx-auto flex w-full max-w-[540px] flex-1 flex-col justify-center gap-2.5 px-4 py-4">
        {/* Project & Branch Bar + Clickable Cloud Agent Selector */}
        <div className="relative z-20 flex items-center justify-between gap-2 px-0.5">
          <div className="flex items-center gap-2 text-[11px] font-medium text-foreground">
            <span className="inline-flex items-center gap-1.5">
              <LuFolderCode className="h-3.5 w-3.5 text-muted-foreground" />
              neuronrunner
              <LuChevronDown className="h-3 w-3 text-muted-foreground" />
            </span>
            <span className="h-3.5 w-px bg-border/60" />
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <LuGitBranch className="h-3 w-3" />
              <span className={cn(MONO, "text-[10px] text-foreground/90")}>main</span>
              <LuChevronDown className="h-3 w-3" />
            </span>
          </div>

          <PreviewCloudAgentSelector
            selectedAgentId={selectedAgentId}
            onSelectAgent={setSelectedAgentId}
            open={openMenu === "agent"}
            onToggle={() => setOpenMenu((prev) => (prev === "agent" ? null : "agent"))}
            onClose={() => setOpenMenu((prev) => (prev === "agent" ? null : prev))}
          />
        </div>

        {/* Prompt Input Box */}
        <div className="rounded-2xl border border-border/80 bg-card/60 p-3 shadow-lg backdrop-blur">
          <div className="pb-4 text-[11px] text-muted-foreground">
            {t("preview.chat.promptPlaceholder")}
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg text-muted-foreground">
                <LuPaperclip className="h-3.5 w-3.5" />
              </span>
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-foreground/90">
                {activeAgent.modelName}
                <span className="text-muted-foreground">{t("preview.chat.reasoningLevel")}</span>
                <LuChevronUp className="h-3 w-3 text-muted-foreground" />
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground">
                <LuMic className="h-3.5 w-3.5" />
              </span>
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <LuArrowUp className="h-3.5 w-3.5" />
              </span>
            </div>
          </div>
        </div>

        {/* Prompt Suggestions */}
        <div className="flex flex-col gap-1.5">
          {suggestions.map((item, idx) => {
            const ItemIcon = PREVIEW_SUGGESTION_ICONS[idx % PREVIEW_SUGGESTION_ICONS.length];
            return (
              <div
                key={idx}
                className="flex items-center justify-between gap-2.5 rounded-xl border border-border/70 bg-card/40 px-3 py-2 text-[10px] text-muted-foreground backdrop-blur"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <ItemIcon className="h-3.5 w-3.5 shrink-0 text-indigo-500 dark:text-indigo-400" />
                  <span className="shrink-0 font-medium text-foreground">{item.label}</span>
                  <span className="shrink-0 text-muted-foreground/50">—</span>
                  <span className="truncate text-muted-foreground/80">{item.prompt}</span>
                </div>
                <LuArrowUpRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Right panel views                                                   */
/* ------------------------------------------------------------------ */

function TerminalView() {
  const { t } = useTranslation("landing");
  return (
    <div className="flex h-full flex-col bg-background">
      {/* Terminal Sub-toolbar matching TerminalTabView.tsx */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border/40 bg-muted/15 px-2.5">
        <div className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/70 px-2.5 py-1 font-mono text-[10px] text-foreground">
          <LuTerminal className="h-3 w-3 text-muted-foreground" />
          <span>{t("preview.terminal.tabTitle", { number: 2 })}</span>
          <LuChevronDown className="h-3 w-3 text-muted-foreground" />
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <span className="flex h-5 w-4 items-center justify-center">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          </span>
          <LuPlus className="h-3.5 w-3.5" />
          <LuEllipsis className="h-3.5 w-3.5" />
        </div>
      </div>

      {/* Terminal Viewport */}
      <div className={cn(MONO, "flex-1 overflow-hidden bg-[#050508] p-3 text-[10.5px] leading-[1.65] text-zinc-300")}>
        <div>
          <span className="text-emerald-400">root@neuronrunner</span>
          <span className="text-zinc-400">:</span>
          <span className="text-cyan-400">/workspace/neuronrunner</span>
          <span className="text-zinc-200"># </span>
          <span className="text-white">npm run test</span>
        </div>
        <div className="mt-1 text-zinc-400">
          <span className="rounded bg-emerald-500/20 px-1 py-0.5 text-[9px] font-semibold text-emerald-400">{t("preview.terminal.passBadge")}</span>{" "}
          tests/execution-lifecycle.test.cjs
        </div>
        <div className="text-zinc-400">
          <span className="rounded bg-emerald-500/20 px-1 py-0.5 text-[9px] font-semibold text-emerald-400">{t("preview.terminal.passBadge")}</span>{" "}
          tests/sandbox-projects-selection.test.cjs
        </div>
        <div className="text-emerald-400">{t("preview.terminal.testsPassed")}</div>

        <div className="mt-2">
          <span className="text-emerald-400">root@neuronrunner</span>
          <span className="text-zinc-400">:</span>
          <span className="text-cyan-400">/workspace/neuronrunner</span>
          <span className="text-zinc-200"># </span>
          <span className="text-white">npm run dev</span>
        </div>
        <div className="mt-0.5 text-emerald-400">
          &nbsp;&nbsp;VITE v8.3.4 <span className="text-zinc-400">ready in</span> <span className="text-white">312 ms</span>
        </div>
        <div className="text-zinc-300">
          &nbsp;&nbsp;<span className="text-emerald-400">➜</span>&nbsp;&nbsp;<span className="font-semibold text-white">Local:</span>&nbsp;&nbsp;&nbsp;
          <span className="text-cyan-400 underline">http://localhost:5173/</span>
        </div>
        <div className="text-zinc-400">
          &nbsp;&nbsp;<span className="text-emerald-400/70">➜</span>&nbsp;&nbsp;Network: http://10.0.4.12:5173/
        </div>

        <div className="mt-2 flex items-center flex-wrap">
          <span className="text-emerald-400">root@neuronrunner</span>
          <span className="text-zinc-400">:</span>
          <span className="text-cyan-400">/workspace/neuronrunner</span>
          <span className="text-zinc-200"># </span>
          <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-zinc-200" />
        </div>
      </div>
    </div>
  );
}

function TreeRow({
  depth = 0,
  icon: Icon,
  label,
  active,
  open,
  folder,
}: {
  depth?: number;
  icon?: IconType;
  label: string;
  active?: boolean;
  open?: boolean;
  folder?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-6 items-center gap-1.5 rounded px-1.5 text-[11px]",
        active ? "bg-indigo-500/10 text-indigo-600 dark:text-indigo-300" : "text-muted-foreground"
      )}
      style={{ paddingLeft: 6 + depth * 14 }}
    >
      {folder ? (
        open ? <LuChevronDown className="h-3 w-3 shrink-0" /> : <LuChevronRight className="h-3 w-3 shrink-0" />
      ) : (
        <span className="w-3 shrink-0" />
      )}
      {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" /> : null}
      <span className={cn(MONO, "truncate")}>{label}</span>
    </div>
  );
}

function FilesView() {
  return (
    <div className="h-full overflow-hidden bg-background p-2">
      <TreeRow folder open icon={LuFolderOpen} label="neuronrunner" />
      <TreeRow folder open depth={1} icon={LuFolder} label="src" />
      <TreeRow folder open depth={2} icon={LuFolder} label="app" />
      <TreeRow depth={3} icon={LuFileCode2} label="page.tsx" active />
      <TreeRow depth={3} icon={LuFileCode2} label="globals.css" />
      <TreeRow folder depth={2} icon={LuFolder} label="components" />
      <TreeRow folder open depth={2} icon={LuFolder} label="lib" />
      <TreeRow depth={3} icon={LuFileCode2} label="analytics.ts" />
      <TreeRow depth={1} icon={LuFileCode2} label="package.json" />
      <TreeRow depth={1} icon={LuFileCode2} label="vite.config.ts" />
    </div>
  );
}

function GitView() {
  const { t } = useTranslation("landing");
  const changes = [
    { file: "src/app/page.tsx", s: "M" },
    { file: "src/lib/analytics.ts", s: "A" },
    { file: "src/components/chart.tsx", s: "A" },
  ];
  return (
    <div className="h-full overflow-hidden bg-background p-3 text-[11px]">
      <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2">
        <LuGitBranch className="h-3.5 w-3.5 text-indigo-500 dark:text-indigo-400" />
        <span className={cn(MONO, "text-foreground")}>feat/launch-page</span>
        <span className="ml-auto text-[10px] text-muted-foreground">{t("preview.git.changesCount", { count: 3 })}</span>
      </div>
      <div className="mt-3 px-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{t("preview.git.changesHeading")}</div>
      <div className="mt-1 space-y-0.5">
        {changes.map((c) => (
          <div key={c.file} className="flex items-center gap-2 rounded px-1.5 py-1">
            <span
              className={cn(
                MONO,
                "w-3 text-center text-[10px] font-semibold",
                c.s === "A" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"
              )}
            >
              {c.s}
            </span>
            <span className={cn(MONO, "truncate text-[10px] text-foreground")}>{c.file}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 rounded-lg border border-border/60 bg-background px-2.5 py-2 text-[10px] text-muted-foreground">
        {t("preview.git.commitMessage")}
      </div>
      <div className="mt-2 flex h-7 items-center justify-center rounded-md bg-foreground text-[11px] font-medium text-background">{t("preview.git.commitButton")}</div>
    </div>
  );
}

function BrowserView() {
  const { t } = useTranslation("landing");
  const bars = [38, 52, 44, 66, 58, 80, 72, 94];
  const metrics = [
    { key: "visitors", label: t("preview.browser.visitors"), value: "12.4k" },
    { key: "signups", label: t("preview.browser.signups"), value: "842" },
    { key: "conversion", label: t("preview.browser.conversion"), value: "6.8%" },
  ];
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/50 px-2">
        <LuArrowLeft className="h-3.5 w-3.5 text-muted-foreground" />
        <LuArrowRight className="h-3.5 w-3.5 text-muted-foreground/50" />
        <LuRotateCw className="h-3 w-3 text-muted-foreground" />
        <div className="ml-1 flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border/60 bg-background px-2">
          <LuGlobe className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className={cn(MONO, "truncate text-[10px] text-muted-foreground")}>localhost:3000</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden bg-gradient-to-b from-indigo-500/[0.06] to-transparent p-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-foreground">{t("preview.browser.dashboardTitle")}</span>
          <span className="flex items-center gap-1 text-[9px] text-emerald-600 dark:text-emerald-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
            {t("preview.browser.live")}
          </span>
        </div>

        <div className="mt-2 grid grid-cols-3 gap-1.5">
          {metrics.map((m) => (
            <div key={m.key} className="rounded-lg border border-border/60 bg-card/70 px-2 py-1.5">
              <div className="text-[9px] text-muted-foreground">{m.label}</div>
              <div className="text-[13px] font-semibold tracking-tight text-foreground">{m.value}</div>
            </div>
          ))}
        </div>

        <div className="mt-2 rounded-lg border border-border/60 bg-card/70 p-2">
          <div className="mb-1.5 text-[9px] text-muted-foreground">{t("preview.browser.chartTitle")}</div>
          <div className="flex h-16 items-end gap-1.5">
            {bars.map((h, i) => (
              <div
                key={i}
                className="flex-1 rounded-t bg-gradient-to-t from-indigo-500/60 to-violet-400/80"
                style={{ height: `${h}%` }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function DesktopView() {
  const { t } = useTranslation("landing");
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/50 px-2.5">
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <span className={cn(MONO, "text-[10px] text-muted-foreground")}>VNC · :5901 · 1280×800</span>
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <LuRefreshCw className="h-3 w-3" />
          <LuExpand className="h-3 w-3" />
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col justify-between overflow-hidden bg-gradient-to-br from-indigo-950/40 via-slate-900/60 to-violet-950/40 p-2.5">
        <div className="rounded-lg border border-white/15 bg-[#0c0d14]/95 shadow-lg">
          <div className="flex h-5 items-center justify-between border-b border-white/10 px-2">
            <div className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-red-400/80" />
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400/80" />
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/80" />
            </div>
            <span className={cn(MONO, "text-[9px] text-zinc-400")}>{t("preview.desktop.windowTitle")}</span>
            <span className="w-4" />
          </div>
          <div className="space-y-1.5 p-2.5 text-[10px] text-zinc-300">
            <div className="flex items-center justify-between">
              <span className="font-medium text-white">{t("preview.desktop.checkTitle")}</span>
              <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 font-mono text-[9px] text-emerald-300">{t("preview.desktop.checksPassed")}</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 pt-1">
              <div className="rounded border border-white/10 bg-white/5 px-2 py-1 font-mono text-[9px] text-zinc-400">
                {t("preview.desktop.checkCanvas")}
              </div>
              <div className="rounded border border-white/10 bg-white/5 px-2 py-1 font-mono text-[9px] text-zinc-400">
                {t("preview.desktop.checkResponsive")}
              </div>
            </div>
          </div>
        </div>

        <div className="mx-auto flex items-center gap-1.5 rounded-full border border-white/10 bg-black/50 px-2.5 py-1 backdrop-blur">
          <LuTerminal className="h-3 w-3 text-indigo-300" />
          <LuGlobe className="h-3 w-3 text-cyan-300" />
          <LuFolder className="h-3 w-3 text-amber-300" />
          <span className={cn(MONO, "ml-1 text-[9px] text-zinc-400")}>{t("preview.desktop.linuxGui")}</span>
        </div>
      </div>
    </div>
  );
}

function PreviewRightPanel() {
  const { t } = useTranslation("landing");
  const [tool, setTool] = useState<ToolId>("terminal");
  const active = TOOLS.find((item) => item.id === tool)!;
  const ActiveIcon = active.icon;

  return (
    <div className="flex h-[240px] min-w-0 shrink-0 flex-col border-t border-border/50 sm:h-auto sm:w-[32%] sm:border-l sm:border-t-0">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/40 bg-background/80 px-2.5">
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground">
          <LuPanelRightClose className="h-4 w-4" />
        </span>
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40 text-muted-foreground">
          <ActiveIcon className="h-3 w-3" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold tracking-[-0.01em] text-foreground">{t(active.labelKey)}</span>
        <div role="group" aria-label={t("preview.toolsGroupAriaLabel")} className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border/50 bg-muted/30 p-0.5">
          {TOOLS.map(({ id, labelKey, icon: Icon }) => {
            const label = t(labelKey);
            return (
              <button
                key={id}
                type="button"
                title={label}
                aria-label={label}
                aria-pressed={tool === id}
                onClick={() => setTool(id)}
                className={cn(
                  "inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  tool === id && "bg-background text-foreground shadow-sm"
                )}
              >
                <Icon className="h-3 w-3" />
              </button>
            );
          })}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {tool === "terminal" && <TerminalView />}
        {tool === "files" && <FilesView />}
        {tool === "git" && <GitView />}
        {tool === "browser" && <BrowserView />}
        {tool === "desktop" && <DesktopView />}
      </div>
    </div>
  );
}

const MOBILE_STEP_META: { icon: IconType; duration: string }[] = [
  { icon: LuFileCode2, duration: "0.8s" },
  { icon: LuTerminal, duration: "1.4s" },
  { icon: LuMonitor, duration: "1.1s" },
  { icon: LuGitPullRequest, duration: "0.5s" },
];

function PreviewMobileWorkspace({
  selectedVmId,
  onSelectVm,
}: {
  selectedVmId: string;
  onSelectVm: (id: string) => void;
}) {
  const { t } = useTranslation("landing");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [vmMenuOpen, setVmMenuOpen] = useState(false);
  const [tool, setTool] = useState<ToolId>("terminal");
  const active = TOOLS.find((item) => item.id === tool)!;
  const ActiveIcon = active.icon;
  const mobileSteps = t("preview.mobile.steps", { returnObjects: true }) as {
    title: string;
    detail: string;
  }[];

  return (
    <div className="relative flex h-[540px] w-full flex-col overflow-hidden bg-background sm:hidden">
      {/* Top Mobile Workspace Header (matching WorkspacePageHeader + WorkspaceHeaderToolbar) */}
      <header className="relative z-20 flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border/40 bg-background/80 px-3 backdrop-blur-xl">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <span
            aria-hidden="true"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground"
          >
            <LuPanelLeftOpen className="h-4 w-4" />
          </span>
          <span className="truncate px-1 text-[13px] font-semibold tracking-[-0.01em] text-foreground">
            {t("preview.mobile.title")}
          </span>
          <span
            aria-hidden="true"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-muted-foreground/70"
          >
            <LuEllipsis className="h-3.5 w-3.5" />
          </span>
        </div>

        {/* Right Toolbar Pill: Clickable VM status + Tools trigger */}
        <div className="flex shrink-0 items-center rounded-lg border border-border/40 bg-muted/40 p-0.5 shadow-2xs">
          <PreviewVmHeaderControl
            compact
            selectedVmId={selectedVmId}
            onSelectVm={onSelectVm}
            open={vmMenuOpen}
            onToggle={() => setVmMenuOpen((prev) => !prev)}
            onClose={() => setVmMenuOpen(false)}
          />

          <div className="mx-1 h-3.5 w-px bg-border/60" />

          <button
            type="button"
            aria-label={t("preview.toolsGroupAriaLabel")}
            aria-expanded={toolsOpen}
            onClick={() => setToolsOpen(true)}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
          >
            <LuFolderCode className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
            <span className="text-[11px] font-medium">{t("preview.mobile.toolsButton")}</span>
          </button>
        </div>
      </header>

      {/* Conversation Body */}
      <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-y-auto px-3.5 pt-4 pb-3">
        {/* User Prompt Bubble (right aligned) */}
        <div className="ml-auto max-w-[82%] rounded-2xl border border-zinc-500/20 bg-zinc-500/15 px-3.5 py-2.5 text-[13px] leading-relaxed text-foreground shadow-sm">
          {t("preview.mobile.userPrompt")}
        </div>

        {/* ExecutionBlock: Response details bar */}
        <div className="mt-3.5 mb-2.5 min-w-0">
          <button
            type="button"
            onClick={() => setDetailsOpen((prev) => !prev)}
            aria-expanded={detailsOpen}
            aria-label={detailsOpen ? t("preview.mobile.hideResponseDetails") : t("preview.mobile.showResponseDetails")}
            className="group flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-left transition-colors hover:bg-muted/40"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/60 text-muted-foreground">
              <LuBrain className="h-3.5 w-3.5" />
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 text-xs font-medium text-foreground">{t("preview.mobile.responseDetails")}</span>
              <span className="min-w-0 truncate text-[11px] text-muted-foreground">{t("preview.mobile.stepsCount", { count: 4 })}</span>
            </span>
            <LuChevronDown
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
                detailsOpen && "rotate-180"
              )}
            />
          </button>

          {detailsOpen && (
            <div className="ml-3 mt-2 space-y-2.5 border-l border-border/50 py-1 pl-3">
              {mobileSteps.map((step, idx) => {
                const meta = MOBILE_STEP_META[idx % MOBILE_STEP_META.length];
                const StepIcon = meta.icon;
                return (
                  <div key={idx} className="flex items-start gap-2.5">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border/70 bg-card text-muted-foreground">
                      <StepIcon className="h-3 w-3" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
                        <span className="truncate">{step.title}</span>
                        <span className={cn(MONO, "shrink-0 text-[9.5px] font-normal text-muted-foreground/70")}>
                          · {meta.duration}
                        </span>
                      </div>
                      <p className={cn(MONO, "truncate text-[10px] text-muted-foreground/80")}>
                        {step.detail}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Assistant Response Text */}
        <div className="space-y-2.5 pl-0.5 text-[13px] leading-relaxed text-foreground/95">
          <p>
            <Trans
              t={t}
              i18nKey="preview.mobile.assistantSummary1"
              components={{
                branch: <span className={cn(MONO, "rounded bg-muted/70 px-1 py-0.5 text-[11.5px] text-foreground")} />,
                passed: <span className="font-medium text-emerald-600 dark:text-emerald-400" />,
                vm: <span className={cn(MONO, "text-[12px] text-foreground")} />,
              }}
            />
          </p>
          <p>
            <Trans
              t={t}
              i18nKey="preview.mobile.assistantSummary2"
              components={{
                pr: <span className="font-medium text-indigo-500 dark:text-indigo-400" />,
              }}
            />
          </p>
        </div>
      </div>

      {/* Bottom Prompt Input Composer (matching mobile PromptInput) */}
      <div className="relative z-20 mt-auto px-3 pb-3 pt-2">
        <div className="rounded-2xl border border-black/[0.06] bg-card p-2.5 shadow-[0_4px_24px_-4px_rgba(0,0,0,0.06)] backdrop-blur-2xl dark:border-white/[0.07] dark:bg-[#0c0d14]/95 dark:shadow-[0_10px_35px_-8px_rgba(0,0,0,0.65)]">
          <div className="px-1.5 pt-1 pb-3.5 text-[13px] text-muted-foreground/60">
            {t("preview.mobile.askPlaceholder")}
          </div>
          <div className="flex items-center justify-between gap-1.5 px-1 pt-0.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground">
                <LuPaperclip className="h-4 w-4" />
              </span>
              <span className="inline-flex min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-[12px] text-muted-foreground">
                <span className="truncate font-normal text-foreground/85">Kimi K3.1 Pro</span>
                <span className="shrink-0 text-muted-foreground/75">{t("preview.chat.reasoningLevel")}</span>
                <LuChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground">
                <LuMic className="h-4 w-4" />
              </span>
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-muted text-muted-foreground/45">
                <LuArrowUp className="h-3.5 w-3.5 stroke-[2.5]" />
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Slide-over Workspace Tools Drawer on Mobile (when Tools is tapped) */}
      {toolsOpen && (
        <div className="absolute inset-0 z-30 flex flex-col bg-background animate-in fade-in-0 duration-150">
          <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/40 bg-background/90 px-3 backdrop-blur-xl">
            <button
              type="button"
              aria-label={t("preview.mobile.closeToolsAriaLabel")}
              onClick={() => setToolsOpen(false)}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <LuPanelRightClose className="h-4 w-4" />
            </button>
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40 text-muted-foreground">
              <ActiveIcon className="h-3 w-3" />
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] font-semibold tracking-[-0.01em] text-foreground">
              {t(active.labelKey)}
            </span>
            <div
              role="group"
              aria-label={t("preview.mobileToolsGroupAriaLabel")}
              className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border/50 bg-muted/30 p-0.5"
            >
              {TOOLS.map(({ id, labelKey, icon: Icon }) => {
                const label = t(labelKey);
                return (
                  <button
                    key={id}
                    type="button"
                    title={label}
                    aria-label={label}
                    aria-pressed={tool === id}
                    onClick={() => setTool(id)}
                    className={cn(
                      "inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground",
                      tool === id && "bg-background text-foreground shadow-sm"
                    )}
                  >
                    <Icon className="h-3 w-3" />
                  </button>
                );
              })}
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-hidden">
            {tool === "terminal" && <TerminalView />}
            {tool === "files" && <FilesView />}
            {tool === "git" && <GitView />}
            {tool === "browser" && <BrowserView />}
            {tool === "desktop" && <DesktopView />}
          </div>

          <div className="flex items-center justify-between border-t border-border/50 bg-muted/20 px-3 py-2 font-mono text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              {t("preview.mobile.vmFooterSpec")}
            </span>
            <button
              type="button"
              onClick={() => setToolsOpen(false)}
              className="inline-flex items-center gap-1 font-sans text-[11px] font-medium text-indigo-500 dark:text-indigo-400"
            >
              <LuCheck className="h-3 w-3" />
              {t("preview.mobile.backToChat")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Root                                                                */
/* ------------------------------------------------------------------ */

export default function LandingWorkspacePreview() {
  const { t } = useTranslation("landing");
  const [selectedVmId, setSelectedVmId] = useState<string>(PREVIEW_VMS[0].id);
  const selectedVm = PREVIEW_VMS.find((v) => v.id === selectedVmId) || PREVIEW_VMS[0];

  return (
    <div
      className="landing-workspace relative mx-auto w-full max-w-[390px] overflow-hidden rounded-[1.5rem] border border-border/70 bg-background/95 text-left backdrop-blur sm:max-w-none"
      aria-label={t("preview.rootAriaLabel")}
    >
      {/* Mobile preview (< 640px): matches mobile workspace UI while preserving landing context */}
      <PreviewMobileWorkspace selectedVmId={selectedVmId} onSelectVm={setSelectedVmId} />

      {/* Desktop preview (>= 640px): untouched 3-column workspace */}
      <div className="hidden sm:flex sm:h-[520px] sm:flex-row">
        <PreviewSidebar selectedVmName={selectedVm.name} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-row">
            <PreviewChat selectedVmId={selectedVmId} onSelectVm={setSelectedVmId} />
            <PreviewRightPanel />
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(115deg,transparent_55%,rgba(99,102,241,0.04))]" />
    </div>
  );
}
