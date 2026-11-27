"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { LuArrowDownWideNarrow, LuArrowLeft, LuArrowRight, LuCheck, LuChevronDown, LuChevronRight, LuInfo, LuLoader, LuPlug, LuPlus, LuSearch, LuX } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { WorkspaceSidebarToggle } from "@/components/workspace-page-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { ConnectorDialog } from "@/components/connectors/connector-dialog";
import GithubAccountConnection from "@/components/connectors/github-account-connection";
import GitlabAccountConnection from "@/components/connectors/gitlab-account-connection";
import { API_BASE, authedAxios } from "@/lib/axios";
import { catalogDate, connectableConnectors as connectors, connectorCanConnect, connectorCategories, connectorCategoryDescription, connectorCategoryLabel, connectorError, connectorServerName, type Connector, type ConnectorServer } from "@/lib/connectors";
import { cn } from "@/lib/utils";
import useAuthStore from "@/stores/auth";
import ConnectorsLandingPage from "@/components/connectors/connectors-landing";
import { SEO } from "@/components/seo";
import "./integrations.css";

const pageSize = 24;
const popularIds = [
  "io.github.github/github-mcp-server",
  "com.supabase/mcp",
  "com.notion/mcp",
  "com.figma.mcp/mcp",
  "app.linear/linear",
  "com.stripe/mcp",
];
const noteworthyIds = [
  "io.github.upstash/context7",
  "io.github.firecrawl/firecrawl-mcp-server",
  "io.github.elevenlabs/elevenlabs-mcp",
  "io.github.getsentry/sentry-mcp",
  "com.vercel/vercel-mcp",
  "ai.exa/exa",
];
const curatedRank = new Map([...popularIds, ...noteworthyIds].map((id, index) => [id, index]));

function compareFeatured(a: Connector, b: Connector, locale = "en") {
  const rankA = curatedRank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
  const rankB = curatedRank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
  if (rankA !== rankB) return rankA - rankB;
  return Number(b.featured) - Number(a.featured) || a.name.localeCompare(b.name, locale);
}

