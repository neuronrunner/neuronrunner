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
import useSignupStore from "@/stores/signup";
import useSigninStore from "@/stores/signin";
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

export default function ConnectorsLandingPage() {
  const { t, i18n } = useTranslation("connectors");
  const openSignup = useSignupStore((s) => s.setOpen);
  const openSignin = useSigninStore((s) => s.setOpen);

  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("All");
  const [sort, setSort] = useState<"featured" | "az" | "za">("featured");
  const [previewConnector, setPreviewConnector] = useState<Connector | null>(null);
  const [openFaq, setOpenFaq] = useState<number | null>(null);

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
      <div className="relative flex min-h-full flex-col">
        {/* ---------------------------------------------------------- */}
        {/* 1. Hero Section                                            */}
        {/* ---------------------------------------------------------- */}
        <section className="relative px-5 pb-16 pt-24 sm:px-8 sm:pt-28 lg:pb-20 lg:pt-32">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[840px] bg-[radial-gradient(circle_at_35%_18%,rgba(99,102,241,0.18),transparent_35%),radial-gradient(circle_at_75%_22%,rgba(34,211,238,0.12),transparent_30%)]"
          />
          <div aria-hidden="true" className="landing-grid pointer-events-none absolute inset-x-0 top-0 -z-10 h-[720px]" />

          <div className="mx-auto flex max-w-4xl flex-col items-center text-center">
            {/* Pill */}
            <div className="anim-fade-in-up mb-7 flex items-center gap-2 rounded-full border border-border bg-card/60 px-4 py-1.5 font-mono text-xs text-muted-foreground backdrop-blur">
              <LuPlug className="h-3.5 w-3.5 text-indigo-500 dark:text-indigo-400" />
              <span>{t("landing.hero.pill")}</span>
            </div>

            {/* Heading */}
            <h1
              className="anim-fade-in-up text-balance text-4xl font-semibold leading-[1.04] tracking-[-0.05em] text-foreground sm:text-6xl lg:text-[4.75rem]"
              style={{ animationDelay: "0.08s" }}
            >
              {t("landing.hero.title")}
            </h1>

            <p
              className="anim-fade-in-up mt-4 text-balance text-2xl font-medium tracking-tight text-foreground/90 sm:text-3xl"
              style={{ animationDelay: "0.12s" }}
            >
              <Trans
                i18nKey="landing.hero.tagline"
                ns="connectors"
                components={{
                  highlight: (
                    <span className="bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-400 bg-clip-text text-transparent dark:from-indigo-400 dark:via-violet-400 dark:to-cyan-300" />
                  ),
                }}
              />
            </p>

            {/* Subtitle */}
            <p
              className="anim-fade-in-up mt-6 max-w-2xl text-balance text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8"
              style={{ animationDelay: "0.18s" }}
            >
              {t("landing.hero.subtitle")}
            </p>

            <div
              className="anim-fade-in-up mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row"
              style={{ animationDelay: "0.22s" }}
            >
              <button
                type="button"
                onClick={() => openSignup(true)}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-foreground px-6 py-2.5 text-xs font-semibold text-background shadow-sm transition-transform hover:-translate-y-0.5 sm:text-sm"
              >
                {t("landing.cta.primary")}
                <LuArrowRight className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={scrollToCatalog}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-card/50 px-6 py-2.5 text-xs font-medium text-foreground backdrop-blur transition-colors hover:bg-card sm:text-sm"
              >
                {t("landing.hero.browseCta")}
                <LuChevronDown className="h-4 w-4" />
              </button>
            </div>

            {/* Curated integration chips */}
            <div
              className="anim-fade-in-up mt-9 flex max-w-3xl flex-wrap items-center justify-center gap-2"
              style={{ animationDelay: "0.32s" }}
            >
              {recommendedConnectors.map((connector) => (
                <button
                  key={connector.id}
                  type="button"
                  onClick={() => setPreviewConnector(connector)}
                  className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-card/40 py-1.5 pl-1.5 pr-3 text-xs font-medium text-muted-foreground backdrop-blur transition-all hover:-translate-y-0.5 hover:border-indigo-500/40 hover:text-foreground"
                >
                  <ConnectorIcon connector={connector} className="h-5 w-5 rounded-full" />
                  {connector.name}
                </button>
              ))}
              {connectors.length > recommendedConnectors.length && (
                <button
                  type="button"
                  onClick={scrollToCatalog}
                  className="inline-flex items-center gap-1 rounded-full border border-dashed border-border/70 bg-transparent py-1.5 px-3 text-xs font-medium text-muted-foreground transition-colors hover:border-indigo-500/40 hover:text-foreground"
                >
                  {t("landing.hero.more", { count: connectors.length - recommendedConnectors.length })}
                  <LuArrowRight className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------- */}
        {/* 2. Interactive Search & Filters Strip                       */}
        {/* ---------------------------------------------------------- */}
        <section className="mx-auto w-full max-w-6xl px-5 sm:px-8">
          <div className="rounded-2xl border border-border/80 bg-card/60 p-4 sm:p-6 backdrop-blur shadow-sm">
            {/* Search + Sort */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative flex-1">
                <LuSearch className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("landing.search.placeholder")}
                  aria-label={t("workspace.searchAria")}
                  className="w-full rounded-xl border border-border bg-background/80 py-2.5 pl-10 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:border-indigo-500 focus:outline-hidden focus:ring-1 focus:ring-indigo-500"
                />
                {search && (
                  <button
                    type="button"
                    aria-label={t("workspace.clearSearch")}
                    onClick={() => setSearch("")}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <LuX className="h-4 w-4" />
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{t("landing.search.sortLabel")}</span>
                <select
                  aria-label={t("workspace.sort.ariaLabel")}
                  value={sort}
                  onChange={(e) => setSort(e.target.value as any)}
                  className="rounded-xl border border-border bg-background/80 px-3 py-2 text-xs font-medium text-foreground focus:border-indigo-500 focus:outline-hidden"
                >
                  <option value="featured">{t("landing.sort.featured")}</option>
                  <option value="az">{t("landing.sort.az")}</option>
                  <option value="za">{t("landing.sort.za")}</option>
                </select>
              </div>
            </div>

            {/* Category pills */}
            <div className="mt-5 flex flex-wrap gap-1.5 border-t border-border/60 pt-4">
              <button
                type="button"
                onClick={() => setSelectedCategory("Recommended")}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                  selectedCategory === "Recommended"
                    ? "bg-foreground text-background font-semibold shadow-xs"
                    : "bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                )}
              >
                {t("landing.categories.recommendedWithCount", { count: recommendedConnectors.length })}
              </button>
              <button
                type="button"
                onClick={() => setSelectedCategory("All")}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                  selectedCategory === "All"
                    ? "bg-foreground text-background font-semibold shadow-xs"
                    : "bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground"
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
                      "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                      isSelected
                        ? "bg-foreground text-background font-semibold shadow-xs"
                        : "bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground"
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
        <section id="integration-catalog" className="mx-auto w-full max-w-6xl scroll-mt-24 px-5 py-10 sm:px-8">
          <div className="mb-6 max-w-2xl">
            <h2 className="text-balance text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              {t("landing.catalog.title")}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {t("landing.catalog.subtitle")}
            </p>
          </div>
          <div className="mb-4 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              <Trans
                i18nKey="landing.catalog.showing"
                ns="connectors"
                values={{ shown: filteredConnectors.length, total: connectors.length }}
                components={{ strong: <strong className="text-foreground" /> }}
              />
            </span>
          </div>

          {filteredConnectors.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border p-12 text-center">
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
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-foreground/10 px-3.5 py-1.5 text-xs font-semibold text-foreground hover:bg-foreground/20"
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
                  className="group relative flex cursor-pointer flex-col overflow-hidden rounded-2xl border border-border/80 bg-card/50 p-5 shadow-xs backdrop-blur transition-all duration-200 hover:-translate-y-1 hover:border-indigo-500/40 hover:bg-card/80 hover:shadow-lg"
                >
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-indigo-500/60 to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                  />
                  <div className="flex items-start gap-3">
                    <ConnectorIcon connector={c} className="h-11 w-11 shrink-0 transition-transform duration-200 group-hover:scale-105" />
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-sm font-semibold text-foreground transition-colors group-hover:text-indigo-400">
                        {c.name}
                      </h3>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="rounded-md bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {connectorCategoryLabel(c.category)}
                        </span>
                        <span className="rounded-md border border-indigo-500/20 bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium text-indigo-500 dark:text-indigo-400">
                          {authLabel(c)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <p className="mt-4 line-clamp-3 text-xs leading-5 text-muted-foreground">
                    {c.description}
                  </p>

                  <div className="mt-auto flex items-center justify-between pt-4 text-[11px]">
                    <span className="font-mono text-muted-foreground/80">
                      {connectorRemotes(c).length === 1 ? t("landing.card.remote") : t("landing.card.endpoints", { count: connectorRemotes(c).length })}
                    </span>
                    <span className="flex items-center gap-1 font-medium text-indigo-500 transition-colors dark:text-indigo-400">
                      {t("landing.card.inspectDetails")}
                      <LuArrowRight className="h-3 w-3 transition-transform duration-200 group-hover:translate-x-0.5" />
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ---------------------------------------------------------- */}
        {/* 4. How It Works Section                                     */}
        {/* ---------------------------------------------------------- */}
        <section className="border-t border-border/70 bg-card/25 py-20 lg:py-28">
          <div className="mx-auto w-full max-w-6xl px-5 sm:px-8">
            <div className="mb-14 text-center max-w-2xl mx-auto">
              <p className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-indigo-600 dark:text-indigo-400">
                {t("landing.howItWorks.eyebrow")}
              </p>
              <h2 className="text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                {t("landing.howItWorks.title")}
              </h2>
              <p className="mt-3 text-base text-muted-foreground">
                {t("landing.howItWorks.subtitle")}
              </p>
            </div>

            <div className="grid gap-6 sm:grid-cols-3">
              <div className="rounded-2xl border border-border/80 bg-card/40 p-6 backdrop-blur">
                <span className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
                  <LuLock className="h-5 w-5" />
                </span>
                <span className="font-mono text-xs text-muted-foreground">{t("landing.howItWorks.step1.eyebrow")}</span>
                <h3 className="mt-1 text-base font-semibold text-foreground">{t("landing.howItWorks.step1.title")}</h3>
                <p className="mt-2 text-xs leading-6 text-muted-foreground">
                  {t("landing.howItWorks.step1.description")}
                </p>
              </div>

              <div className="rounded-2xl border border-border/80 bg-card/40 p-6 backdrop-blur">
                <span className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
                  <LuTerminal className="h-5 w-5" />
                </span>
                <span className="font-mono text-xs text-muted-foreground">{t("landing.howItWorks.step2.eyebrow")}</span>
                <h3 className="mt-1 text-base font-semibold text-foreground">{t("landing.howItWorks.step2.title")}</h3>
                <p className="mt-2 text-xs leading-6 text-muted-foreground">
                  {t("landing.howItWorks.step2.description")}
                </p>
              </div>

              <div className="rounded-2xl border border-border/80 bg-card/40 p-6 backdrop-blur">
                <span className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
                  <LuWandSparkles className="h-5 w-5" />
                </span>
                <span className="font-mono text-xs text-muted-foreground">{t("landing.howItWorks.step3.eyebrow")}</span>
                <h3 className="mt-1 text-base font-semibold text-foreground">{t("landing.howItWorks.step3.title")}</h3>
                <p className="mt-2 text-xs leading-6 text-muted-foreground">
                  {t("landing.howItWorks.step3.description")}
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------- */}
        {/* 5. FAQs                                                     */}
        {/* ---------------------------------------------------------- */}
        <section className="mx-auto w-full max-w-4xl px-5 py-20 sm:px-8 lg:py-28">
          <div className="mb-12 text-center">
            <p className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-indigo-600 dark:text-indigo-400">
              {t("landing.faq.eyebrow")}
            </p>
            <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              {t("landing.faq.title")}
            </h2>
          </div>

          <div className="space-y-3">
            {faqs.map((faq, index) => {
              const isOpen = openFaq === index;
              return (
                <div
                  key={faq.key}
                  className="overflow-hidden rounded-xl border border-border/80 bg-card/50 backdrop-blur transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => setOpenFaq(isOpen ? null : index)}
                    className="flex w-full items-center justify-between px-5 py-4 text-left text-sm font-semibold text-foreground hover:text-indigo-400 transition-colors"
                  >
                    <span>{faq.question}</span>
                    <LuChevronDown
                      className={cn(
                        "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200",
                        isOpen && "rotate-180 text-indigo-400"
                      )}
                    />
                  </button>
                  {isOpen && (
                    <div className="border-t border-border/60 px-5 py-4 text-xs leading-6 text-muted-foreground sm:text-sm sm:leading-7">
                      {faq.answer}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* ---------------------------------------------------------- */}
        {/* 6. Conversion CTA                                          */}
        {/* ---------------------------------------------------------- */}
        <section className="mx-auto w-full max-w-6xl px-5 pb-24 sm:px-8">
          <div className="relative overflow-hidden rounded-3xl border border-indigo-500/20 bg-[#09090d] p-8 text-center text-white shadow-2xl shadow-indigo-950/20 sm:p-14">
            <div
              aria-hidden="true"
              className="absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(99,102,241,0.25),transparent_40%),radial-gradient(circle_at_80%_100%,rgba(34,211,238,0.15),transparent_35%)]"
            />
            <div className="relative mx-auto max-w-2xl">
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
                {t("landing.cta.title")}
              </h2>
              <p className="mt-4 text-sm text-zinc-400 sm:text-base">
                {t("landing.cta.subtitle")}
              </p>
              <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
                <button
                  type="button"
                  onClick={() => openSignup(true)}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-white px-6 py-2.5 text-xs font-semibold text-zinc-950 shadow-md transition-transform hover:-translate-y-0.5 sm:text-sm"
                >
                  {t("landing.cta.primary")}
                  <LuArrowRight className="h-4 w-4" />
                </button>
                {env.ENABLE_DOCS && (
                  <Link
                    to="/docs"
                    className="inline-flex items-center justify-center rounded-xl border border-white/15 px-6 py-2.5 text-xs font-medium text-white/90 transition-colors hover:bg-white/10 sm:text-sm"
                  >
                    {t("landing.cta.secondary")}
                  </Link>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------- */}
        {/* 7. Footer                                                  */}
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
          <div className="relative w-full max-w-lg rounded-2xl border border-border/80 bg-card p-6 shadow-2xl animate-in fade-in zoom-in-95">
            <button
              type="button"
              aria-label={t("landing.preview.close")}
              onClick={() => setPreviewConnector(null)}
              className="absolute right-4 top-4 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <LuX className="h-5 w-5" />
            </button>

            <div className="flex items-start gap-4">
              <ConnectorIcon connector={previewConnector} className="h-14 w-14" />
              <div>
                <h3 className="text-lg font-bold text-foreground">{previewConnector.name}</h3>
                <div className="mt-0.5 font-mono text-xs text-muted-foreground">v{previewConnector.version}</div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground">
                    {connectorCategoryLabel(previewConnector.category)}
                  </span>
                  <span className="rounded-md border border-indigo-500/20 bg-indigo-500/10 px-2 py-0.5 text-[11px] font-semibold text-indigo-500 dark:text-indigo-400">
                    {authLabel(previewConnector)}
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-5 space-y-3 text-xs leading-relaxed text-muted-foreground">
              <p className="text-foreground/90">{previewConnector.description}</p>
              
              <div className="rounded-xl border border-border/70 bg-muted/30 p-3.5 space-y-2">
                <div className="font-mono text-[11px] uppercase tracking-wider text-foreground font-semibold">
                  {t("landing.preview.protocolTitle")}
                </div>
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>{t("landing.preview.transportTypeLabel")}</span>
                  <span className="font-mono text-foreground">
                    {t("landing.preview.transportHttp")}
                  </span>
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
                  <div className="flex items-center justify-between text-muted-foreground pt-1 border-t border-border/50">
                    <span>{t("landing.preview.websiteLabel")}</span>
                    <a
                      href={previewConnector.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-indigo-400 hover:underline inline-flex items-center gap-1"
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
                className="rounded-xl border border-border px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {t("landing.preview.close")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPreviewConnector(null);
                  openSignup(true);
                }}
                className="inline-flex items-center gap-2 rounded-xl bg-foreground px-5 py-2 text-xs font-semibold text-background shadow-xs hover:opacity-90"
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
