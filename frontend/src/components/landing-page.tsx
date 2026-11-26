"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import frontendExtension from "@cloud";
import useSignupStore from "@/stores/signup";
import {
  LuArrowRight,
  LuBot,
  LuCode,
  LuGitPullRequest,
  LuKeyRound,
  LuMonitor,
  LuServer,
  LuShieldCheck,
  LuUsers,
} from "react-icons/lu";
import { IoLogoDiscord, IoLogoGithub } from "react-icons/io5";
import { FaInstagram, FaXTwitter } from "react-icons/fa6";
import { HeroStage, LayerStack } from "@/components/landing/landing-3d";
import { GITHUB_REPO_URL, GitHubStarLink } from "@/components/github-stars";
import LandingFeatures from "@/components/landing/landing-features";
import NeuronLogo from "@/components/neuron-logo";
import { SEO } from "@/components/seo";
import { connectableConnectors } from "@/lib/connectors";
import { env } from "@/lib/env";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Content                                                             */
/* ------------------------------------------------------------------ */

const DISCORD_INVITE_URL = "https://discord.gg/YpDRUDTkgG";

const CAPABILITY_CHIPS = [
  { id: "byos", icon: LuKeyRound, labelKey: "hero.chips.byos" },
  { id: "autonomousAgent", icon: LuBot, labelKey: "hero.chips.autonomousAgent" },
  { id: "isolatedVm", icon: LuCode, labelKey: "hero.chips.isolatedVm" },
  { id: "liveVnc", icon: LuMonitor, labelKey: "hero.chips.liveVnc" },
  { id: "gitAutoPr", icon: LuGitPullRequest, labelKey: "hero.chips.gitAutoPr" },
] as const;

const WORKFLOW_STEPS = [
  {
    id: "assign",
    icon: LuBot,
    labelKey: "workflow.steps.assign.label",
    detailKey: "workflow.steps.assign.detail",
    surface: "border-indigo-500/30 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300",
    hoverBorder: "hover:border-indigo-500/40",
  },
  {
    id: "execute",
    icon: LuCode,
    labelKey: "workflow.steps.execute.label",
    detailKey: "workflow.steps.execute.detail",
    surface: "border-cyan-500/30 bg-cyan-500/10 text-cyan-600 dark:text-cyan-300",
    hoverBorder: "hover:border-cyan-500/40",
  },
  {
    id: "watchLive",
    icon: LuMonitor,
    labelKey: "workflow.steps.watchLive.label",
    detailKey: "workflow.steps.watchLive.detail",
    surface: "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300",
    hoverBorder: "hover:border-violet-500/40",
  },
  {
    id: "shipPr",
    icon: LuGitPullRequest,
    labelKey: "workflow.steps.shipPr.label",
    detailKey: "workflow.steps.shipPr.detail",
    surface: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
    hoverBorder: "hover:border-emerald-500/40",
  },
] as const;

const DARK_CONNECTOR_LOGOS = new Set([
  "/integrations/github.svg",
  "/integrations/notion.svg",
  "/integrations/vercel.svg",
  "/integrations/sentry.svg",
  "/integrations/jina-ai.svg",
  "/integrations/posthog.svg",
  "/integrations/miro.svg",
  "/integrations/elevenlabs.svg",
  "/integrations/box.svg",
  "/integrations/hugging-face.svg",
]);

const TRUST_ITEMS = [
  {
    id: "isolated",
    icon: LuShieldCheck,
    titleKey: "trust.items.isolated.title",
    textKey: "trust.items.isolated.text",
    surface: "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    hoverBorder: "hover:border-emerald-500/40",
  },
  {
    id: "liveVnc",
    icon: LuMonitor,
    titleKey: "trust.items.liveVnc.title",
    textKey: "trust.items.liveVnc.text",
    surface: "border-cyan-500/25 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
    hoverBorder: "hover:border-cyan-500/40",
  },
  {
    id: "byok",
    icon: LuKeyRound,
    titleKey: "trust.items.byok.title",
    textKey: "trust.items.byok.text",
    surface: "border-indigo-500/25 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
    hoverBorder: "hover:border-indigo-500/40",
  },
  {
    id: "roles",
    icon: LuUsers,
    titleKey: "trust.items.roles.title",
    textKey: "trust.items.roles.text",
    surface: "border-violet-500/25 bg-violet-500/10 text-violet-600 dark:text-violet-400",
    hoverBorder: "hover:border-violet-500/40",
  },
] as const;

