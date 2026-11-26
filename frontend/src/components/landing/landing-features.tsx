"use client";

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { IconType } from "react-icons";
import {
  LuBrain,
  LuGitBranch,
  LuGitPullRequest,
  LuKeyRound,
  LuMonitor,
  LuPlug,
  LuServer,
  LuSparkles,
  LuTerminal,
  LuUsers,
  LuZap,
} from "react-icons/lu";
import { AntigravityBrandLogo, ClaudeBrandLogo, OpenAICodexBrandLogo } from "@/components/brand-logos";
import { connectableConnectors } from "@/lib/connectors";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Shared                                                              */
/* ------------------------------------------------------------------ */

function FeatureCard({
  icon: Icon,
  eyebrow,
  title,
  description,
  points,
  visual,
  className,
  featured = false,
}: {
  icon: IconType;
  eyebrow: string;
  title: string;
  description: string;
  points?: string[];
  visual: ReactNode;
  className?: string;
  featured?: boolean;
}) {
  return (
    <article
      className={cn(
        "landing-card group relative flex flex-col overflow-hidden rounded-3xl border shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl transition-all duration-300",
        featured
          ? "border-indigo-500/50 bg-gradient-to-b from-indigo-500/[0.09] via-card/95 to-card/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_20px_50px_-24px_rgba(99,102,241,0.35)] ring-1 ring-indigo-500/20 hover:border-indigo-400/75"
          : "border-border/75 bg-gradient-to-b from-card/90 to-card/60 hover:border-indigo-500/35 hover:shadow-xl hover:shadow-black/15 dark:hover:shadow-black/45",
        className
      )}
    >
      {featured && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-10 top-0 z-10 h-px bg-gradient-to-r from-transparent via-indigo-400 to-transparent"
        />
      )}
      <div
        className={cn(
          "relative min-h-[200px] flex-1 overflow-hidden border-b border-border/60 bg-gradient-to-b to-transparent p-5",
          featured ? "from-indigo-500/[0.08] via-muted/40" : "from-muted/40"
        )}
      >
        {visual}
      </div>
      <div className="p-6">
        <div
          className={cn(
            "mb-3 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em]",
            featured ? "text-indigo-600 dark:text-indigo-400" : "text-muted-foreground"
          )}
        >
          <Icon className="h-3.5 w-3.5 text-indigo-500 dark:text-indigo-400" />
          {eyebrow}
        </div>
        <h3 className="text-lg font-semibold tracking-tight text-foreground">{title}</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
        {points && (
          <ul className="mt-4 flex flex-wrap gap-1.5">
            {points.map((p) => (
              <li
                key={p}
                className={cn(
                  "rounded-md border px-2 py-1 text-xs",
                  featured
                    ? "border-indigo-500/25 bg-indigo-500/[0.07] font-medium text-foreground"
                    : "border-border/70 bg-background/50 text-muted-foreground"
                )}
              >
                {p}
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

const panel = "rounded-xl border border-border/70 bg-background/80 shadow-sm";

/* ------------------------------------------------------------------ */
/* Visuals                                                             */
/* ------------------------------------------------------------------ */

function ModelsVisual() {
  const { t } = useTranslation("landing");
  const rows = [
    { icon: LuBrain, name: t("features.visuals.models.reasoningModel"), tag: t("features.visuals.models.reasoningTag"), active: true },
    { icon: LuZap, name: t("features.visuals.models.fastModel"), tag: t("features.visuals.models.fastTag") },
    { icon: LuTerminal, name: t("features.visuals.models.codingModel"), tag: t("features.visuals.models.codingTag") },
    { icon: LuKeyRound, name: t("features.visuals.models.byokModel"), tag: t("features.visuals.models.byokTag") },
  ];
  return (
    <div className="grid h-full gap-4 sm:grid-cols-[1fr_0.9fr]">
      <div className={cn(panel, "p-1.5")}>
        <div className="px-2.5 py-1.5 text-[10px] text-muted-foreground">{t("features.visuals.models.searchPlaceholder")}</div>
        {rows.map((r) => (
          <div
            key={r.name}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs",
              r.active ? "bg-indigo-500/10 text-foreground" : "text-muted-foreground"
            )}
          >
            <r.icon className={cn("h-3.5 w-3.5 shrink-0", r.active && "text-indigo-500 dark:text-indigo-400")} />
            <span className="flex-1 truncate font-medium">{r.name}</span>
            <span className="hidden rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] sm:inline">{r.tag}</span>
          </div>
        ))}
      </div>
      <div className="hidden flex-col justify-center gap-2 sm:flex">
        <div className="ml-auto max-w-[90%] rounded-2xl border border-zinc-500/20 bg-zinc-500/15 px-3 py-2 text-xs text-foreground">
          {t("features.visuals.models.userMessage")}
        </div>
        <div className={cn(panel, "max-w-[95%] px-3 py-2 text-xs text-foreground/90")}>
          <div className="mb-1 flex items-center gap-1.5 text-[10px] text-violet-600 dark:text-violet-400">
            <LuSparkles className="h-3 w-3" /> {t("features.visuals.models.thoughtDuration")}
          </div>
          {t("features.visuals.models.assistantReply")}
        </div>
        <div className="flex gap-1.5 text-[10px] text-muted-foreground">
          <span className="rounded-full bg-muted px-2 py-0.5">{t("features.visuals.models.branchAction")}</span>
          <span className="rounded-full bg-muted px-2 py-0.5">{t("features.visuals.models.retryAction")}</span>
        </div>
      </div>
    </div>
  );
}

function SandboxVisual() {
  const { t } = useTranslation("landing");
  return (
    <div className="flex h-full flex-col gap-3">
      <div className={cn(panel, "p-3")}>
        <div className="flex items-center gap-2 font-mono text-[11px] text-foreground">
          <LuServer className="h-3.5 w-3.5 text-muted-foreground" /> vm-aurora
          <span className="ml-auto flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> {t("features.visuals.sandbox.running")}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 font-mono text-[10px] text-muted-foreground">
          {[
            ["2", t("features.visuals.sandbox.vcpu")],
            ["4 GB", t("features.visuals.sandbox.ram")],
            ["32 GB", t("features.visuals.sandbox.disk")],
          ].map(([v, k]) => (
            <div key={k} className="rounded-lg bg-muted/60 px-2 py-1.5">
              <div className="text-[12px] font-semibold text-foreground">{v}</div>
              {k}
            </div>
          ))}
        </div>
      </div>
      <div className={cn(panel, "p-3")}>
        <div className="mb-2 flex items-center justify-between text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1.5 font-medium text-foreground">
            <LuMonitor className="h-3.5 w-3.5 text-cyan-500" /> {t("features.visuals.sandbox.liveVnc")}
          </span>
          <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 font-mono text-[9px] text-cyan-600 dark:text-cyan-300">
            {t("features.visuals.sandbox.guiPort")}
          </span>
        </div>
        <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/40 px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground">
          <span>{t("features.visuals.sandbox.desktopAndBrowser")}</span>
          <span className="text-emerald-600 dark:text-emerald-400">{t("features.visuals.sandbox.interactive")}</span>
        </div>
      </div>
    </div>
  );
}

function GitVisual() {
  const { t } = useTranslation("landing");
  return (
    <div className="flex h-full flex-col gap-3">
      <svg viewBox="0 0 260 70" className="h-[70px] w-full" aria-hidden="true">
        <path d="M10 50 H250" className="stroke-muted-foreground/40" strokeWidth="2" fill="none" />
        <path d="M70 50 C 95 50, 95 20, 120 20 H200 C 225 20, 225 50, 240 50" className="stroke-indigo-500" strokeWidth="2" fill="none" />
        {[30, 70, 250].map((x) => (
          <circle key={x} cx={x} cy={50} r="5" className="fill-background stroke-muted-foreground/60" strokeWidth="2" />
        ))}
        {[130, 165, 200].map((x) => (
          <circle key={x} cx={x} cy={20} r="5" className="fill-background stroke-indigo-500" strokeWidth="2" />
        ))}
        <text x="10" y="68" className="fill-muted-foreground font-mono" fontSize="8">main</text>
        <text x="128" y="10" className="fill-indigo-500 font-mono" fontSize="8">feat/launch-page</text>
      </svg>
      <div className={cn(panel, "flex items-center gap-2.5 p-2.5")}>
        <LuGitPullRequest className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground">{t("features.visuals.git.prTitle")}</div>
          <div className="font-mono text-[10px] text-muted-foreground">{t("features.visuals.git.diffSummary")}</div>
        </div>
        <span className="rounded-full bg-emerald-500/12 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">{t("features.visuals.git.ready")}</span>
      </div>
      <div className={cn(panel, "flex items-center gap-2.5 p-2.5")}>
        <span className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-indigo-500" />
        <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{t("features.visuals.git.issueTitle")}</div>
      </div>
    </div>
  );
}

const FEATURE_CONNECTORS = connectableConnectors.slice(0, 8);

function ConnectorsVisual() {
  const { t } = useTranslation("landing");
  return (
    <div className="relative flex h-full items-center justify-center">
      <div className="grid grid-cols-4 gap-3">
        {FEATURE_CONNECTORS.map((c, i) => (
          <div
            key={c.id}
            className={cn(
              "flex h-11 w-11 items-center justify-center rounded-xl border border-border/70 bg-white shadow-sm transition-transform group-hover:-translate-y-0.5",
              i % 2 === 1 && "translate-y-2"
            )}
            style={{ transitionDelay: `${i * 30}ms` }}
          >
            <img src={c.logo} alt={c.name} className="h-5 w-5 object-contain" loading="lazy" />
          </div>
        ))}
      </div>
      <span className="absolute bottom-0 right-0 rounded-full border border-border/70 bg-background/80 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
        {t("features.visuals.connectors.badge")}
      </span>
    </div>
  );
}

function MemoryVisual() {
  const { t } = useTranslation("landing");
  const memories = t("features.visuals.memory.items", { returnObjects: true }) as string[];
  return (
    <div className="flex h-full flex-col justify-center gap-2">
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <LuBrain className="h-3 w-3 text-violet-500" /> {t("features.visuals.memory.header")}
      </div>
      {memories.map((m, i) => (
        <div
          key={m}
          className={cn(panel, "flex items-center gap-2 px-3 py-2 text-xs text-foreground")}
          style={{ marginLeft: `${(i % 2) * 16}px` }}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
          {m}
        </div>
      ))}
    </div>
  );
}

function TeamVisual() {
  const { t } = useTranslation("landing");
  const members = [
    { initials: "AK", name: "Ayşe K.", role: t("features.visuals.team.roles.owner"), color: "from-indigo-500 to-violet-500" },
    { initials: "MT", name: "Mert T.", role: t("features.visuals.team.roles.admin"), color: "from-cyan-500 to-sky-500" },
    { initials: "EL", name: "Elif L.", role: t("features.visuals.team.roles.member"), color: "from-emerald-500 to-teal-500" },
  ];
  return (
    <div className={cn(panel, "flex h-full flex-col justify-center gap-1 p-2")}>
      {members.map((m) => (
        <div key={m.name} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
          <span className={cn("flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br text-[10px] font-semibold text-white", m.color)}>
            {m.initials}
          </span>
          <span className="flex-1 text-xs font-medium text-foreground">{m.name}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{m.role}</span>
        </div>
      ))}
      <div className="mt-1 rounded-lg border border-dashed border-border px-2 py-1.5 text-center text-[10px] text-muted-foreground">
        {t("features.visuals.team.inviteByEmail")}
      </div>
    </div>
  );
}

function ByosVisual() {
  const { t } = useTranslation("landing");
  const subscriptions = [
    {
      id: "claude",
      logo: <ClaudeBrandLogo className="h-4 w-4 shrink-0" />,
      name: t("features.visuals.byos.claudeName"),
      plan: t("features.visuals.byos.claudePlan"),
      badge: t("features.visuals.byos.connectedBadge"),
      active: true,
    },
    {
      id: "codex",
      logo: <OpenAICodexBrandLogo className="h-4 w-4 shrink-0 text-foreground" />,
      name: t("features.visuals.byos.codexName"),
      plan: t("features.visuals.byos.codexPlan"),
      badge: t("features.visuals.byos.oauthBadge"),
      active: false,
    },
    {
      id: "antigravity",
      logo: <AntigravityBrandLogo className="h-4 w-4 shrink-0" />,
      name: t("features.visuals.byos.antigravityName"),
      plan: t("features.visuals.byos.antigravityPlan"),
      badge: t("features.visuals.byos.oauthBadge"),
      active: false,
    },
  ];

  return (
    <div className="grid h-full gap-3 sm:grid-cols-[1.15fr_0.85fr]">
      <div className={cn(panel, "flex flex-col justify-center gap-1 p-1.5")}>
        <div className="flex items-center justify-between px-2.5 py-1 text-[10px] text-muted-foreground">
          <span>{t("features.visuals.byos.selectorLabel")}</span>
          <span className="font-mono text-[9px] text-indigo-500 dark:text-indigo-400">BYOS</span>
        </div>
        {subscriptions.map((sub) => (
          <div
            key={sub.id}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs",
              sub.active ? "bg-indigo-500/10 text-foreground" : "text-muted-foreground"
            )}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background/80">
              {sub.logo}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-foreground">{sub.name}</div>
              <div className="truncate text-[10px] text-muted-foreground">{sub.plan}</div>
            </div>
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 font-mono text-[9px] font-medium",
                sub.active
                  ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
                  : "bg-muted text-muted-foreground"
              )}
            >
              {sub.badge}
            </span>
          </div>
        ))}
      </div>

      <div className="hidden flex-col justify-center gap-2.5 sm:flex">
        <div className={cn(panel, "p-3")}>
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1.5 font-medium text-foreground">
              <LuTerminal className="h-3.5 w-3.5 text-indigo-500 dark:text-indigo-400" />
              {t("features.visuals.byos.vmCardTitle")}
            </span>
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          </div>
          <div className="mt-2 rounded-lg border border-border/60 bg-muted/40 px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground">
            {t("features.visuals.byos.vmCardDetail")}
          </div>
        </div>

        <div className={cn(panel, "p-3")}>
          <div className="font-mono text-[10px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
            {t("features.visuals.byos.zeroFeeLabel")}
          </div>
          <div className="mt-1 text-xs font-semibold text-foreground">
            {t("features.visuals.byos.zeroFeeTitle")}
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {t("features.visuals.byos.zeroFeeSubtitle")}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Grid                                                                */
/* ------------------------------------------------------------------ */

export default function LandingFeatures() {
  const { t } = useTranslation("landing");
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      <FeatureCard
        featured
        className="md:col-span-2"
        icon={LuKeyRound}
        eyebrow={t("features.cards.byos.eyebrow")}
        title={t("features.cards.byos.title")}
        description={t("features.cards.byos.description")}
        points={t("features.cards.byos.points", { returnObjects: true }) as string[]}
        visual={<ByosVisual />}
      />
      <FeatureCard
        icon={LuServer}
        eyebrow={t("features.cards.sandbox.eyebrow")}
        title={t("features.cards.sandbox.title")}
        description={t("features.cards.sandbox.description")}
        visual={<SandboxVisual />}
      />
      <FeatureCard
        className="md:col-span-2"
        icon={LuSparkles}
        eyebrow={t("features.cards.models.eyebrow")}
        title={t("features.cards.models.title")}
        description={t("features.cards.models.description")}
        points={t("features.cards.models.points", { returnObjects: true }) as string[]}
        visual={<ModelsVisual />}
      />
      <FeatureCard
        icon={LuGitBranch}
        eyebrow={t("features.cards.git.eyebrow")}
        title={t("features.cards.git.title")}
        description={t("features.cards.git.description")}
        visual={<GitVisual />}
      />
      <FeatureCard
        icon={LuPlug}
        eyebrow={t("features.cards.connectors.eyebrow")}
        title={t("features.cards.connectors.title")}
        description={t("features.cards.connectors.description")}
        visual={<ConnectorsVisual />}
      />
      <FeatureCard
        icon={LuBrain}
        eyebrow={t("features.cards.memory.eyebrow")}
        title={t("features.cards.memory.title")}
        description={t("features.cards.memory.description")}
        visual={<MemoryVisual />}
      />
      <FeatureCard
        icon={LuUsers}
        eyebrow={t("features.cards.team.eyebrow")}
        title={t("features.cards.team.title")}
        description={t("features.cards.team.description")}
        visual={<TeamVisual />}
      />
    </div>
  );
}
