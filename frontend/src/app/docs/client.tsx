"use client";

import { useState, useMemo, useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  LuSearch,
  LuCheck,
  LuChevronRight,
  LuArrowRight,
  LuArrowLeft,
  LuSparkles,
  LuMenu,
  LuX,
  LuThumbsUp,
  LuThumbsDown,
  LuLayers,
  LuShare2,
  LuMessageSquare,
  LuPencil,
} from "react-icons/lu";
import { cn } from "@/lib/utils";
import { DocsSearchDialog } from "./search-dialog";
import { DocsMarkdown } from "./docs-markdown";
import { categoryIcon } from "./docs-icons";
import { DOCS_REPO_URL, useDocs } from "./use-docs";
import { SEO } from "@/components/seo";

export default function DocsClient() {
  const { slug } = useParams<{ slug?: string }>();
  const { t } = useTranslation("docs");
  const { categories: docCategories, pages, ordered } = useDocs();

  // Active article resolution (unknown slugs fall back to the first page)
  const article = (slug && pages[slug]) || ordered[0];
  const activeArticleId = article?.slug ?? "";

  // Search dialog state (Cmd+K)
  const [searchOpen, setSearchOpen] = useState(false);

  // Mobile sidebar drawer state
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // In-page active heading state for Table of Contents
  const [activeHeadingId, setActiveHeadingId] = useState<string>("");

  // Feedback widget state
  const [feedbackGiven, setFeedbackGiven] = useState<"up" | "down" | null>(null);

  // Copied link toast state
  const [linkCopied, setLinkCopied] = useState(false);

  const currentIndex = ordered.findIndex((item) => item.slug === activeArticleId);
  const prevArticle = currentIndex > 0 ? ordered[currentIndex - 1] : null;
  const nextArticle = currentIndex >= 0 && currentIndex < ordered.length - 1 ? ordered[currentIndex + 1] : null;

  const tableOfContents = useMemo(() => article?.headings ?? [], [article]);

  // Set default active heading when article changes
  useEffect(() => {
    setActiveHeadingId(tableOfContents[0]?.id ?? "");
    setFeedbackGiven(null);
    setMobileMenuOpen(false);
  }, [activeArticleId, tableOfContents]);

  // IntersectionObserver for scrollspy
  useEffect(() => {
    const handleScroll = () => {
      const headingElements = tableOfContents
        .map((item) => document.getElementById(item.id))
        .filter(Boolean) as HTMLElement[];

      const scrollPosition = window.scrollY + 140;

      for (let i = headingElements.length - 1; i >= 0; i--) {
        const el = headingElements[i];
        if (el.offsetTop <= scrollPosition) {
          setActiveHeadingId(el.id);
          break;
        }
      }
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [tableOfContents]);

  const copyPageLink = () => {
    navigator.clipboard.writeText(window.location.href);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  const copyHeadingLink = (headingId: string) => {
    const url = new URL(window.location.href);
    url.hash = headingId;
    navigator.clipboard.writeText(url.toString());
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  const docSchema = useMemo(() => ({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TechArticle",
        "headline": article?.title,
        "description": article?.description,
        "url": `https://neuronrunner.com/docs/${activeArticleId}`,
        "publisher": {
          "@type": "Organization",
          "name": "Neuron Runner",
          "url": "https://neuronrunner.com/"
        }
      },
      {
        "@type": "BreadcrumbList",
        "itemListElement": [
          {
            "@type": "ListItem",
            "position": 1,
            "name": t("seo.breadcrumbDoc"),
            "item": "https://neuronrunner.com/docs"
          },
          {
            "@type": "ListItem",
            "position": 2,
            "name": article?.title,
            "item": `https://neuronrunner.com/docs/${activeArticleId}`
          }
        ]
      }
    ]
  }), [article?.title, article?.description, activeArticleId, t]);

  if (!article) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4 text-sm text-muted-foreground">
        {t("article.empty", { defaultValue: "No documentation pages found in the docs/ folder." })}
      </div>
    );
  }

  const editUrl = `${DOCS_REPO_URL}/edit/main/docs/${article.sourcePath}`;

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <SEO
        title={t("seo.title", { title: article.title })}
        description={article.description}
        canonical={`https://neuronrunner.com/docs/${activeArticleId}`}
        ogType="article"
        jsonLd={docSchema}
      />
      {/* Background ambient gradient glow */}
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-[640px] bg-[radial-gradient(circle_at_20%_8%,rgba(99,102,241,0.14),transparent_40%),radial-gradient(circle_at_80%_12%,rgba(34,211,238,0.08),transparent_35%)]"
        />
        <div
          aria-hidden="true"
          className="landing-grid absolute inset-x-0 top-0 h-[520px] opacity-40"
        />
      </div>

      {/* Global Search Dialog (Cmd + K) */}
      <DocsSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />

      {/* ------------------------------------------------------------ */}
      {/* Mobile Top Header Bar                                        */}
      {/* ------------------------------------------------------------ */}
      <div className="sticky top-16 z-40 flex items-center justify-between border-b border-border/60 bg-background/90 px-4 py-2.5 backdrop-blur-md lg:hidden">
        <button
          type="button"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="flex items-center gap-2 rounded-lg border border-border/70 bg-card/60 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          {mobileMenuOpen ? <LuX className="h-4 w-4" /> : <LuMenu className="h-4 w-4" />}
          <span>{mobileMenuOpen ? t("nav.closeMenu") : t("nav.openMenu")}</span>
        </button>

        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="flex items-center gap-1.5 rounded-lg border border-border/70 bg-card/60 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <LuSearch className="h-3.5 w-3.5 text-indigo-400" />
          <span>{t("nav.search")}</span>
          <kbd className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono">⌘K</kbd>
        </button>
      </div>

      {/* ------------------------------------------------------------ */}
      {/* Mobile Drawer (Slide-over navigation)                        */}
      {/* ------------------------------------------------------------ */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 top-[108px] z-50 bg-background/95 backdrop-blur-md p-6 overflow-y-auto lg:hidden">
          <div className="space-y-6">
            {docCategories.map((cat) => {
              const IconComp = categoryIcon(cat.icon);
              return (
                <div key={cat.id} className="space-y-2">
                  <div className="flex items-center gap-2 font-mono text-xs font-semibold uppercase tracking-wider text-foreground">
                    <IconComp className="h-3.5 w-3.5 text-indigo-400" />
                    <span>{cat.title}</span>
                  </div>
                  <ul className="space-y-1 border-l border-border/60 pl-3">
                    {cat.items.map((item) => {
                      const isActive = item.slug === activeArticleId;
                      return (
                        <li key={item.slug}>
                          <Link
                            to={`/docs/${item.slug}`}
                            onClick={() => setMobileMenuOpen(false)}
                            className={cn(
                              "flex items-center justify-between rounded-lg px-2.5 py-2 text-xs transition-colors",
                              isActive
                                ? "bg-indigo-500/15 font-semibold text-indigo-400"
                                : "text-muted-foreground hover:bg-muted hover:text-foreground"
                            )}
                          >
                            <span>{item.title}</span>
                            {item.badge && (
                              <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-mono text-indigo-300">
                                {item.badge}
                              </span>
                            )}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------ */}
      {/* Main 3-Column Layout                                         */}
      {/* ------------------------------------------------------------ */}
      <div className="mx-auto flex w-full max-w-[1440px] px-4 pt-20 sm:px-6 lg:px-8">
        <div className="flex w-full gap-8 xl:gap-12 items-start">
          {/* ======================================================== */}
          {/* 1. LEFT COLUMN: Sticky Navigation Sidebar                */}
          {/* ======================================================== */}
          <aside className="sticky top-20 hidden lg:block w-64 xl:w-72 shrink-0 self-start">
            <div className="flex max-h-[calc(100vh-5.5rem)] flex-col gap-4">
              {/* Search Trigger Button */}
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                className="group flex w-full shrink-0 items-center justify-between rounded-xl border border-border/80 bg-card/60 px-3 py-2 text-xs text-muted-foreground shadow-xs transition-all hover:border-indigo-500/50 hover:bg-card hover:text-foreground"
              >
                <div className="flex items-center gap-2">
                  <LuSearch className="h-3.5 w-3.5 text-indigo-400 transition-transform group-hover:scale-110" />
                  <span className="font-medium">{t("nav.searchPlaceholder")}</span>
                </div>
                <div className="flex items-center gap-1 font-mono text-[10px]">
                  <kbd className="rounded border border-border/60 bg-muted px-1.5 py-0.5 text-muted-foreground shadow-xs">
                    ⌘K
                  </kbd>
                </div>
              </button>

              {/* Navigation Categories */}
              <nav className="min-h-0 flex-1 overflow-y-auto space-y-4 pr-2 pb-6 scrollbar-thin">
                {docCategories.map((cat) => {
                  const IconComp = categoryIcon(cat.icon);
                  return (
                    <div key={cat.id} className="space-y-1.5">
                      <div className="flex items-center gap-2 text-xs font-mono font-semibold uppercase tracking-wider text-foreground/90">
                        <IconComp className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
                        <span>{cat.title}</span>
                      </div>

                      <ul className="space-y-0.5 border-l border-border/60 pl-2.5">
                        {cat.items.map((item) => {
                          const isActive = item.slug === activeArticleId;
                          return (
                            <li key={item.slug}>
                              <Link
                                to={`/docs/${item.slug}`}
                                className={cn(
                                  "group flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition-all",
                                  isActive
                                    ? "bg-indigo-500/15 font-semibold text-indigo-400 shadow-xs"
                                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                                )}
                              >
                                <span className="line-clamp-1">{item.title}</span>
                                {item.badge && (
                                  <span
                                    className={cn(
                                      "rounded px-1.5 py-0.2 text-[9px] font-mono tracking-tight shrink-0",
                                      isActive
                                        ? "bg-indigo-500/25 text-indigo-200"
                                        : "bg-muted text-muted-foreground group-hover:text-foreground"
                                    )}
                                  >
                                    {item.badge}
                                  </span>
                                )}
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
              </nav>
            </div>
          </aside>

          {/* ======================================================== */}
          {/* 2. MIDDLE COLUMN: Article Content                        */}
          {/* ======================================================== */}
          <main className="flex-1 min-w-0 max-w-4xl space-y-8 pb-24">
            {/* Breadcrumb Navigation */}
            <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
              <Link to="/docs" className="transition-colors hover:text-foreground">
                {t("nav.breadcrumbDocs")}
              </Link>
              <LuChevronRight className="h-3 w-3 opacity-60" />
              <span>{article.categoryTitle}</span>
              <LuChevronRight className="h-3 w-3 opacity-60" />
              <span className="font-semibold text-foreground truncate">{article.title}</span>
            </div>

            {/* Article Hero Header */}
            <header className="space-y-3.5 border-b border-border/60 pb-8">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-0.5 text-xs font-mono font-medium text-indigo-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-indigo-400 animate-pulse" />
                  {article.categoryTitle}
                </span>

                {article.badge && (
                  <span className="rounded-full border border-border/70 bg-muted/60 px-2.5 py-0.5 text-xs font-mono text-muted-foreground">
                    {article.badge}
                  </span>
                )}

              </div>

              <h1 className="text-3xl font-extrabold tracking-tight text-foreground sm:text-4xl lg:text-5xl">
                {article.title}
              </h1>

              <p className="text-base sm:text-lg leading-relaxed text-muted-foreground">
                {article.description}
              </p>
            </header>

            {/* Article body, rendered from docs/<category>/<page>.md */}
            <article>
              <DocsMarkdown source={article.body} onCopyHeading={copyHeadingLink} />
            </article>

            {/* Was this page helpful? Feedback Widget */}
            <div className="mt-16 rounded-2xl border border-border/70 bg-card/40 p-6 backdrop-blur-xs">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                  <h4 className="text-sm font-semibold text-foreground">{t("feedback.title")}</h4>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t("feedback.subtitle")}
                  </p>
                </div>

                {feedbackGiven ? (
                  <div className="flex items-center gap-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 px-3 py-1.5 text-xs font-medium text-emerald-400">
                    <LuCheck className="h-4 w-4" />
                    <span>{t("feedback.thanks")}</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setFeedbackGiven("up")}
                      className="flex items-center gap-1.5 rounded-lg border border-border/80 bg-card/80 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-emerald-500/50 hover:bg-emerald-500/10 hover:text-emerald-400"
                    >
                      <LuThumbsUp className="h-3.5 w-3.5" />
                      <span>{t("feedback.yes")}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setFeedbackGiven("down")}
                      className="flex items-center gap-1.5 rounded-lg border border-border/80 bg-card/80 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-rose-500/50 hover:bg-rose-500/10 hover:text-rose-400"
                    >
                      <LuThumbsDown className="h-3.5 w-3.5" />
                      <span>{t("feedback.needsWork")}</span>
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Bottom Pagination (Previous / Next Article Cards) */}
            <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 border-t border-border/60 pt-8">
              {prevArticle ? (
                <Link
                  to={`/docs/${prevArticle.slug}`}
                  className="group flex flex-col justify-between rounded-xl border border-border/80 bg-card/50 p-4 transition-all hover:-translate-y-0.5 hover:border-indigo-500/40 hover:bg-card"
                >
                  <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-muted-foreground group-hover:text-indigo-400">
                    <LuArrowLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-1" />
                    <span>{t("pagination.prev")}</span>
                  </div>
                  <div className="mt-2 text-sm font-semibold text-foreground group-hover:text-indigo-400">
                    {prevArticle.title}
                  </div>
                </Link>
              ) : (
                <div />
              )}

              {nextArticle && (
                <Link
                  to={`/docs/${nextArticle.slug}`}
                  className="group flex flex-col justify-between rounded-xl border border-border/80 bg-card/50 p-4 text-right transition-all hover:-translate-y-0.5 hover:border-indigo-500/40 hover:bg-card"
                >
                  <div className="flex items-center justify-end gap-1.5 text-[11px] font-mono uppercase tracking-wider text-muted-foreground group-hover:text-indigo-400">
                    <span>{t("pagination.next")}</span>
                    <LuArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
                  </div>
                  <div className="mt-2 text-sm font-semibold text-foreground group-hover:text-indigo-400">
                    {nextArticle.title}
                  </div>
                </Link>
              )}
            </div>
          </main>

          {/* ======================================================== */}
          {/* 3. RIGHT COLUMN: Table of Contents & In-Page Actions     */}
          {/* ======================================================== */}
          <aside className="sticky top-20 hidden xl:block w-56 2xl:w-64 shrink-0 self-start">
            <div className="max-h-[calc(100vh-100px)] overflow-y-auto space-y-6 pr-1 pb-6 scrollbar-thin">
              {/* On This Page Section */}
              {tableOfContents.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center gap-1.5 font-mono text-xs font-semibold uppercase tracking-wider text-foreground">
                    <LuLayers className="h-3.5 w-3.5 text-indigo-400" />
                    <span>{t("toc.onThisPage")}</span>
                  </div>

                  <ul className="space-y-2 border-l border-border/60 pl-3 text-xs">
                    {tableOfContents.map((heading) => {
                      const isActive = activeHeadingId === heading.id;
                      return (
                        <li key={heading.id}>
                          <a
                            href={`#${heading.id}`}
                            className={cn(
                              "block transition-colors leading-snug",
                              isActive
                                ? "font-semibold text-indigo-400"
                                : "text-muted-foreground hover:text-foreground"
                            )}
                          >
                            {heading.title}
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {/* Quick Actions */}
              <div className="space-y-2 border-t border-border/60 pt-4">
                <button
                  type="button"
                  onClick={copyPageLink}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {linkCopied ? (
                    <>
                      <LuCheck className="h-3.5 w-3.5 text-emerald-400" />
                      <span className="text-emerald-400 font-medium">{t("toc.linkCopied")}</span>
                    </>
                  ) : (
                    <>
                      <LuShare2 className="h-3.5 w-3.5 text-indigo-400" />
                      <span>{t("toc.copyPageLink")}</span>
                    </>
                  )}
                </button>

                <Link
                  to="/"
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <LuMessageSquare className="h-3.5 w-3.5 text-indigo-400" />
                  <span>{t("toc.askAi")}</span>
                </Link>

                <a
                  href={editUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <div className="flex items-center gap-2">
                    <LuPencil className="h-3.5 w-3.5 text-indigo-400" />
                    <span>{t("toc.editPage", { defaultValue: "Edit this page on GitHub" })}</span>
                  </div>
                </a>
              </div>

              {/* Sandbox Quick Launcher Card */}
              <div className="rounded-xl border border-indigo-500/20 bg-gradient-to-b from-indigo-950/20 to-card/60 p-4 text-xs space-y-2">
                <div className="flex items-center gap-1.5 font-semibold text-foreground">
                  <LuSparkles className="h-3.5 w-3.5 text-indigo-400" />
                  <span>{t("toc.tryItTitle", { defaultValue: "Try it in your workspace" })}</span>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  {t("toc.tryItDesc", { defaultValue: "Open a workspace and ask the agent to run these steps in its sandbox." })}
                </p>
                <Link
                  to="/"
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-indigo-500"
                >
                  <span>{t("toc.startCoding")}</span>
                  <LuArrowRight className="h-3 w-3" />
                </Link>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
