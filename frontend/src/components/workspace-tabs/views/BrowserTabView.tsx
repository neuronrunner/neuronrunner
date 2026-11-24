"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuArrowLeft, LuArrowRight, LuArrowUpRight, LuCheck, LuCircleAlert, LuCopy, LuExternalLink, LuGlobe, LuLoaderCircle, LuRefreshCw, LuSearch, LuShieldCheck, LuTerminal, LuX } from "react-icons/lu";
import { API_BASE, authedAxios } from "@/lib/axios";
import { parsePreviewAddress, previewError, RESERVED_WORKSPACE_PORTS } from "@/lib/browser-preview";
import useSandboxProjectsStore from "@/stores/sandbox-projects";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Page = { address: string; url: string; workspacePort?: number };

export function BrowserTabView({ isActive = true }: { isActive?: boolean }) {
  const { t } = useTranslation("workspace");
  const shortcuts = [
    { port: 3000, name: t("browserView.shortcuts.webAppName"), description: t("browserView.shortcuts.webAppDesc") },
    { port: 5173, name: t("browserView.shortcuts.viteAppName"), description: t("browserView.shortcuts.viteAppDesc") },
    { port: 8000, name: t("browserView.shortcuts.djangoAppName"), description: t("browserView.shortcuts.djangoAppDesc") },
    { port: 8080, name: t("browserView.shortcuts.localServerName"), description: t("browserView.shortcuts.localServerDesc") },
  ];
  const workspaceUuid = useSandboxProjectsStore(state => state.workspaceSandbox?.uuid);
  const [address, setAddress] = useState("http://localhost:3000");
  const [history, setHistory] = useState<Page[]>([]);
  const [index, setIndex] = useState(-1);
  const [ports, setPorts] = useState<number[]>([]);
  const [portsScanned, setPortsScanned] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [reload, setReload] = useState(0);
  const navigation = useRef(0);
  const discovery = useRef(0);
  const page = history[index];

  useEffect(() => {
    navigation.current += 1;
    discovery.current += 1;
    setHistory([]); setIndex(-1); setPorts([]); setDiscovering(false); setBusy(false); setLoading(false); setError("");
    setPortsScanned(false);
    setAddress("http://localhost:3000");
  }, [workspaceUuid]);

  useEffect(() => () => { navigation.current += 1; discovery.current += 1; }, []);

  useEffect(() => {
    if (!isActive || !page?.workspacePort || !workspaceUuid) return;
    const ping = () => {
      if (document.visibilityState === "visible") {
        void authedAxios.post(`${API_BASE}/sandbox/sandboxes/${workspaceUuid}/ping/`).catch(() => {});
      }
    };
    const timer = window.setInterval(ping, 45000);
    document.addEventListener("visibilitychange", ping);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", ping); };
  }, [isActive, page?.workspacePort, workspaceUuid]);

  // Loading is advisory: cross-origin pages do not expose HTTP errors to an iframe.
  useEffect(() => {
    if (!loading) return;
    const timer = window.setTimeout(() => setLoading(false), 15000);
    return () => window.clearTimeout(timer);
  }, [loading, reload, page?.url]);

  const navigate = async (nextAddress: string) => {
    const attempt = ++navigation.current;
    setBusy(true); setError(""); setCopied(false);
    try {
      const target = parsePreviewAddress(nextAddress);
      let nextPage: Page;
      if (target.kind === "workspace") {
        if (!workspaceUuid) throw new Error(t("browserView.selectWorkspaceBeforeLocalhost"));
        const { data } = await authedAxios.post(`${API_BASE}/sandbox/sandboxes/${workspaceUuid}/port-preview/`, { port: target.port, path: target.path });
        nextPage = { address: `http://localhost:${target.port}${target.path}`, url: data.url, workspacePort: target.port };
      } else {
        const origin = new URL(target.url).origin;
        if ([window.location.origin, new URL(API_BASE || window.location.origin, window.location.origin).origin].includes(origin)) {
          throw new Error(t("browserView.openMainAppSeparateTab"));
        }
        nextPage = { address: target.url, url: target.url };
      }
      if (attempt !== navigation.current) return;
      setHistory([...history.slice(0, index + 1), nextPage]);
      setIndex(index + 1); setAddress(nextPage.address); setLoading(true); setReload(value => value + 1);
    } catch (failure) {
      if (attempt === navigation.current) setError(previewError(failure));
    } finally {
      if (attempt === navigation.current) setBusy(false);
    }
  };

  const discoverPorts = useCallback(async () => {
    if (!workspaceUuid) return;
    const attempt = ++discovery.current;
    const workspace = workspaceUuid;
    setError(""); setDiscovering(true);
    try {
      const { data } = await authedAxios.get(`${API_BASE}/sandbox/sandboxes/${workspace}/port-preview/`);
      if (attempt === discovery.current && useSandboxProjectsStore.getState().workspaceSandbox?.uuid === workspace) {
        const rawPorts = Array.isArray(data.ports) ? data.ports : [];
        const validPorts = rawPorts.filter((port: number) => typeof port === "number" && !RESERVED_WORKSPACE_PORTS.has(port));
        setPorts(validPorts); setPortsScanned(true);
      }
    } catch (failure) {
      if (attempt === discovery.current && useSandboxProjectsStore.getState().workspaceSandbox?.uuid === workspace) setError(previewError(failure));
    } finally {
      if (attempt === discovery.current && useSandboxProjectsStore.getState().workspaceSandbox?.uuid === workspace) setDiscovering(false);
    }
  }, [workspaceUuid]);

  useEffect(() => {
    if (isActive) void discoverPorts();
  }, [isActive, discoverPorts]);

  const move = (nextIndex: number) => {
    navigation.current += 1; setBusy(false); setIndex(nextIndex); setAddress(history[nextIndex].address);
    setError(""); setLoading(true); setCopied(false);
  };

  const submit = (event: FormEvent) => { event.preventDefault(); void navigate(address); };

  const revokeAccess = async () => {
    if (!page?.workspacePort || !workspaceUuid) return;
    if (!window.confirm(t("browserView.revokeConfirm", { port: page.workspacePort }))) return;
    const attempt = ++navigation.current;
    setBusy(true); setError("");
    try {
      await authedAxios.delete(`${API_BASE}/sandbox/sandboxes/${workspaceUuid}/port-preview/`, { data: { port: page.workspacePort } });
      if (attempt !== navigation.current) return;
      const remaining = history.filter(entry => entry.workspacePort !== page.workspacePort);
      setHistory(remaining); setIndex(remaining.length - 1); setLoading(false);
      setAddress(remaining.at(-1)?.address || "http://localhost:3000");
    } catch (failure) {
      if (attempt === navigation.current) setError(previewError(failure));
    } finally {
      if (attempt === navigation.current) setBusy(false);
    }
  };

  return (
    <section aria-label={t("browserView.ariaLabel")} className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <header className="workspace-tool-header">
        <form onSubmit={submit} className="workspace-tool-toolbar">
          <div className="flex shrink-0 items-center gap-0.5">
            <Button type="button" variant="ghost" size="icon" className="workspace-tool-icon-button" aria-label={t("browserView.back")} title={t("browserView.back")} disabled={busy || index <= 0} onClick={() => move(index - 1)}><LuArrowLeft className="h-3.5 w-3.5" /></Button>
            <Button type="button" variant="ghost" size="icon" className="workspace-tool-icon-button" aria-label={t("browserView.forward")} title={t("browserView.forward")} disabled={busy || index >= history.length - 1} onClick={() => move(index + 1)}><LuArrowRight className="h-3.5 w-3.5" /></Button>
            <Button type="button" variant="ghost" size="icon" className="workspace-tool-icon-button" aria-label={t("browserView.reloadPage")} title={t("browserView.reloadPage")} disabled={!page || busy} onClick={() => { setLoading(true); setReload(value => value + 1); }}>{loading ? <LuLoaderCircle className="h-3.5 w-3.5 motion-safe:animate-spin" /> : <LuRefreshCw className="h-3.5 w-3.5" />}</Button>
          </div>
          <div className="workspace-tool-field ml-1 flex-1 transition-colors focus-within:ring-1 focus-within:ring-ring">
            {page?.workspacePort ? <LuShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" /> : <LuGlobe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
            <input aria-label={t("browserView.addressAria")} value={address} onChange={event => setAddress(event.target.value)} onFocus={event => event.target.select()} placeholder={t("browserView.addressPlaceholder")} autoComplete="off" spellCheck={false} className="h-full min-w-0 flex-1 bg-transparent font-mono text-[11px] text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground focus-visible:outline-none" />
            <button type="submit" aria-label={t("browserView.openAddress")} title={t("browserView.openAddress")} disabled={busy || !address.trim()} className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-primary/10 text-primary transition-colors hover:bg-primary/20 disabled:opacity-40">
              {busy ? <LuLoaderCircle className="h-3.5 w-3.5 motion-safe:animate-spin" /> : <LuArrowRight className="h-3.5 w-3.5" />}
            </button>
          </div>
          {page && <a href={page.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" title={t("browserView.openInNewTab")} aria-label={t("browserView.openInNewTab")} className="workspace-tool-icon-button ml-1"><LuExternalLink className="h-3.5 w-3.5" /></a>}
        </form>
        <div className="flex min-w-0 items-center gap-2 px-2 pb-1 text-[11px] text-muted-foreground">
          <Button type="button" variant="ghost" size="xs" className="h-5 shrink-0 gap-1 rounded px-1.5 text-[11px]" disabled={!workspaceUuid || discovering} onClick={() => void discoverPorts()}>
            {discovering ? <LuLoaderCircle className="h-3 w-3 motion-safe:animate-spin" /> : <LuSearch className="h-3 w-3" />}
            {discovering ? t("browserView.findingApps") : t("browserView.findApps")}
          </Button>
          <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
            {ports.length ? ports.map(port => <button key={port} type="button" disabled={busy} aria-label={t("browserView.openPortAria", { port })} aria-pressed={page?.workspacePort === port} onClick={() => void navigate(`http://localhost:${port}`)} className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded border px-1.5 font-mono text-[10px] transition-colors disabled:opacity-50", page?.workspacePort === port ? "border-primary/20 bg-primary/10 text-primary" : "border-border/60 bg-background hover:border-primary/30 hover:text-foreground")}>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />{port}
            </button>) : <span className="truncate">{workspaceUuid ? (portsScanned ? t("browserView.noRunningServers") : t("browserView.discoverServers")) : t("browserView.selectWorkspacePreview")}</span>}
          </div>
        </div>
        {(busy || loading) && <div role="status" aria-label={busy ? t("browserView.openingPreview") : t("browserView.loadingPage")} className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-primary/10"><div className="h-full w-2/3 rounded-full bg-gradient-to-r from-transparent via-primary to-transparent motion-safe:animate-pulse" /></div>}
      </header>
      {error && <div role="alert" className="m-3 flex shrink-0 items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">
        <LuCircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /><p className="min-w-0 flex-1 break-words leading-relaxed">{error}</p>
        <button type="button" aria-label={t("browserView.dismissError")} onClick={() => setError("")} className="shrink-0 rounded p-0.5 transition-colors hover:bg-destructive/10"><LuX className="h-3.5 w-3.5" /></button>
      </div>}
      {page ? (
        <div className="relative min-h-0 flex-1 bg-background" aria-busy={loading}>
          <iframe key={`${workspaceUuid}-${index}-${reload}`} src={page.url} title={t("browserView.iframeTitle")} referrerPolicy="no-referrer" sandbox={page.workspacePort ? "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads" : "allow-scripts allow-forms allow-popups allow-downloads"} className="h-full w-full border-0" onLoad={() => setLoading(false)} />
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="workspace-tool-empty">
            <div aria-hidden="true" className="workspace-tool-empty-icon"><LuGlobe className="h-5 w-5" /></div>
            <h2 className="workspace-tool-empty-title">{t("browserView.emptyTitle")}</h2>
            <p className="workspace-tool-empty-description">{t("browserView.emptyDescription")}</p>
            <div className="mt-4 w-full max-w-sm">
              <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{t("browserView.quickStart")}</p>
              <div className="grid grid-cols-2 gap-1.5">
                {shortcuts.map(({ port, name, description }) => <button key={port} type="button" title={description} disabled={busy || !workspaceUuid} onClick={() => void navigate(`http://localhost:${port}`)} className="group flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-border/60 bg-card/50 px-2 text-left transition-colors hover:border-primary/30 hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-45">
                  <LuTerminal className="h-3 w-3 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">{name}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">:{port}</span>
                  <LuArrowUpRight className="h-3 w-3 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-primary" />
                </button>)}
              </div>
            </div>
            <p className="mt-3 max-w-xs text-center text-[11px] leading-relaxed text-muted-foreground">{workspaceUuid ? t("browserView.enterHttpsHint") : t("browserView.selectWorkspaceLaunch")}</p>
          </div>
        </div>
      )}
      <footer className="workspace-tool-footer">
        {page?.workspacePort ? <>
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <span className="inline-flex items-center gap-1.5"><LuShieldCheck className="h-3 w-3 text-emerald-600 dark:text-emerald-400" /><span>{t("browserView.httpsPreview")} <span className="mx-1 text-muted-foreground/40">/</span><span className="font-mono">:{page.workspacePort}</span></span></span>
            <div className="flex items-center gap-2">
              <button type="button" aria-label={t("browserView.copyAccessLink")} title={t("browserView.copyAccessLink")} className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-muted hover:text-foreground" onClick={async () => {
                try { await navigator.clipboard.writeText(page.url); setCopied(true); }
                catch { setError(t("browserView.copyLinkError")); }
              }}>{copied ? <LuCheck className="h-3 w-3 text-emerald-500" /> : <LuCopy className="h-3 w-3" />}<span role="status">{copied ? t("common.copied") : t("common.copyLink")}</span></button>
              <button type="button" disabled={busy} onClick={() => void revokeAccess()} aria-label={t("browserView.revokePortAccess")} title={t("browserView.revokePortAccessTitle")} className="rounded px-1 py-0.5 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50">{t("common.revoke")}</button>
            </div>
          </div>
          <p className="mt-0.5 leading-relaxed">{t("browserView.linkAccessNotice")}</p>
        </> : <p className="flex items-start gap-1.5 leading-relaxed"><LuGlobe className="mt-0.5 h-3 w-3 shrink-0" /><span>{page ? t("browserView.embedBlockedNotice") : t("browserView.httpsNotice")}</span></p>}
      </footer>
    </section>
  );
}
