"use client";

import { useCallback, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  LuBrain,
  LuCheck,
  LuChevronDown,
  LuFileCode2,
  LuGitPullRequest,
  LuMessagesSquare,
  LuMonitor,
  LuServer,
  LuSparkles,
  LuTerminal,
} from "react-icons/lu";
import LandingWorkspacePreview from "@/components/landing-workspace-preview";
import NeuronLogo from "@/components/neuron-logo";
import { cn } from "@/lib/utils";

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/* ------------------------------------------------------------------ */
/* Hero stage: tilted workspace with floating depth cards               */
/* ------------------------------------------------------------------ */

function FloatCard({
  children,
  className,
  depth,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  depth: number;
  delay?: number;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn("landing-float pointer-events-none absolute z-20 hidden md:block", className)}
      style={{ "--z": `${depth}px` } as CSSProperties}
    >
      <div className="landing-float__bob" style={{ animationDelay: `${delay}s` }}>
        <div className="flex items-center gap-2.5 rounded-xl border border-border/80 bg-card/90 px-3 py-2 text-xs shadow-xl shadow-indigo-950/10 backdrop-blur-md dark:shadow-black/40">
          {children}
        </div>
      </div>
    </div>
  );
}

function IconBadge({ children, tone }: { children: ReactNode; tone: "indigo" | "emerald" | "violet" | "cyan" }) {
  const tones = {
    indigo: "bg-indigo-500/12 text-indigo-600 dark:text-indigo-300",
    emerald: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
    violet: "bg-violet-500/12 text-violet-600 dark:text-violet-300",
    cyan: "bg-cyan-500/12 text-cyan-600 dark:text-cyan-300",
  };
  return <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", tones[tone])}>{children}</span>;
}

