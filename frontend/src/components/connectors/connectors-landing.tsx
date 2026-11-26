"use client";

import { useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  LuArrowRight,
  LuChevronDown,
  LuExternalLink,
  LuLock,
  LuPlug,
  LuSearch,
  LuTerminal,
  LuWandSparkles,
  LuX,
} from "react-icons/lu";
import { IoLogoDiscord, IoLogoGithub } from "react-icons/io5";
import { FaInstagram, FaXTwitter } from "react-icons/fa6";
import frontendExtension from "@cloud";
import useSignupStore from "@/stores/signup";
import { env } from "@/lib/env";
import NeuronLogo from "@/components/neuron-logo";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import {
  connectableConnectors as connectors,
  recommendedConnectors,
  connectorCategories,
  connectorCategoryLabel,
  connectorRemotes,
  type Connector,
} from "@/lib/connectors";
import { cn } from "@/lib/utils";

const FAQ_KEYS = ["q1", "q2", "q3", "q4", "q5"] as const;

const HOW_IT_WORKS_STEPS = [
  {
    key: "step1",
    icon: LuLock,
    surface: "border-indigo-500/25 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
    hoverBorder: "hover:border-indigo-500/40",
    hoverGlow: "from-indigo-500/[0.08] via-transparent to-transparent",
  },
  {
    key: "step2",
    icon: LuTerminal,
    surface: "border-cyan-500/25 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
    hoverBorder: "hover:border-cyan-500/40",
    hoverGlow: "from-cyan-500/[0.08] via-transparent to-transparent",
  },
  {
    key: "step3",
    icon: LuWandSparkles,
    surface: "border-violet-500/25 bg-violet-500/10 text-violet-600 dark:text-violet-400",
    hoverBorder: "hover:border-violet-500/40",
    hoverGlow: "from-violet-500/[0.08] via-transparent to-transparent",
  },
] as const;