const OPEN_SOURCE_ITEMS = [
  {
    id: "transparent",
    icon: IoLogoGithub,
    titleKey: "openSource.items.transparent.title",
    textKey: "openSource.items.transparent.text",
    surface: "border-indigo-500/25 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
    hoverBorder: "hover:border-indigo-500/40",
  },
  {
    id: "selfHost",
    icon: LuServer,
    titleKey: "openSource.items.selfHost.title",
    textKey: "openSource.items.selfHost.text",
    surface: "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    hoverBorder: "hover:border-emerald-500/40",
  },
  {
    id: "community",
    icon: LuGitPullRequest,
    titleKey: "openSource.items.community.title",
    textKey: "openSource.items.community.text",
    surface: "border-cyan-500/25 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
    hoverBorder: "hover:border-cyan-500/40",
  },
] as const;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      el.classList.add("is-visible");
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.classList.add("is-visible");
          observer.disconnect();
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={cn("landing-reveal", className)} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

function SectionHeading({ eyebrow, title, description, center }: { eyebrow: string; title: string; description?: string; center?: boolean }) {
  return (
    <div className={cn("mb-12 max-w-2xl", center && "mx-auto text-center")}>
      <p className="mb-4 font-mono text-xs uppercase tracking-[0.2em] text-indigo-600 dark:text-indigo-400">{eyebrow}</p>
      <h2 className="text-balance text-3xl font-semibold tracking-[-0.03em] text-foreground sm:text-[2.6rem] sm:leading-[1.08]">{title}</h2>
      {description && <p className="mt-4 text-balance text-base leading-7 text-muted-foreground">{description}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

const LandingPage = () => {
  const { t } = useTranslation("landing");
  const openSignup = useSignupStore((s) => s.setOpen);

  return (
    <div className="landing-scroll relative flex-1 min-h-0 overflow-x-hidden overflow-y-auto">
      <SEO
        title={t("seo.landing.title")}
        description={t("seo.landing.description")}
        canonical="https://neuronrunner.com/"
      />
      <div className="relative isolate flex min-h-full flex-col">
        {/* Global ambient stage backdrop (shared across Landing, Pricing & Integrations) */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[760px] bg-[radial-gradient(ellipse_55%_44%_at_50%_-4%,rgba(99,102,241,0.18),transparent_68%),radial-gradient(ellipse_40%_32%_at_80%_14%,rgba(34,211,238,0.11),transparent_65%),radial-gradient(ellipse_35%_28%_at_18%_18%,rgba(139,92,246,0.09),transparent_65%)]"
        />
        <div
          aria-hidden="true"
          className="landing-grid pointer-events-none absolute inset-x-0 top-0 -z-10 h-[620px] opacity-65 dark:opacity-90"
        />

        {/* Hero ----------------------------------------------------- */}
        <section className="relative px-5 pb-16 pt-20 sm:px-8 sm:pt-24 lg:pb-24 lg:pt-24">
          <div className="mx-auto flex max-w-4xl flex-col items-center text-center">
            <div className="anim-fade-in-up mb-4 inline-flex items-center gap-2.5 rounded-full border border-indigo-500/25 bg-indigo-500/[0.08] px-3.5 py-1 font-mono text-[11px] font-medium tracking-wide text-indigo-600 shadow-[0_0_24px_-8px_rgba(99,102,241,0.55)] backdrop-blur-md dark:text-indigo-300">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              {t("hero.badge")}
            </div>

            <h1
              className="anim-fade-in-up text-balance text-4xl font-semibold leading-[1.04] tracking-[-0.04em] text-foreground sm:text-5xl lg:text-[3.75rem]"
              style={{ animationDelay: "0.06s" }}
            >
              <span className="bg-gradient-to-b from-foreground via-foreground to-foreground/80 bg-clip-text text-transparent">
                {t("hero.titleLine1")}
              </span>
              <br />
              <span className="bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-400 bg-clip-text pb-1 text-transparent dark:from-indigo-400 dark:via-violet-400 dark:to-cyan-300">
                {t("hero.titleLine2")}
              </span>
            </h1>

            <p
              className="anim-fade-in-up mt-4 max-w-2xl text-balance text-sm leading-relaxed text-muted-foreground sm:text-[15px] sm:leading-7"
              style={{ animationDelay: "0.12s" }}
            >
              {t("hero.subtitle")}
            </p>

            <div className="anim-fade-in-up mt-6 flex w-full flex-col gap-3 sm:w-auto sm:flex-row" style={{ animationDelay: "0.18s" }}>
              <GitHubStarLink />
              <button
                type="button"
                onClick={() => openSignup(true)}
                className="group inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-foreground px-6 text-sm font-semibold text-background shadow-lg shadow-indigo-500/20 transition-all duration-200 hover:-translate-y-0.5 hover:opacity-95"
              >
                {t("hero.launchCta")}
                <LuArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </button>
            </div>

            <div className="anim-fade-in-up mt-4 flex flex-wrap items-center justify-center gap-2" style={{ animationDelay: "0.22s" }}>
              <a
                href={DISCORD_INVITE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-full border border-[#5865F2]/25 bg-[#5865F2]/10 px-3.5 py-1.5 text-xs font-medium text-foreground/85 transition-colors hover:border-[#5865F2]/50 hover:bg-[#5865F2]/15 hover:text-foreground"
              >
                <IoLogoDiscord className="h-4 w-4 text-[#5865F2]" />
                <span>{t("hero.discordCta")}</span>
                <LuArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
              </a>
            </div>

            <div className="anim-fade-in-up mt-5 flex flex-wrap justify-center gap-2" style={{ animationDelay: "0.26s" }} aria-label={t("hero.chipsAriaLabel")}>
              {CAPABILITY_CHIPS.map((chip) => (
                <span key={chip.id} className="inline-flex items-center gap-1.5 rounded-lg border border-border/75 bg-card/50 px-2.5 py-1.5 text-xs text-muted-foreground backdrop-blur-sm">
                  <chip.icon className="h-3.5 w-3.5 text-indigo-500 dark:text-indigo-400" />
                  {t(chip.labelKey)}
                </span>
              ))}
            </div>
          </div>

          <div className="anim-fade-in-up mt-10 sm:mt-12" style={{ animationDelay: "0.32s" }}>
            <HeroStage />
          </div>
        </section>

        {/* Connectors strip ---------------------------------------- */}
        <section className="relative border-y border-border/70 bg-card/30 py-8 backdrop-blur-sm">
          <p className="mb-6 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
            {t("connectors.eyebrow")}
          </p>
          <div className="landing-marquee">
            <div className="landing-marquee__track">
              {[...connectableConnectors, ...connectableConnectors].map((c, i) => (
                <Link
                  key={`${c.id}-${i}`}
                  to="/integrations"
                  className="group flex shrink-0 items-center gap-2.5 rounded-xl border border-border/80 bg-card/40 px-3.5 py-2 shadow-sm backdrop-blur-sm transition-all duration-200 hover:border-indigo-500/40 hover:bg-card/80 hover:shadow-md dark:border-white/[0.08] dark:bg-white/[0.025] dark:hover:border-white/20 dark:hover:bg-white/[0.05]"
                >
                  <img
                    src={c.logo}
                    alt={c.name}
                    className={cn(
                      "h-5 w-5 shrink-0 object-contain transition-transform duration-200 group-hover:scale-110",
                      DARK_CONNECTOR_LOGOS.has(c.logo) && "dark:brightness-0 dark:invert"
                    )}
                    loading="lazy"
                    decoding="async"
                  />
                  <span className="text-sm font-medium tracking-tight text-foreground/90 transition-colors group-hover:text-foreground whitespace-nowrap">
                    {c.name}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* Features ------------------------------------------------- */}
        <section id="features" className="mx-auto w-full max-w-6xl px-5 pt-24 pb-12 sm:px-8 lg:pt-28 lg:pb-16">
          <Reveal>
            <SectionHeading
              eyebrow={t("featuresSection.eyebrow")}
              title={t("featuresSection.title")}
              description={t("featuresSection.description")}
            />
          </Reveal>
          <Reveal>
            <LandingFeatures />
          </Reveal>
        </section>

        {/* Workflow ------------------------------------------------- */}
        <section id="workflow" className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 lg:py-24">
          <Reveal>
            <SectionHeading
              center
              eyebrow={t("workflow.eyebrow")}
              title={t("workflow.title")}
              description={t("workflow.description")}
            />
          </Reveal>
          <div role="list" className="relative grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div aria-hidden="true" className="absolute left-[12%] right-[12%] top-[44px] hidden h-px bg-gradient-to-r from-transparent via-indigo-500/40 to-transparent lg:block" />
            {WORKFLOW_STEPS.map((step, index) => (
              <Reveal key={step.id} delay={index * 90}>
                <div
                  role="listitem"
                  className={cn(
                    "group relative flex h-full flex-col items-center rounded-3xl border border-border/75 bg-gradient-to-b from-card/90 to-card/55 p-6 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl transition-all duration-300 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/15 dark:hover:shadow-black/40",
                    step.hoverBorder
                  )}
                >
                  <span
                    className={cn(
                      "relative z-10 mb-5 flex h-12 w-12 items-center justify-center rounded-2xl border shadow-sm transition-transform duration-300 group-hover:scale-105",
                      step.surface
                    )}
                  >
                    <step.icon className="h-5 w-5" />
                  </span>
                  <div className="text-base font-semibold tracking-tight text-foreground">
                    <span className="mr-1.5 font-mono text-xs text-muted-foreground">0{index + 1}</span>
                    {t(step.labelKey)}
                  </div>
                  <p className="mt-2 text-xs leading-6 text-muted-foreground sm:text-sm">{t(step.detailKey)}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* Architecture (3D) ---------------------------------------- */}
        <section className="relative overflow-hidden border-y border-border/70 bg-card/25 py-20 lg:py-28">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_75%_50%,rgba(99,102,241,0.12),transparent_45%)]" />
          <div className="relative mx-auto w-full max-w-6xl px-5 sm:px-8">
            <Reveal>
              <SectionHeading
                eyebrow={t("architecture.eyebrow")}
                title={t("architecture.title")}
                description={t("architecture.description")}
              />
            </Reveal>
            <Reveal>
              <LayerStack />
            </Reveal>
          </div>
        </section>

        {/* Trust ---------------------------------------------------- */}
        <section className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 lg:py-24">
          <Reveal>
            <SectionHeading center eyebrow={t("trust.eyebrow")} title={t("trust.title")} />
          </Reveal>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {TRUST_ITEMS.map((item, i) => (
              <Reveal key={item.id} delay={i * 80}>
                <div
                  className={cn(
                    "group h-full rounded-3xl border border-border/75 bg-gradient-to-b from-card/90 to-card/55 p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl transition-all duration-300 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/15 dark:hover:shadow-black/40",
                    item.hoverBorder
                  )}
                >
                  <span
                    className={cn(
                      "mb-5 flex h-10 w-10 items-center justify-center rounded-xl border transition-transform duration-300 group-hover:scale-105",
                      item.surface
                    )}
                  >
                    <item.icon className="h-5 w-5" />
                  </span>
                  <h3 className="text-base font-semibold tracking-tight text-foreground">{t(item.titleKey)}</h3>
                  <p className="mt-2 text-xs leading-6 text-muted-foreground sm:text-sm">{t(item.textKey)}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* Open Source ---------------------------------------------- */}
        <section id="open-source" className="relative border-t border-border/70 bg-card/20 py-20 lg:py-24">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_50%_40%_at_50%_0%,rgba(99,102,241,0.10),transparent_70%)]" />
          <div className="relative mx-auto w-full max-w-6xl px-5 sm:px-8">
            <Reveal>
              <SectionHeading
                center
                eyebrow={t("openSource.eyebrow")}
                title={t("openSource.title")}
                description={t("openSource.description")}
              />
            </Reveal>
            <div className="grid gap-4 md:grid-cols-3">
              {OPEN_SOURCE_ITEMS.map((item, i) => (
                <Reveal key={item.id} delay={i * 80}>
                  <div
                    className={cn(
                      "group h-full rounded-3xl border border-border/75 bg-gradient-to-b from-card/90 to-card/55 p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl transition-all duration-300 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/15 dark:hover:shadow-black/40",
                      item.hoverBorder
                    )}
                  >
                    <span
                      className={cn(
                        "mb-5 flex h-10 w-10 items-center justify-center rounded-xl border transition-transform duration-300 group-hover:scale-105",
                        item.surface
                      )}
                    >
                      <item.icon className="h-5 w-5" />
                    </span>
                    <h3 className="text-base font-semibold tracking-tight text-foreground">{t(item.titleKey)}</h3>
                    <p className="mt-2 text-xs leading-6 text-muted-foreground sm:text-sm">{t(item.textKey)}</p>
                  </div>
                </Reveal>
              ))}
            </div>
            <Reveal delay={240}>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <GitHubStarLink />
                {env.ENABLE_DOCS && (
                  <Link
                    to="/docs"
                    className="group inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border/80 bg-card/60 px-5 text-sm font-medium text-foreground backdrop-blur-md transition-all duration-200 hover:border-foreground/20 hover:bg-card"
                  >
                    {t("openSource.docsCta")}
                    <LuArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                )}
              </div>
            </Reveal>
          </div>
        </section>

        {/* CTA ------------------------------------------------------ */}
        <section className="mx-auto w-full max-w-6xl px-5 pb-20 pt-12 sm:px-8">
          <Reveal>
            <div className="relative overflow-hidden rounded-[2rem] border border-indigo-500/25 bg-[#07070c] px-6 py-14 text-center text-white shadow-[0_32px_80px_-28px_rgba(99,102,241,0.35)] ring-1 ring-inset ring-white/[0.06] sm:px-12 sm:py-16">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-16 top-0 h-px bg-gradient-to-r from-transparent via-indigo-400/80 to-transparent"
              />
              <div
                aria-hidden="true"
                className="absolute inset-0 bg-[radial-gradient(circle_at_24%_0%,rgba(99,102,241,0.30),transparent_42%),radial-gradient(circle_at_82%_100%,rgba(34,211,238,0.16),transparent_38%)]"
              />
              <div aria-hidden="true" className="landing-grid landing-grid--dark absolute inset-0 opacity-65" />
              <div className="relative mx-auto flex max-w-2xl flex-col items-center">
                <span className="mb-5 inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-white/15 bg-white/[0.06] text-white shadow-[0_0_32px_-8px_rgba(99,102,241,0.75)] backdrop-blur-md">
                  <NeuronLogo size={24} className="text-white" />
                </span>
                <h2 className="text-balance bg-gradient-to-b from-white via-white to-white/75 bg-clip-text text-3xl font-semibold tracking-[-0.035em] text-transparent sm:text-5xl sm:leading-[1.08]">
                  {t("cta.title")}
                </h2>
                <p className="mt-4 max-w-xl text-balance text-sm leading-6 text-zinc-400 sm:text-base">
                  {t("cta.description")}
                </p>
                <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                  <GitHubStarLink
                    className="border-white/15 bg-white/[0.06] text-white hover:border-white/30 hover:bg-white/[0.12]"
                    badgeClassName="border-white/15 text-zinc-300 group-hover:text-white"
                  />
                  <button
                    type="button"
                    onClick={() => openSignup(true)}
                    className="group inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-white px-6 text-sm font-semibold text-zinc-950 shadow-lg shadow-white/10 transition-all duration-200 hover:-translate-y-0.5 hover:bg-zinc-100"
                  >
                    {t("cta.launchButton")}
                    <LuArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                  </button>
                </div>
                <a
                  href={DISCORD_INVITE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-5 inline-flex items-center gap-2 rounded-full border border-[#5865F2]/35 bg-[#5865F2]/15 px-4 py-2 text-xs font-medium text-indigo-100 transition-colors hover:border-[#5865F2]/60 hover:bg-[#5865F2]/25"
                >
                  <IoLogoDiscord className="h-4 w-4 text-[#7289da]" />
                  <span>{t("cta.discordButton")}</span>
                  <LuArrowRight className="h-3.5 w-3.5 opacity-75" />
                </a>
              </div>
            </div>
          </Reveal>
        </section>

        <footer className="mt-auto border-t border-border/70">
          <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-5 px-5 py-7 text-xs text-muted-foreground sm:flex-row sm:px-8">
            <Link to="/" className="group flex items-center gap-3 transition-opacity hover:opacity-90">
              <NeuronLogo size={32} className="text-foreground transition-transform duration-200 group-hover:scale-105" />
              <div className="font-mono text-base tracking-tight text-foreground">
                <span className="font-bold">neuron</span>
                <span className="font-light text-muted-foreground">_runner</span>
              </div>
            </Link>
            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
              {frontendExtension.routes.some((r) => r.path === "/pricing") && (
                <Link to="/pricing" className="hover:text-foreground">{t("footer.pricing")}</Link>
              )}
              <Link to="/integrations" className="hover:text-foreground">{t("footer.integrations")}</Link>
              {env.ENABLE_DOCS && <Link to="/docs" className="hover:text-foreground">{t("footer.docs")}</Link>}
              <Link to="/terms-of-service" className="hover:text-foreground">{t("footer.terms")}</Link>
              <Link to="/privacy-policy" className="hover:text-foreground">{t("footer.privacy")}</Link>
            </div>
            <div className="flex items-center gap-3">
              <Link to={DISCORD_INVITE_URL} target="_blank" rel="noopener noreferrer" aria-label="Discord" className="hover:text-foreground"><IoLogoDiscord size={18} /></Link>
              <Link to="https://x.com/neuronrunner" target="_blank" rel="noopener noreferrer" aria-label="X" className="hover:text-foreground"><FaXTwitter size={16} /></Link>
              <Link to="https://instagram.com/neuronrunner" target="_blank" rel="noopener noreferrer" aria-label="Instagram" className="hover:text-foreground"><FaInstagram size={16} /></Link>
              <Link to={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer" aria-label="GitHub" className="hover:text-foreground"><IoLogoGithub size={18} /></Link>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
};

export default LandingPage;