export function HeroStage() {
  const { t } = useTranslation("landing");
  const planeRef = useRef<HTMLDivElement>(null);

  const onMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const plane = planeRef.current;
    if (!plane || e.pointerType !== "mouse" || prefersReducedMotion()) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    plane.style.setProperty("--rx", `${16 - y * 8}deg`);
    plane.style.setProperty("--ry", `${x * 10}deg`);
  }, []);

  const onLeave = useCallback(() => {
    planeRef.current?.style.removeProperty("--rx");
    planeRef.current?.style.removeProperty("--ry");
  }, []);

  return (
    <div className="landing-stage relative mx-auto w-full max-w-6xl" onPointerMove={onMove} onPointerLeave={onLeave}>
      <div aria-hidden="true" className="landing-floor" />
      <div aria-hidden="true" className="absolute -inset-x-10 -top-10 bottom-10 -z-10 bg-[radial-gradient(ellipse_at_50%_40%,rgba(99,102,241,0.22),transparent_62%)] blur-2xl" />

      <div ref={planeRef} className="landing-stage__plane relative">
        <LandingWorkspacePreview />

        <FloatCard depth={110} delay={0} className="-left-10 top-[14%] lg:-left-16">
          <IconBadge tone="violet"><LuBrain className="h-3.5 w-3.5" /></IconBadge>
          <div className="leading-tight">
            <div className="font-medium text-foreground">{t("architecture.floatCards.vmAttachedTitle")}</div>
            <div className="font-mono text-[11px] text-muted-foreground">{t("architecture.floatCards.vmAttachedSubtitle")}</div>
          </div>
        </FloatCard>

        <FloatCard depth={150} delay={1.2} className="-right-8 top-[8%] lg:-right-14">
          <IconBadge tone="emerald"><LuCheck className="h-3.5 w-3.5" /></IconBadge>
          <div className="leading-tight">
            <div className="font-medium text-foreground">{t("architecture.floatCards.testsPassedTitle")}</div>
            <div className="font-mono text-[11px] text-muted-foreground">root@neuronrunner:/workspace/neuronrunner</div>
          </div>
        </FloatCard>

        <FloatCard depth={90} delay={2.1} className="-left-6 bottom-[16%] lg:-left-12">
          <IconBadge tone="cyan"><LuMonitor className="h-3.5 w-3.5" /></IconBadge>
          <div className="leading-tight">
            <div className="font-medium text-foreground">{t("architecture.floatCards.vncTitle")}</div>
            <div className="font-mono text-[11px] text-muted-foreground">{t("architecture.floatCards.vncSubtitle")}</div>
          </div>
        </FloatCard>

        <FloatCard depth={130} delay={0.6} className="-right-6 bottom-[22%] lg:-right-12">
          <IconBadge tone="indigo"><LuGitPullRequest className="h-3.5 w-3.5" /></IconBadge>
          <div className="leading-tight">
            <div className="font-medium text-foreground">{t("architecture.floatCards.prOpenedTitle")}</div>
            <div className="text-[11px] text-muted-foreground">neuronrunner · feat/launch → main</div>
          </div>
        </FloatCard>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Layer stack: isometric 3D explanation of the architecture           */
/* ------------------------------------------------------------------ */

const LAYERS = [
  { id: "sandbox", icon: LuServer },
  { id: "workspace", icon: LuFileCode2 },
  { id: "conversation", icon: LuMessagesSquare },
] as const;

function PlateContent({ id }: { id: (typeof LAYERS)[number]["id"] }) {
  const { t } = useTranslation("landing");
  if (id === "sandbox") {
    return (
      <div className="flex h-full flex-col justify-between p-4">
        <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          <LuServer className="h-3.5 w-3.5" /> lightning-atlas
          <span className="ml-auto rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-600 dark:text-emerald-400">
            1
          </span>
        </div>

        <div className="rounded-xl border border-border/70 bg-[#050508] p-2.5 font-mono text-[9px] text-zinc-200">
          <div className="mb-1.5 flex items-center justify-between border-b border-white/10 pb-1.5 text-[9px] text-zinc-400">
            <span className="flex items-center gap-1 text-zinc-200">
              <LuTerminal className="h-3 w-3 text-zinc-400" /> {t("architecture.plates.terminalLabel")}
            </span>
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          </div>
          <div className="truncate">
            <span className="text-emerald-400">root@neuronrunner</span>
            <span className="text-zinc-400">:</span>
            <span className="text-cyan-400">/workspace/neuronrunner</span>
            <span className="text-zinc-200"># npm test</span>
          </div>
          <div className="mt-1 truncate text-emerald-400">{t("architecture.plates.testsPassed")}</div>
        </div>

        <div className="grid grid-cols-2 gap-1.5 font-mono text-[9px] text-muted-foreground">
          <div className="rounded border border-border/70 bg-muted/50 px-2 py-1">{t("architecture.plates.vncLive")}</div>
          <div className="rounded border border-border/70 bg-muted/50 px-2 py-1">{t("architecture.plates.specs")}</div>
        </div>
      </div>
    );
  }
  if (id === "workspace") {
    return (
      <div className="grid h-full grid-cols-[40%_1fr]">
        <div className="space-y-1.5 border-r border-border/60 p-4 font-mono text-[10px] text-muted-foreground">
          <div className="text-[9px] uppercase tracking-wider">neuronrunner · main</div>
          <div className="rounded bg-indigo-500/12 px-1.5 py-0.5 text-indigo-600 dark:text-indigo-300">page.tsx</div>
          <div className="px-1.5">chart.tsx</div>
          <div className="px-1.5">analytics.ts</div>
          <div className="px-1.5">package.json</div>
        </div>
        <div className="flex flex-col justify-between p-4 font-mono text-[10px]">
          <div className="space-y-1 text-muted-foreground">
            <div><span className="text-violet-600 dark:text-violet-400">export</span> function Page() {"{"}</div>
            <div className="pl-3">return &lt;Dashboard /&gt;</div>
            <div>{"}"}</div>
          </div>
          <div className="flex items-center gap-1.5 rounded border border-border/70 bg-muted/50 px-2 py-1 text-muted-foreground">
            <LuTerminal className="h-3 w-3" /> /workspace/neuronrunner
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col justify-between gap-2 p-5">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span className="font-medium text-foreground">neuronrunner · main</span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border/75 bg-card/65 px-2 py-0.5 font-mono text-[8.5px] text-foreground/90">
          <span className="relative flex h-2.5 w-2.5 items-center justify-center">
            <NeuronLogo size={10} variant="symbol" className="text-foreground" />
            <span className="absolute -bottom-0.5 -right-0.5 h-1 w-1 rounded-full bg-emerald-500" />
          </span>
          {t("home.agentSelector.agents.neuron.name")}
          <LuChevronDown className="h-2.5 w-2.5 opacity-60" />
        </span>
      </div>
      <div className="rounded-xl border border-border/80 bg-card/80 p-2.5 text-[10px] text-muted-foreground">
        {t("architecture.plates.promptPlaceholder")}
      </div>
      <div className="flex items-center gap-1.5 self-start rounded-lg border border-border/70 bg-muted/50 px-2 py-1 text-[10px] text-foreground/90">
        <LuSparkles className="h-3 w-3 text-violet-500" /> {t("architecture.plates.modelSummary")}
      </div>
    </div>
  );
}

export function LayerStack() {
  const { t } = useTranslation("landing");
  const [active, setActive] = useState<number | null>(null);

  return (
    <div className="grid items-center gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:gap-6">
      <ol className="order-2 space-y-3 lg:order-1">
        {[...LAYERS].reverse().map((layer) => {
          const index = LAYERS.indexOf(layer);
          const isActive = active === index;
          return (
            <li key={layer.id}>
              <button
                type="button"
                onClick={() => setActive((prev) => (prev === index ? null : index))}
                onMouseEnter={() => setActive(index)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(index)}
                onBlur={() => setActive(null)}
                className={cn(
                  "group flex w-full items-start gap-4 rounded-2xl border p-5 text-left transition-all",
                  isActive
                    ? "border-indigo-500/40 bg-card shadow-lg shadow-indigo-500/5"
                    : "border-border/70 bg-card/50 hover:bg-card/80"
                )}
              >
                <span
                  className={cn(
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-colors",
                    isActive
                      ? "border-indigo-500/30 bg-indigo-500/12 text-indigo-600 dark:text-indigo-300"
                      : "border-border bg-background text-muted-foreground"
                  )}
                >
                  <layer.icon className="h-[18px] w-[18px]" />
                </span>
                <span className="min-w-0">
                  <span className="flex items-baseline gap-2">
                    <span className="font-mono text-[11px] text-muted-foreground">0{LAYERS.length - index}</span>
                    <span className="text-base font-semibold tracking-tight text-foreground">{t(`architecture.layers.${layer.id}.title`)}</span>
                    <span className="hidden font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground sm:inline">{t(`architecture.layers.${layer.id}.eyebrow`)}</span>
                  </span>
                  <span className="mt-1 block text-sm leading-6 text-muted-foreground">{t(`architecture.layers.${layer.id}.description`)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="landing-layers order-1 lg:order-2" aria-hidden="true">
        <div className={cn("landing-layers__stack", active !== null && "is-focused")}>
          {LAYERS.map((layer, i) => (
            <div
              key={layer.id}
              className={cn("landing-layer", active === i && "is-active")}
              style={{ "--i": i } as CSSProperties}
            >
              <div className="landing-layer__label">
                <layer.icon className="h-3.5 w-3.5" />
                {t(`architecture.layers.${layer.id}.title`)}
              </div>
              <PlateContent id={layer.id} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