export default function ConnectorsLandingPage() {
  const { t, i18n } = useTranslation("connectors");
  const openSignup = useSignupStore((s) => s.setOpen);

  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("All");
  const [sort, setSort] = useState<"featured" | "az" | "za">("featured");
  const [previewConnector, setPreviewConnector] = useState<Connector | null>(null);
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  const hasPricingRoute = frontendExtension.routes.some((r) => r.path === "/pricing");

  const authLabel = (connector: Connector) => {
    const methods = new Set(connectorRemotes(connector).map((remote) => remote.authentication || "none"));
    if (methods.size > 1) return t("landing.auth.multi");
    return t(`landing.auth.${methods.values().next().value || "none"}`);
  };

  const scrollToCatalog = () => {
    document.getElementById("integration-catalog")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const faqs = FAQ_KEYS.map((key) => ({
    key,
    question: t(`landing.faq.items.${key}.question`),
    answer: t(`landing.faq.items.${key}.answer`),
  }));

  const filteredConnectors = useMemo(() => {
    const locale = i18n.resolvedLanguage || "en";
    let list = connectors.slice();

    if (selectedCategory === "Recommended") {
      list = list.filter((c) => c.curated);
    } else if (selectedCategory !== "All") {
      list = list.filter((c) => c.category === selectedCategory);
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q) ||
          c.publisher.toLowerCase().includes(q) ||
          c.category.toLowerCase().includes(q) ||
          connectorCategoryLabel(c.category).toLowerCase().includes(q)
      );
    }

    if (sort === "az") {
      list.sort((a, b) => a.name.localeCompare(b.name, locale));
    } else if (sort === "za") {
      list.sort((a, b) => b.name.localeCompare(a.name, locale));
    }
    // "featured" keeps the curated order from connectableConnectors.

    return list;
  }, [search, selectedCategory, sort, i18n.resolvedLanguage]);

  return (
    <div className="landing-scroll relative flex-1 min-h-0 overflow-x-hidden overflow-y-auto">
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

        {/* ---------------------------------------------------------- */}
        {/* 1. Hero Section                                            */}
        {/* ---------------------------------------------------------- */}
        <section className="relative px-5 pb-12 pt-20 sm:px-8 sm:pt-24 lg:pb-14 lg:pt-24">
          <div className="mx-auto flex max-w-4xl flex-col items-center text-center">
            {/* Pill (unified with Landing & Pricing) */}
            <div className="anim-fade-in-up mb-4 inline-flex items-center gap-2.5 rounded-full border border-indigo-500/25 bg-indigo-500/[0.08] px-3.5 py-1 font-mono text-[11px] font-medium tracking-wide text-indigo-600 shadow-[0_0_24px_-8px_rgba(99,102,241,0.55)] backdrop-blur-md dark:text-indigo-300">
              <LuPlug className="h-3.5 w-3.5 text-indigo-500 dark:text-indigo-300" />
              <span>
                {t("landing.hero.title")} · {t("landing.hero.pill")}
              </span>
            </div>

            {/* Heading (unified scale & gradient finish) */}
            <h1
              className="anim-fade-in-up text-balance text-4xl font-semibold leading-[1.04] tracking-[-0.04em] text-foreground sm:text-5xl lg:text-[3.75rem]"
              style={{ animationDelay: "0.06s" }}
            >
              <Trans
                i18nKey="landing.hero.tagline"
                ns="connectors"
                components={{
                  highlight: (
                    <span className="bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-400 bg-clip-text pb-1 text-transparent dark:from-indigo-400 dark:via-violet-400 dark:to-cyan-300" />
                  ),
                }}
              />
            </h1>

            {/* Subtitle */}
            <p
              className="anim-fade-in-up mt-4 max-w-2xl text-balance text-sm leading-relaxed text-muted-foreground sm:text-[15px] sm:leading-7"
              style={{ animationDelay: "0.12s" }}
            >
              {t("landing.hero.subtitle")}
            </p>

            {/* Primary & secondary CTAs */}
            <div
              className="anim-fade-in-up mt-6 flex w-full flex-col items-center justify-center gap-3 sm:w-auto sm:flex-row"
              style={{ animationDelay: "0.18s" }}
            >
              <button
                type="button"
                onClick={() => openSignup(true)}
                className="group inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-foreground px-6 text-sm font-semibold text-background shadow-lg shadow-indigo-500/20 transition-all duration-200 hover:-translate-y-0.5 hover:opacity-95 sm:w-auto"
              >
                {t("landing.cta.primary")}
                <LuArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </button>
              <button
                type="button"
                onClick={scrollToCatalog}
                className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-border/80 bg-card/60 px-6 text-sm font-medium text-foreground backdrop-blur-md transition-all duration-200 hover:border-foreground/20 hover:bg-card sm:w-auto"
              >
                {t("landing.hero.browseCta")}
                <LuChevronDown className="h-4 w-4" />
              </button>
            </div>

            {/* Curated integration chips */}
            <div
              className="anim-fade-in-up mt-7 flex max-w-3xl flex-wrap items-center justify-center gap-2"
              style={{ animationDelay: "0.24s" }}
            >
              {recommendedConnectors.map((connector) => (
                <button
                  key={connector.id}
                  type="button"
                  onClick={() => setPreviewConnector(connector)}
                  className="inline-flex items-center gap-2 rounded-full border border-border/75 bg-card/60 py-1.5 pl-1.5 pr-3 text-xs font-medium text-muted-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] backdrop-blur-md transition-all duration-200 hover:-translate-y-0.5 hover:border-indigo-500/45 hover:bg-card hover:text-foreground"
                >
                  <ConnectorIcon connector={connector} className="h-5 w-5 rounded-full" />
                  {connector.name}
                </button>
              ))}
              {connectors.length > recommendedConnectors.length && (
                <button
                  type="button"
                  onClick={scrollToCatalog}
                  className="inline-flex items-center gap-1 rounded-full border border-dashed border-border/80 bg-card/30 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-indigo-500/45 hover:text-foreground"
                >
                  {t("landing.hero.more", { count: connectors.length - recommendedConnectors.length })}
                  <LuArrowRight className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------- */}
        {/* 2. Interactive Search & Filters Dock                        */}
        {/* ---------------------------------------------------------- */}
        <section className="mx-auto w-full max-w-6xl px-5 sm:px-8">
          <div className="rounded-3xl border border-border/75 bg-gradient-to-b from-card/90 to-card/60 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl sm:p-6">
            {/* Search + Sort */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative flex-1">
                <LuSearch className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("landing.search.placeholder")}
                  aria-label={t("workspace.searchAria")}
                  className="h-10 w-full rounded-xl border border-border/80 bg-background/75 pl-10 pr-9 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:border-indigo-500/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
                {search && (
                  <button
                    type="button"
                    aria-label={t("workspace.clearSearch")}
                    onClick={() => setSearch("")}
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <LuX className="h-4 w-4" />
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-muted-foreground">{t("landing.search.sortLabel")}</span>
                <div className="relative">
                  <select
                    aria-label={t("workspace.sort.ariaLabel")}
                    value={sort}
                    onChange={(e) => setSort(e.target.value as "featured" | "az" | "za")}
                    className="h-10 appearance-none rounded-xl border border-border/80 bg-background/75 pl-3 pr-8 text-xs font-medium text-foreground transition-colors focus:border-indigo-500/60 focus:outline-none"
                  >
                    <option value="featured">{t("landing.sort.featured")}</option>
                    <option value="az">{t("landing.sort.az")}</option>
                    <option value="za">{t("landing.sort.za")}</option>
                  </select>
                  <LuChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                </div>
              </div>
            </div>

            {/* Category pills */}
            <div className="mt-4 flex flex-wrap gap-1.5 border-t border-border/55 pt-4">
              <button
                type="button"
                onClick={() => setSelectedCategory("Recommended")}
                className={cn(
                  "rounded-xl px-3 py-1.5 text-xs font-medium transition-all duration-200",
                  selectedCategory === "Recommended"
                    ? "bg-foreground font-semibold text-background shadow-sm"
                    : "border border-border/60 bg-background/45 text-muted-foreground hover:border-border hover:bg-muted/60 hover:text-foreground"
                )}
              >
                {t("landing.categories.recommendedWithCount", { count: recommendedConnectors.length })}
              </button>
              <button
                type="button"
                onClick={() => setSelectedCategory("All")}
                className={cn(
                  "rounded-xl px-3 py-1.5 text-xs font-medium transition-all duration-200",
                  selectedCategory === "All"
                    ? "bg-foreground font-semibold text-background shadow-sm"
                    : "border border-border/60 bg-background/45 text-muted-foreground hover:border-border hover:bg-muted/60 hover:text-foreground"
                )}
              >
                {t("landing.categories.allWithCount", { count: connectors.length })}
              </button>
              {connectorCategories.filter((cat) => connectors.some((c) => c.category === cat)).map((cat) => {
                const count = connectors.filter((c) => c.category === cat).length;
                const isSelected = selectedCategory === cat;
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setSelectedCategory(cat)}
                    className={cn(
                      "rounded-xl px-3 py-1.5 text-xs font-medium transition-all duration-200",
                      isSelected
                        ? "bg-foreground font-semibold text-background shadow-sm"
                        : "border border-border/60 bg-background/45 text-muted-foreground hover:border-border hover:bg-muted/60 hover:text-foreground"
                    )}
                  >
                    {connectorCategoryLabel(cat)} ({count})
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------- */}
        {/* 3. Catalog Grid                                             */}
        {/* ---------------------------------------------------------- */}
        <section id="integration-catalog" className="mx-auto w-full max-w-6xl scroll-mt-24 px-5 py-12 sm:px-8 lg:py-16">
          <div className="mb-6 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
            <div className="max-w-2xl">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-indigo-600 dark:text-indigo-400">
                {t("landing.hero.pill")}
              </p>
              <h2 className="mt-1.5 text-balance text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-3xl">
                {t("landing.catalog.title")}
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {t("landing.catalog.subtitle")}
              </p>
            </div>
            <span className="inline-flex w-fit items-center rounded-full border border-border/75 bg-card/60 px-3 py-1 font-mono text-[11px] text-muted-foreground">
              <Trans
                i18nKey="landing.catalog.showing"
                ns="connectors"
                values={{ shown: filteredConnectors.length, total: connectors.length }}
                components={{ strong: <strong className="mx-1 text-foreground" /> }}
              />
            </span>
          </div>

          {filteredConnectors.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-border/80 bg-card/40 p-12 text-center backdrop-blur-sm">
              <LuPlug className="mx-auto h-8 w-8 text-muted-foreground" />
              <h3 className="mt-3 text-base font-semibold text-foreground">{t("landing.empty.title")}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("landing.empty.description", { query: search })}
              </p>
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setSelectedCategory("All");
                }}
                className="mt-4 inline-flex items-center gap-1.5 rounded-xl border border-border/80 bg-foreground/10 px-4 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-foreground/20"
              >
                {t("landing.empty.reset")}
              </button>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredConnectors.map((c) => (
                <div
                  key={c.id}
                  onClick={() => setPreviewConnector(c)}
                  className="landing-card group relative flex cursor-pointer flex-col overflow-hidden rounded-3xl border border-border/75 bg-gradient-to-b from-card/90 to-card/55 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl transition-all duration-300 hover:border-indigo-500/45 hover:shadow-xl hover:shadow-indigo-500/10"
                >
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-indigo-400/75 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                  />
                  <div className="flex items-start gap-3.5">
                    <ConnectorIcon connector={c} className="h-11 w-11 shrink-0 transition-transform duration-200 group-hover:scale-105" />
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-[15px] font-semibold tracking-tight text-foreground transition-colors group-hover:text-indigo-500 dark:group-hover:text-indigo-300">
                        {c.name}
                      </h3>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="rounded-md border border-border/60 bg-background/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {connectorCategoryLabel(c.category)}
                        </span>
                        <span className="rounded-md border border-indigo-500/25 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-semibold text-indigo-600 dark:text-indigo-300">
                          {authLabel(c)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <p className="mb-4 mt-4 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                    {c.description}
                  </p>

                  <div className="mt-auto flex items-center justify-between border-t border-border/50 pt-3.5 text-[11px]">
                    <span className="font-mono text-muted-foreground/80">
                      {connectorRemotes(c).length === 1 ? t("landing.card.remote") : t("landing.card.endpoints", { count: connectorRemotes(c).length })}
                    </span>
                    <span className="flex items-center gap-1 font-semibold text-indigo-600 transition-colors dark:text-indigo-400">
                      {t("landing.card.inspectDetails")}
                      <LuArrowRight className="h-3 w-3 transition-transform duration-200 group-hover:translate-x-0.5" />
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Hairline section divider */}
        <div className="mx-auto w-full max-w-6xl px-5 sm:px-8">
          <div className="h-px w-full bg-gradient-to-r from-transparent via-border/90 to-transparent" />
        </div>

        {/* ---------------------------------------------------------- */}
        {/* 4. How It Works Section                                     */}
        {/* ---------------------------------------------------------- */}
        <section className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-8 lg:py-24">
          <div className="mx-auto mb-12 max-w-2xl text-center">
            <p className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-indigo-600 dark:text-indigo-400">
              {t("landing.howItWorks.eyebrow")}
            </p>
            <h2 className="text-balance text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-4xl">
              {t("landing.howItWorks.title")}
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground sm:text-base">
              {t("landing.howItWorks.subtitle")}
            </p>
          </div>

          <div className="grid gap-5 sm:grid-cols-3">
            {HOW_IT_WORKS_STEPS.map(({ key, icon: Icon, surface, hoverBorder, hoverGlow }) => (
              <div
                key={key}
                className={cn(
                  "landing-card group relative overflow-hidden rounded-3xl border border-border/75 bg-gradient-to-b from-card/90 to-card/55 p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl transition-all duration-300 hover:shadow-xl hover:shadow-black/15 dark:hover:shadow-black/40",
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
                <div className="relative">
                  <div className="mb-5 flex items-center justify-between gap-2">
                    <span
                      className={cn(
                        "flex h-10 w-10 items-center justify-center rounded-xl border transition-transform duration-300 group-hover:scale-105",
                        surface
                      )}
                    >
                      <Icon className="h-5 w-5" />
                    </span>
                    <span className="rounded-full border border-border/70 bg-background/60 px-2.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
                      {t(`landing.howItWorks.${key}.eyebrow`)}
                    </span>
                  </div>
                  <h3 className="text-base font-semibold tracking-tight text-foreground">
                    {t(`landing.howItWorks.${key}.title`)}
                  </h3>
                  <p className="mt-2 text-xs leading-6 text-muted-foreground sm:text-[13px]">
                    {t(`landing.howItWorks.${key}.description`)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Hairline section divider */}
        <div className="mx-auto w-full max-w-6xl px-5 sm:px-8">
          <div className="h-px w-full bg-gradient-to-r from-transparent via-border/90 to-transparent" />
        </div>

        {/* ---------------------------------------------------------- */}
        {/* 5. Editorial FAQ (unified 2-column layout matching Pricing) */}
        {/* ---------------------------------------------------------- */}
        <section className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-8 lg:py-24">
          <div className="grid grid-cols-1 gap-10 lg:grid-cols-12">
            <div className="lg:sticky lg:top-24 lg:col-span-4 lg:self-start">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-indigo-600 dark:text-indigo-400">
                {t("landing.faq.eyebrow")}
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-3xl">
                {t("landing.faq.title")}
              </h2>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                {t("landing.hero.subtitle")}
              </p>
              {env.ENABLE_DOCS && (
                <Link
                  to="/docs"
                  className="mt-5 inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/25 bg-indigo-500/[0.08] px-3 py-1.5 font-mono text-xs font-semibold text-indigo-600 transition-colors hover:border-indigo-500/45 hover:bg-indigo-500/15 dark:text-indigo-300"
                >
                  {t("landing.cta.secondary")}
                  <LuArrowRight className="h-3.5 w-3.5" />
                </Link>
              )}
            </div>

            <div className="space-y-3 lg:col-span-8">
              {faqs.map((faq, index) => {
                const isOpen = openFaq === index;
                return (
                  <div
                    key={faq.key}
                    className={cn(
                      "overflow-hidden rounded-2xl border backdrop-blur-md transition-all duration-200",
                      isOpen
                        ? "border-indigo-500/40 bg-gradient-to-b from-indigo-500/[0.06] to-card/90 shadow-lg shadow-indigo-500/5"
                        : "border-border/75 bg-card/60 hover:border-foreground/20 hover:bg-card/85"
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setOpenFaq(isOpen ? null : index)}
                      aria-expanded={isOpen}
                      className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left text-sm font-semibold text-foreground transition-colors"
                    >
                      <span className="flex items-center gap-3">
                        <span
                          className={cn(
                            "font-mono text-[11px] font-semibold tabular-nums transition-colors",
                            isOpen ? "text-indigo-500 dark:text-indigo-400" : "text-muted-foreground/60"
                          )}
                        >
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <span>{faq.question}</span>
                      </span>
                      <span
                        className={cn(
                          "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-all duration-200",
                          isOpen
                            ? "border-indigo-500/30 bg-indigo-500/15 text-indigo-500 dark:text-indigo-300"
                            : "border-border/70 bg-background/50 text-muted-foreground"
                        )}
                      >
                        <LuChevronDown
                          className={cn("h-4 w-4 transition-transform duration-200", isOpen && "rotate-180")}
                        />
                      </span>
                    </button>
                    {isOpen && (
                      <div className="border-t border-border/55 px-5 py-4 pl-12 text-xs leading-6 text-muted-foreground sm:text-sm">
                        {faq.answer}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------- */}
        {/* 6. Signature Bottom Conversion CTA (shared across all 3)   */}
        {/* ---------------------------------------------------------- */}
        <section className="mx-auto w-full max-w-6xl px-5 pb-20 pt-4 sm:px-8">
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
                {t("landing.cta.title")}
              </h2>
              <p className="mt-4 max-w-xl text-balance text-sm leading-6 text-zinc-400 sm:text-base">
                {t("landing.cta.subtitle")}
              </p>
              <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
                <button
                  type="button"
                  onClick={() => openSignup(true)}
                  className="group inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-white px-6 text-sm font-semibold text-zinc-950 shadow-lg shadow-white/10 transition-all duration-200 hover:-translate-y-0.5 hover:bg-zinc-100"
                >
                  {t("landing.cta.primary")}
                  <LuArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </button>
                {env.ENABLE_DOCS && (
                  <Link
                    to="/docs"
                    className="inline-flex min-h-11 items-center justify-center rounded-xl border border-white/15 bg-white/[0.04] px-6 text-sm font-medium text-white/90 backdrop-blur-sm transition-all duration-200 hover:border-white/25 hover:bg-white/10"
                  >
                    {t("landing.cta.secondary")}
                  </Link>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------- */}
        {/* 7. Unified Footer (exact match with Landing & Pricing)     */}
        {/* ---------------------------------------------------------- */}
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
              {hasPricingRoute && (
                <Link to="/pricing" className="hover:text-foreground">{t("landing.footer.pricing")}</Link>
              )}
              <Link to="/integrations" className="font-medium text-foreground">{t("landing.footer.integrations")}</Link>
              {env.ENABLE_DOCS && <Link to="/docs" className="hover:text-foreground">{t("landing.footer.docs")}</Link>}
              <Link to="/terms-of-service" className="hover:text-foreground">{t("landing.footer.terms")}</Link>
              <Link to="/privacy-policy" className="hover:text-foreground">{t("landing.footer.privacy")}</Link>
            </div>
            <div className="flex items-center gap-3">
              <Link to="https://discord.gg/YpDRUDTkgG" target="_blank" rel="noopener noreferrer" aria-label="Discord" className="hover:text-foreground"><IoLogoDiscord size={18} /></Link>
              <Link to="https://x.com/neuronrunner" target="_blank" rel="noopener noreferrer" aria-label="X" className="hover:text-foreground"><FaXTwitter size={16} /></Link>
              <Link to="https://instagram.com/neuronrunner" target="_blank" rel="noopener noreferrer" aria-label="Instagram" className="hover:text-foreground"><FaInstagram size={16} /></Link>
              <Link to="https://github.com/neuronrunner" target="_blank" rel="noopener noreferrer" aria-label="GitHub" className="hover:text-foreground"><IoLogoGithub size={18} /></Link>
            </div>
          </div>
        </footer>
      </div>

      {/* ---------------------------------------------------------- */}
      {/* Connector Preview Modal Dialog                             */}
      {/* ---------------------------------------------------------- */}
      {previewConnector && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <div className="relative w-full max-w-lg rounded-3xl border border-border/80 bg-gradient-to-b from-card to-card/95 p-6 shadow-2xl ring-1 ring-inset ring-white/[0.06] animate-in fade-in zoom-in-95">
            <button
              type="button"
              aria-label={t("landing.preview.close")}
              onClick={() => setPreviewConnector(null)}
              className="absolute right-4 top-4 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <LuX className="h-5 w-5" />
            </button>

            <div className="flex items-start gap-4">
              <ConnectorIcon connector={previewConnector} className="h-14 w-14" />
              <div>
                <h3 className="text-lg font-bold tracking-tight text-foreground">{previewConnector.name}</h3>
                <div className="mt-0.5 font-mono text-xs text-muted-foreground">v{previewConnector.version}</div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className="rounded-md border border-border/70 bg-muted/60 px-2 py-0.5 text-[11px] font-medium text-foreground">
                    {connectorCategoryLabel(previewConnector.category)}
                  </span>
                  <span className="rounded-md border border-indigo-500/25 bg-indigo-500/10 px-2 py-0.5 text-[11px] font-semibold text-indigo-600 dark:text-indigo-300">
                    {authLabel(previewConnector)}
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-5 space-y-3 text-xs leading-relaxed text-muted-foreground">
              <p className="text-foreground/90">{previewConnector.description}</p>

              <div className="space-y-2 rounded-2xl border border-border/70 bg-background/60 p-4">
                <div className="font-mono text-[11px] font-semibold uppercase tracking-wider text-foreground">
                  {t("landing.preview.protocolTitle")}
                </div>
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>{t("landing.preview.transportTypeLabel")}</span>
                  <span className="font-mono text-foreground">{t("landing.preview.transportHttp")}</span>
                </div>
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>{t("landing.preview.sandboxLabel")}</span>
                  <span className="font-mono text-emerald-500">{t("landing.preview.sandboxValue")}</span>
                </div>
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>{t("landing.preview.authLabel")}</span>
                  <span className="font-mono text-foreground">{authLabel(previewConnector)}</span>
                </div>
                {previewConnector.website && (
                  <div className="flex items-center justify-between border-t border-border/50 pt-2 text-muted-foreground">
                    <span>{t("landing.preview.websiteLabel")}</span>
                    <a
                      href={previewConnector.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-indigo-500 hover:underline dark:text-indigo-400"
                    >
                      {previewConnector.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                      <LuExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-6 flex items-center justify-end gap-3 border-t border-border/60 pt-4">
              <button
                type="button"
                onClick={() => setPreviewConnector(null)}
                className="rounded-xl border border-border/80 px-4 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {t("landing.preview.close")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPreviewConnector(null);
                  openSignup(true);
                }}
                className="inline-flex items-center gap-2 rounded-xl bg-foreground px-5 py-2 text-xs font-semibold text-background shadow-xs transition-opacity hover:opacity-90"
              >
                {t("landing.preview.connectInWorkspace")}
                <LuArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