function ConnectorsWorkspaceView() {
  const { t, i18n } = useTranslation("connectors");
  const locale = i18n.resolvedLanguage || "en";
  const token = useAuthStore((state) => state.token);
  const userId = useAuthStore((state) => state.user?.uuid);
  const [searchParams, setSearchParams] = useSearchParams();
  const activeCategory = searchParams.get("category");
  const [tab, setTab] = useState<"explore" | "connections">("explore");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("featured");
  const scrollContainer = useRef<HTMLDivElement>(null);
  const [limit, setLimit] = useState(pageSize);
  const [servers, setServers] = useState<ConnectorServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [revision, setRevision] = useState(0);
  const [githubAccountCount, setGithubAccountCount] = useState(0);
  const [selection, setSelection] = useState<{ connector: Connector | null; server?: ConnectorServer } | null>(null);

  useEffect(() => {
    setServers([]); setLoadError(""); setSelection(null);
    if (!token) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    authedAxios.get<ConnectorServer[]>(`${API_BASE}/mcp/`, { signal: controller.signal })
      .then((response) => { if (!controller.signal.aborted) setServers(response.data); })
      .catch((cause) => { if (!controller.signal.aborted) setLoadError(connectorError(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, userId, revision]);

  useEffect(() => { setLimit(pageSize); }, [query, activeCategory, sort, tab]);

  const openCategory = (cat: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("category", cat);
      return next;
    });
    setQuery("");
    setLimit(pageSize);
    if (scrollContainer.current) scrollContainer.current.scrollTo({ top: 0, behavior: "smooth" });
  };

  const closeCategory = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("category");
      return next;
    });
    setQuery("");
    setLimit(pageSize);
    if (scrollContainer.current) scrollContainer.current.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleTabChange = (nextTab: "explore" | "connections") => {
    setTab(nextTab);
    if (nextTab === "connections" && activeCategory) {
      closeCategory();
    }
  };

  const serverByName = useMemo(() => new Map(servers.map((server) => [server.name, server])), [servers]);
  const catalogByName = useMemo(() => new Map(connectors.map((connector) => [connectorServerName(connector), connector])), []);

  const matchesQuery = (connector: Connector, searchStr: string) =>
    !searchStr.trim() ||
    `${connector.name} ${connector.description} ${connector.publisher} ${connector.category} ${connectorCategoryLabel(connector.category)} ${connector.chatgptDirectory?.name || ""}`
      .toLowerCase()
      .includes(searchStr.trim().toLowerCase());

  const popularConnectors = useMemo(() => {
    const idsSet = new Set(popularIds);
    return connectors.filter((c) => idsSet.has(c.id)).sort((a, b) => compareFeatured(a, b, locale));
  }, [locale]);

  const noteworthyConnectors = useMemo(() => {
    const idsSet = new Set(noteworthyIds);
    return connectors.filter((c) => idsSet.has(c.id)).sort((a, b) => compareFeatured(a, b, locale));
  }, [locale]);

  // Subpage connectors when a category is selected
  const subPageConnectors = useMemo(() => {
    if (!activeCategory) return [];
    let base: Connector[] = [];
    if (activeCategory === "Popular") {
      base = popularConnectors;
    } else if (activeCategory === "New & Noteworthy") {
      base = noteworthyConnectors;
    } else {
      base = connectors.filter((c) => c.category === activeCategory);
    }
    return base
      .filter((c) => matchesQuery(c, query))
      .sort((a, b) => sort === "featured" ? compareFeatured(a, b, locale) : a.name.localeCompare(b.name, locale));
  }, [activeCategory, popularConnectors, noteworthyConnectors, query, sort, locale]);

  const subPageTotalCount = useMemo(() => {
    if (!activeCategory) return 0;
    if (activeCategory === "Popular") return popularConnectors.length;
    if (activeCategory === "New & Noteworthy") return noteworthyConnectors.length;
    return connectors.filter((c) => c.category === activeCategory).length;
  }, [activeCategory, popularConnectors, noteworthyConnectors]);

  // Global search results across all connectors
  const searchResults = useMemo(() => {
    if (!query.trim()) return [];
    return connectors
      .filter((c) => matchesQuery(c, query))
      .sort((a, b) => sort === "featured" ? compareFeatured(a, b, locale) : a.name.localeCompare(b.name, locale));
  }, [query, sort, locale]);

  // Master alphabetical list when sort is "name"
  const alphabeticalAll = useMemo(() => {
    return [...connectors].sort((a, b) => a.name.localeCompare(b.name, locale));
  }, [locale]);

  const connected = useMemo(() => {
    return servers.filter((server) => {
      const connector = catalogByName.get(server.name);
      return connector ? matchesQuery(connector, query) : server.name.toLowerCase().includes(query.trim().toLowerCase());
    });
  }, [servers, catalogByName, query]);

  const formattedCatalogDate = useMemo(() => {
    const parsed = new Date(`${catalogDate}T00:00:00`);
    return Number.isNaN(parsed.getTime())
      ? catalogDate
      : parsed.toLocaleDateString(locale, {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
  }, [locale]);

  const activeCategoryLabel = activeCategory ? connectorCategoryLabel(activeCategory) : "";
  const activeCategoryDescription = activeCategory ? connectorCategoryDescription(activeCategory) : "";

  const openConnector = (connector: Connector) => setSelection({ connector, server: serverByName.get(connectorServerName(connector)) });
  const updateServer = (server: ConnectorServer) => setServers((current) => [...current.filter((item) => item.uuid !== server.uuid), server]);

  const addCustomConnectorButton = (
    <Button
      variant="outline"
      size="sm"
      onClick={() => setSelection({ connector: null })}
      className="h-8 shrink-0 gap-1.5 rounded-full border-border/80 bg-card/80 px-3 text-xs hover:border-primary/40"
    >
      <LuPlus className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">{t("workspace.addCustomConnector")}</span>
      <span className="sm:hidden">{t("workspace.addCustomShort")}</span>
    </Button>
  );

  return (
    <section aria-label={t("workspace.ariaLabel")} className="connectors-page relative flex h-full min-h-0 min-w-0 flex-col bg-background">
      <WorkspaceSidebarToggle label={t("workspace.openSidebar")} />

      <div ref={scrollContainer} className="workspace-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="connectors-scroll">
        <div className="mx-auto w-full max-w-5xl px-4 pb-6 pt-14 sm:px-8 sm:pb-9">
          {/* Subpage View */}
          {activeCategory && tab === "explore" ? (
            <div className="connectors-enter">
              <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
                <button
                  type="button"
                  onClick={closeCategory}
                  className="group inline-flex items-center gap-2 rounded-full border border-border/80 bg-card/80 px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-all hover:border-primary/40 hover:bg-muted hover:text-foreground dark:bg-white/[0.03]"
                >
                  <LuArrowLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" />
                  <span>{t("workspace.backToExplore")}</span>
                </button>

                <div className="flex items-center gap-2">
                {addCustomConnectorButton}
                <Select value={sort} onValueChange={setSort}>
                  <SelectTrigger aria-label={t("workspace.sort.ariaLabel")} className="h-8 w-auto gap-2 rounded-full border-border/80 bg-card/80 px-3 text-xs text-muted-foreground shadow-none dark:bg-white/[0.03]">
                    <LuArrowDownWideNarrow aria-hidden="true" className="h-3.5 w-3.5" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectItem value="featured">{t("workspace.sort.featured")}</SelectItem>
                    <SelectItem value="name">{t("workspace.sort.nameAsc")}</SelectItem>
                  </SelectContent>
                </Select>
                </div>
              </div>

              <div className="mb-6">
                <div className="flex items-center gap-2.5">
                  <h1 className="text-2xl font-semibold tracking-tight sm:text-[28px]">{activeCategoryLabel}</h1>
                  <span aria-live="polite" className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold tabular-nums text-muted-foreground">
                    {subPageTotalCount}
                  </span>
                </div>
                <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
                  {activeCategoryDescription || t("workspace.categoryFallbackDescription", { category: activeCategoryLabel })}
                </p>
              </div>

              <div className="relative mb-7">
                <LuSearch aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  aria-label={t("workspace.searchCategoryAria", { category: activeCategoryLabel })}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("workspace.searchCategoryPlaceholder", { category: activeCategoryLabel })}
                  className="h-11 w-full rounded-full border border-border/90 bg-card/90 pl-11 pr-10 text-sm outline-none transition-all placeholder:text-muted-foreground/80 focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-white/[0.03]"
                />
                {query && (
                  <button
                    type="button"
                    aria-label={t("workspace.clearSearch")}
                    onClick={() => setQuery("")}
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <LuX className="h-4 w-4" />
                  </button>
                )}
              </div>

              {subPageConnectors.length === 0 ? (
                <div className="flex flex-col items-center rounded-2xl border border-border/70 bg-card/60 px-5 py-16 text-center dark:bg-white/[0.02]">
                  <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-border/60 bg-muted/50 text-muted-foreground">
                    <LuSearch className="h-5 w-5" />
                  </span>
                  <h3 className="text-base font-medium">{t("workspace.empty.noConnectorsTitle")}</h3>
                  <p className="mt-1.5 max-w-xs text-xs leading-5 text-muted-foreground">
                    {query.trim()
                      ? t("workspace.empty.noCategoryMatches", { category: activeCategoryLabel, query })
                      : t("workspace.empty.noCategoryItems", { category: activeCategoryLabel })}
                  </p>
                  {query.trim() && (
                    <Button variant="outline" size="sm" className="mt-5 rounded-full px-4" onClick={() => setQuery("")}>
                      {t("workspace.clearSearch")}
                    </Button>
                  )}
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2" data-testid="connector-grid">
                    {subPageConnectors.slice(0, limit).map((connector, index) => (
                      <ConnectorCard
                        key={connector.id}
                        connector={connector}
                        animationIndex={index % pageSize}
                        server={serverByName.get(connectorServerName(connector))}
                        onClick={() => openConnector(connector)}
                      />
                    ))}
                  </div>

                  {subPageConnectors.length > 0 && (
                    <div className="mt-8 flex flex-col items-center gap-3">
                      <span className="text-[11px] text-muted-foreground">
                        {t("workspace.showingCount", { shown: Math.min(limit, subPageConnectors.length), total: subPageConnectors.length })}
                      </span>
                      {limit < subPageConnectors.length && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setLimit((value) => value + pageSize)}
                          className="h-9 rounded-full border-border/80 bg-card/80 px-5 text-xs hover:border-primary/40 dark:bg-white/[0.03]"
                        >
                          {t("workspace.showMore")}
                          <LuChevronDown className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            /* Main Overview & Connections View */
            <>
              <div className="connectors-enter mb-6 flex items-center justify-between gap-6">
                <div>
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-primary/80">{t("workspace.eyebrow")}</p>
                  <h1 className="text-2xl font-semibold tracking-tight sm:text-[28px]">{t("workspace.title")}</h1>
                  <p className="mt-1.5 max-w-lg text-sm leading-relaxed text-muted-foreground">
                    {t("workspace.subtitle")}
                  </p>
                  <div className="mt-4">{addCustomConnectorButton}</div>
                </div>
                <ConnectorConstellation />
              </div>

              <div style={{ animationDelay: "100ms" }} className="connectors-enter relative">
                <LuSearch aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  aria-label={t("workspace.searchAria")}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("workspace.searchPlaceholder")}
                  className="h-11 w-full rounded-full border border-border/90 bg-card/90 pl-11 pr-10 text-sm outline-none transition-all placeholder:text-muted-foreground/80 focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-white/[0.03]"
                />
                {query && (
                  <button
                    type="button"
                    aria-label={t("workspace.clearSearch")}
                    onClick={() => setQuery("")}
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <LuX className="h-4 w-4" />
                  </button>
                )}
              </div>

              <div className="connectors-enter mb-7 mt-4 flex flex-wrap items-center justify-between gap-3" style={{ animationDelay: "150ms" }}>
                <div role="group" aria-label={t("workspace.tabs.ariaLabel")} className="inline-flex items-center gap-1.5">
                  {(["explore", "connections"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={tab === value}
                      onClick={() => handleTabChange(value)}
                      className={cn(
                        "flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-medium transition-all",
                        tab === value
                          ? "bg-foreground text-background shadow-sm dark:bg-white/15 dark:text-foreground dark:ring-1 dark:ring-white/15"
                          : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                      )}
                    >
                      {value === "explore" ? t("workspace.tabs.explore") : t("workspace.tabs.connections")}
                      <span className="text-[10px] tabular-nums opacity-65">{value === "explore" ? connectors.length : loading ? "…" : servers.length + githubAccountCount}</span>
                    </button>
                  ))}
                </div>
                {tab === "explore" && (
                  <Select value={sort} onValueChange={setSort}>
                    <SelectTrigger aria-label={t("workspace.sort.ariaLabel")} className="h-8 w-auto gap-2 rounded-full border-border/80 bg-card/80 px-3 text-xs text-muted-foreground shadow-none dark:bg-white/[0.03]">
                      <LuArrowDownWideNarrow aria-hidden="true" className="h-3.5 w-3.5" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end">
                      <SelectItem value="featured">{t("workspace.sort.featured")}</SelectItem>
                      <SelectItem value="name">{t("workspace.sort.nameAsc")}</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </div>

              {loadError && (
                <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-xs">
                  <span className="text-destructive">
                    {loadError.toLowerCase().startsWith("couldn’t load") || loadError.toLowerCase().startsWith("could not load")
                      ? loadError
                      : t("workspace.loadError", { error: loadError })}
                  </span>
                  <button type="button" onClick={() => setRevision((value) => value + 1)} className="underline underline-offset-4">{t("workspace.tryAgain")}</button>
                </div>
              )}

              {/* Connections Tab */}
              {tab === "connections" && (
                <section aria-label={t("workspace.connections.ariaLabel")} className="connectors-enter space-y-7" style={{ animationDelay: "220ms" }}>
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    <GithubAccountConnection onCountChange={setGithubAccountCount} />
                    <GitlabAccountConnection />
                  </div>

                  <div>
                    <div className="mb-3.5 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <h2 className="text-base font-semibold tracking-tight">{t("workspace.mcpConnectionsTitle")}</h2>
                        <span aria-live="polite" className="rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
                          {loading ? "…" : connected.length}
                        </span>
                        {query.trim() && (
                          <button type="button" onClick={() => setQuery("")} className="ml-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">
                            {t("workspace.clearSearch")}
                          </button>
                        )}
                      </div>
                    </div>
                    {loading ? (
                      <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
                        <LuLoader className="h-4 w-4 animate-spin" />{t("workspace.connections.loading")}
                      </div>
                    ) : connected.length === 0 ? (
                      <div className="flex flex-col items-center rounded-2xl border border-border/70 bg-card/60 px-5 py-16 text-center dark:bg-white/[0.02]">
                        <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-border/60 bg-muted/50 text-muted-foreground">
                          {query.trim() ? <LuSearch className="h-5 w-5" /> : <LuPlug className="h-5 w-5" />}
                        </span>
                        <h3 className="text-base font-medium">{query.trim() ? t("workspace.connections.emptySearchTitle") : t("workspace.connections.emptyTitle")}</h3>
                        <p className="mt-1.5 max-w-xs text-xs leading-5 text-muted-foreground">
                          {query.trim() ? t("workspace.connections.emptySearchDescription", { query }) : t("workspace.connections.emptyDescription")}
                        </p>
                        <Button variant="outline" size="sm" className="mt-5 rounded-full px-4" onClick={() => { setQuery(""); setTab("explore"); }}>
                          {query.trim() ? t("workspace.clearSearch") : t("workspace.connections.exploreCta")}
                          <LuArrowRight className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2" data-testid="connector-grid">
                        {connected.slice(0, limit).map((server, index) => (
                          <ConnectorCard
                            key={server.uuid}
                            connector={catalogByName.get(server.name)}
                            server={server}
                            animationIndex={index % pageSize}
                            onClick={() => setSelection({ connector: catalogByName.get(server.name) || null, server })}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </section>
              )}

              {/* Explore Tab */}
              {tab === "explore" && (
                <section aria-label={t("workspace.directoryAriaLabel")} className="connectors-enter" style={{ animationDelay: "220ms" }}>
                  {query.trim() ? (
                    /* Search results view */
                    <div>
                      <div className="mb-3.5 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <h2 className="text-base font-semibold tracking-tight">{t("workspace.searchResults")}</h2>
                          <span aria-live="polite" className="rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
                            {searchResults.length}
                          </span>
                          <button type="button" onClick={() => setQuery("")} className="ml-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">
                            {t("workspace.clearSearch")}
                          </button>
                        </div>
                      </div>
                      {searchResults.length === 0 ? (
                        <div className="flex flex-col items-center rounded-2xl border border-border/70 bg-card/60 px-5 py-16 text-center dark:bg-white/[0.02]">
                          <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-border/60 bg-muted/50 text-muted-foreground">
                            <LuSearch className="h-5 w-5" />
                          </span>
                          <h3 className="text-base font-medium">{t("workspace.empty.noConnectorsTitle")}</h3>
                          <p className="mt-1.5 max-w-xs text-xs leading-5 text-muted-foreground">
                            {t("workspace.empty.noSearchDescription")}
                          </p>
                          <Button variant="outline" size="sm" className="mt-5 rounded-full px-4" onClick={() => setQuery("")}>
                            {t("workspace.clearSearch")}
                          </Button>
                        </div>
                      ) : (
                        <>
                          <div className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2" data-testid="connector-grid">
                            {searchResults.slice(0, limit).map((connector, index) => (
                              <ConnectorCard
                                key={connector.id}
                                connector={connector}
                                animationIndex={index % pageSize}
                                server={serverByName.get(connectorServerName(connector))}
                                onClick={() => openConnector(connector)}
                              />
                            ))}
                          </div>
                          {searchResults.length > 0 && (
                            <div className="mt-8 flex flex-col items-center gap-3">
                              <span className="text-[11px] text-muted-foreground">{t("workspace.showingCount", { shown: Math.min(limit, searchResults.length), total: searchResults.length })}</span>
                              {limit < searchResults.length && (
                                <Button variant="outline" size="sm" onClick={() => setLimit((value) => value + pageSize)} className="h-9 rounded-full border-border/80 bg-card/80 px-5 text-xs hover:border-primary/40 dark:bg-white/[0.03]">
                                  {t("workspace.showMore")}<LuChevronDown className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  ) : sort === "name" ? (
                    /* Alphabetical full directory view */
                    <div>
                      <div className="mb-3.5 flex items-center gap-2">
                        <h2 className="text-base font-semibold tracking-tight">{t("workspace.allConnectors")}</h2>
                        <span aria-live="polite" className="rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
                          {alphabeticalAll.length}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2" data-testid="connector-grid">
                        {alphabeticalAll.slice(0, limit).map((connector, index) => (
                          <ConnectorCard
                            key={connector.id}
                            connector={connector}
                            animationIndex={index % pageSize}
                            server={serverByName.get(connectorServerName(connector))}
                            onClick={() => openConnector(connector)}
                          />
                        ))}
                      </div>
                      <div className="mt-8 flex flex-col items-center gap-3">
                        <span className="text-[11px] text-muted-foreground">{t("workspace.showingCount", { shown: Math.min(limit, alphabeticalAll.length), total: alphabeticalAll.length })}</span>
                        {limit < alphabeticalAll.length && (
                          <Button variant="outline" size="sm" onClick={() => setLimit((value) => value + pageSize)} className="h-9 rounded-full border-border/80 bg-card/80 px-5 text-xs hover:border-primary/40 dark:bg-white/[0.03]">
                            {t("workspace.showMore")}<LuChevronDown className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ) : (
                    /* Curated & Category Sections View */
                    <div className="space-y-9" data-testid="connector-grid">
                      {/* Popular Section */}
                      <div>
                        <div className="mb-3 flex items-center justify-between">
                          <button
                            type="button"
                            onClick={() => openCategory("Popular")}
                            aria-label={t("workspace.browseCategoryAria", { category: connectorCategoryLabel("Popular") })}
                            className="group -ml-1 flex items-center gap-1.5 rounded-lg py-0.5 pl-1 pr-2 text-left text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                          >
                            <h2 className="text-base font-semibold tracking-tight">{connectorCategoryLabel("Popular")}</h2>
                            <LuChevronRight aria-hidden="true" className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                          </button>
                          <button
                            type="button"
                            onClick={() => openCategory("Popular")}
                            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                          >
                            {t("workspace.seeAll", { count: popularConnectors.length })}
                          </button>
                        </div>
                        <div className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2">
                          {popularConnectors.slice(0, 6).map((connector, index) => (
                            <ConnectorCard
                              key={connector.id}
                              connector={connector}
                              animationIndex={index}
                              server={serverByName.get(connectorServerName(connector))}
                              onClick={() => openConnector(connector)}
                            />
                          ))}
                        </div>
                      </div>

                      {/* New & Noteworthy Section */}
                      <div>
                        <div className="mb-3 flex items-center justify-between">
                          <button
                            type="button"
                            onClick={() => openCategory("New & Noteworthy")}
                            aria-label={t("workspace.browseCategoryAria", { category: connectorCategoryLabel("New & Noteworthy") })}
                            className="group -ml-1 flex items-center gap-1.5 rounded-lg py-0.5 pl-1 pr-2 text-left text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                          >
                            <h2 className="text-base font-semibold tracking-tight">{connectorCategoryLabel("New & Noteworthy")}</h2>
                            <LuChevronRight aria-hidden="true" className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                          </button>
                          <button
                            type="button"
                            onClick={() => openCategory("New & Noteworthy")}
                            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                          >
                            {t("workspace.seeAll", { count: noteworthyConnectors.length })}
                          </button>
                        </div>
                        <div className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2">
                          {noteworthyConnectors.slice(0, 6).map((connector, index) => (
                            <ConnectorCard
                              key={connector.id}
                              connector={connector}
                              animationIndex={index + 6}
                              server={serverByName.get(connectorServerName(connector))}
                              onClick={() => openConnector(connector)}
                            />
                          ))}
                        </div>
                      </div>

                      {/* Category Sections */}
                      {connectorCategories.filter((cat) => connectors.some((c) => c.category === cat)).map((cat) => {
                        const items = connectors.filter((c) => c.category === cat).sort((a, b) => compareFeatured(a, b, locale));
                        const catLabel = connectorCategoryLabel(cat);
                        return (
                          <div key={cat}>
                            <div className="mb-3 flex items-center justify-between">
                              <button
                                type="button"
                                onClick={() => openCategory(cat)}
                                aria-label={t("workspace.browseCategoryAria", { category: catLabel })}
                                className="group -ml-1 flex items-center gap-1.5 rounded-lg py-0.5 pl-1 pr-2 text-left text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                              >
                                <h2 className="text-base font-semibold tracking-tight">{catLabel}</h2>
                                <LuChevronRight aria-hidden="true" className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                              </button>
                              <button
                                type="button"
                                onClick={() => openCategory(cat)}
                                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                              >
                                {t("workspace.seeAll", { count: items.length })}
                              </button>
                            </div>
                            <div className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2">
                              {items.slice(0, 4).map((connector, index) => (
                                <ConnectorCard
                                  key={connector.id}
                                  connector={connector}
                                  animationIndex={index}
                                  server={serverByName.get(connectorServerName(connector))}
                                  onClick={() => openConnector(connector)}
                                />
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              )}
            </>
          )}

          <footer className="mt-12 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-5 text-[10px] leading-5 text-muted-foreground">
            <span>{t("workspace.footerCatalog", { count: connectors.length, date: formattedCatalogDate })}</span>
            <span className="inline-flex items-center gap-4">
              <a href="https://registry.modelcontextprotocol.io" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">{t("workspace.mcpRegistry")}</a>
            </span>
          </footer>
        </div>
      </div>

      {selection && (
        <ConnectorDialog
          key={`${selection.connector?.id || "custom"}:${selection.server?.uuid || "new"}`}
          connector={selection.connector}
          server={selection.server}
          onClose={() => setSelection(null)}
          onCustom={() => setSelection({ connector: null })}
          onSaved={updateServer}
          onRemoved={(uuid) => setServers((current) => current.filter((server) => server.uuid !== uuid))}
        />
      )}
    </section>
  );
}

function ConnectorCard({ connector, server, animationIndex = 0, onClick }: { connector?: Connector; server?: ConnectorServer; animationIndex?: number; onClick: () => void }) {
  const { t } = useTranslation("connectors");
  const connected = Boolean(server?.enabled && (server.oauth_connected || server.tools.length));
  const setupOnly = Boolean(connector && !connectorCanConnect(connector) && !server);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("card.configureAria", { name: connector?.name || server?.name || "" })}
      style={{ animationDelay: `${Math.min(animationIndex, 6) * 35}ms` }}
      className="connectors-card-enter group flex min-w-0 items-center gap-3.5 rounded-2xl border border-transparent bg-card/40 px-3 py-2.5 text-left transition-all duration-200 hover:border-border/80 hover:bg-card hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 dark:bg-white/[0.015] dark:hover:border-white/10 dark:hover:bg-white/[0.04]"
    >
      <ConnectorIcon connector={connector} className="h-11 w-11 rounded-xl shadow-none" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground" title={connector?.name || server?.name}>
            {connector?.name || server?.name}
          </span>
          {connected && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              <LuCheck aria-label={t("card.connected")} className="h-3 w-3 shrink-0" />
              <span>{t("card.connected")}</span>
            </span>
          )}
          {!connected && server && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{t("card.configured")}</span>
          )}
        </span>
        <span className="mt-0.5 line-clamp-1 text-[13px] leading-relaxed text-muted-foreground">
          {connector?.description || t("card.customDescription")}
        </span>
        <span className="sr-only">
          {connector ? connectorCategoryLabel(connector.category) : connectorCategoryLabel("Custom")}
          {setupOnly ? ` · ${t("card.providerSetup")}` : ""}
        </span>
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors",
          connected
            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : "text-muted-foreground group-hover:bg-muted group-hover:text-foreground dark:group-hover:bg-white/10"
        )}
      >
        {connected ? (
          <LuCheck className="h-4 w-4" />
        ) : setupOnly ? (
          <LuInfo className="h-4 w-4" />
        ) : (
          <LuPlus className="h-4 w-4" />
        )}
      </span>
    </button>
  );
}

function ConnectorConstellation() {
  const ids = ["com.notion/mcp", "io.github.github/github-mcp-server", "com.figma.mcp/mcp", "app.linear/linear", "com.canva.mcp/mcp", "com.stripe/mcp"];
  return (
    <div aria-hidden="true" className="pointer-events-none hidden shrink-0 grid-cols-3 gap-2.5 pr-1 lg:grid">
      {ids.map((id, index) => (
        <span
          key={id}
          className="connectors-orbit-enter"
          style={{
            "--orbit-delay": `${140 + index * 75}ms`,
            "--orbit-x": `${(1 - index % 3) * 22}px`,
            "--orbit-y": `${index < 3 ? 14 : -14}px`,
            "--orbit-tilt": `${index % 2 ? 6 : -6}deg`,
            "--float-delay": `${900 + index * 100}ms`,
            "--float-duration": `${5 + index * 0.4}s`,
          } as CSSProperties}
        >
          <span className="connectors-orbit-float inline-flex">
            <ConnectorIcon connector={connectors.find((connector) => connector.id === id)} className="h-9 w-9 rounded-xl border-border/50 shadow-none" />
          </span>
        </span>
      ))}
    </div>
  );
}

export default function ConnectorsPage() {
  const { t } = useTranslation("connectors");
  const user = useAuthStore((state) => state.user);
  if (!user) {
    return (
      <>
        <SEO
          title={t("seo.landingTitle")}
          description={t("seo.landingDescription")}
          canonical="https://neuronrunner.com/integrations"
        />
        <ConnectorsLandingPage />
      </>
    );
  }
  return (
    <>
      <SEO
        title={t("seo.workspaceTitle")}
        noindex={true}
      />
      <ConnectorsWorkspaceView />
    </>
  );
}
