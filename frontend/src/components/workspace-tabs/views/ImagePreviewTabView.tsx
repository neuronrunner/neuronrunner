"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuDownload, LuImage, LuLoaderCircle, LuMinus, LuPlus, LuRefreshCw } from "react-icons/lu";
import useSandboxProjectsStore from "@/stores/sandbox-projects";
import useWorkspaceTabsStore, { type IWorkspaceTab } from "@/stores/workspace-tabs";
import { Button } from "@/components/ui/button";
import { imagePreviewLayout, type ImageViewport } from "@/lib/image-preview-layout";

export function ImagePreviewTabView({ tab }: { tab: IWorkspaceTab }) {
  const { t } = useTranslation("workspace");
  const workspaceUuid = useSandboxProjectsStore(state => state.workspaceSandbox?.uuid);
  const fetchContent = useSandboxProjectsStore(state => state.fetchFileFullContent);
  const setContentLoaded = useWorkspaceTabsStore(state => state.setTabContentLoaded);
  const stageRef = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<ImageViewport>({ width: 0, height: 0, pixelRatio: 1, left: 0, top: 0 });
  const [zoom, setZoom] = useState<number | "fit">("fit");

  const measureViewport = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    setViewport({ width: stage.clientWidth, height: stage.clientHeight, pixelRatio: window.devicePixelRatio || 1, left: rect.left + stage.clientLeft, top: rect.top + stage.clientTop });
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let pending: ReturnType<typeof setTimeout>;
    // Wait for panel motion to settle rather than resampling the image every frame.
    const update = () => { clearTimeout(pending); pending = setTimeout(measureViewport, 100); };
    measureViewport();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    window.addEventListener("resize", update);
    return () => { clearTimeout(pending); observer.disconnect(); window.removeEventListener("resize", update); };
  }, [measureViewport]);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setSource(null);
    setLoading(true);
    setError(null);
    setDimensions({ width: 0, height: 0 });
    setZoom("fit");
    const load = async () => {
      try {
        if (!workspaceUuid || !tab.fileUuid) throw new Error(t("imageView.selectWorkspace"));
        const data = await fetchContent(workspaceUuid, tab.fileUuid);
        if (cancelled) return;
        if (!data) throw new Error(useSandboxProjectsStore.getState().errorMessage || t("imageView.loadFailed"));
        if (!data.isBinary || !data.content) throw new Error(t("imageView.invalidImage"));
        const bytes = Uint8Array.from(atob(data.content), character => character.charCodeAt(0));
        const mime = (tab.filePath || tab.title).toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
        setContentLoaded(tab.id, data.content, true);
        setSource(objectUrl);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t("imageView.loadFailed"));
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [tab.id, tab.fileUuid, tab.filePath, tab.title, workspaceUuid, fetchContent, setContentLoaded, reloadVersion, t]);

  const layout = imagePreviewLayout(dimensions, viewport, zoom);
  const { scale, width: imageWidth, height: imageHeight } = layout;
  const ready = !!source && !loading && !error;
  const changeZoom = (factor: number) => setZoom(Math.min(4, Math.max(0.1, scale * factor)));
  const reload = () => setReloadVersion(previous => previous + 1);
  const download = () => {
    if (!source) return;
    const link = document.createElement("a");
    link.href = source;
    link.download = tab.title;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background" data-image-preview>
      <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/50 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <LuImage className="h-3.5 w-3.5 shrink-0 text-violet-400" />
          <span>{t("imageView.title")}</span>
          {ready && <span className="text-[11px] tabular-nums">{dimensions.width} × {dimensions.height}</span>}
        </div>
        <div className="flex items-center gap-1">
          <Button size="xs" variant={zoom === "fit" ? "secondary" : "ghost"} disabled={!ready} onClick={() => setZoom("fit")} aria-label={t("imageView.fitAria")} className="h-6 px-2 text-xs">{t("imageView.fit")}</Button>
          <Button size="xs" variant="ghost" disabled={!ready || scale <= 0.1} onClick={() => changeZoom(1 / 1.25)} aria-label={t("imageView.zoomOutAria")} className="h-6 w-6 p-0"><LuMinus className="h-3.5 w-3.5" /></Button>
          <button type="button" disabled={!ready} onClick={() => setZoom(1)} aria-label={t("imageView.actualSizeAria")} title={t("imageView.actualSizeTitle")} className="h-6 min-w-10 rounded px-1 text-[11px] tabular-nums text-muted-foreground hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">{Math.round(scale * 100)}%</button>
          <Button size="xs" variant="ghost" disabled={!ready || scale >= 4} onClick={() => changeZoom(1.25)} aria-label={t("imageView.zoomInAria")} className="h-6 w-6 p-0"><LuPlus className="h-3.5 w-3.5" /></Button>
          <span className="mx-1 h-3.5 w-px bg-border/60" />
          <Button size="xs" variant="ghost" disabled={loading} onClick={reload} aria-label={t("imageView.reloadAria")} className="h-6 w-6 p-0"><LuRefreshCw className="h-3.5 w-3.5" /></Button>
          <Button size="xs" variant="ghost" disabled={!ready} onClick={download} aria-label={t("imageView.downloadAria")} className="h-6 w-6 p-0"><LuDownload className="h-3.5 w-3.5" /></Button>
        </div>
      </div>
      <div ref={stageRef} className={`relative min-h-0 flex-1 bg-muted/10 ${zoom === "fit" ? "overflow-hidden" : "overflow-auto"}`} aria-busy={loading} data-image-stage>
        {loading && <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background/80 text-xs text-muted-foreground" role="status"><LuLoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t("imageView.loading")}</div>}
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center" role="alert">
            <LuImage className="h-8 w-8 text-muted-foreground" />
            <p className="max-w-md text-sm text-muted-foreground">{error}</p>
            <Button size="xs" variant="outline" onClick={reload} className="gap-1.5"><LuRefreshCw className="h-3 w-3" />{t("common.retry")}</Button>
          </div>
        ) : source && (
          <div className="relative" style={{ width: zoom === "fit" || layout.canvasWidth <= viewport.width ? "100%" : layout.canvasWidth, height: zoom === "fit" || layout.canvasHeight <= viewport.height ? "100%" : layout.canvasHeight }}>
            <div className="absolute overflow-hidden rounded-sm shadow-sm" style={{ left: layout.left, top: layout.top, backgroundColor: "var(--background)", backgroundImage: "linear-gradient(45deg, rgba(128,128,128,.15) 25%, transparent 25%, transparent 75%, rgba(128,128,128,.15) 75%), linear-gradient(45deg, rgba(128,128,128,.15) 25%, transparent 25%, transparent 75%, rgba(128,128,128,.15) 75%)", backgroundSize: "20px 20px", backgroundPosition: "0 0, 10px 10px" }}>
              {/* Native image decoding supports the authenticated binary blob and its intrinsic dimensions. */}
              <img src={source} alt={tab.title} draggable={false} className="block max-w-none" style={{ width: imageWidth || undefined, height: imageHeight || undefined, opacity: loading ? 0 : 1 }}
                onLoad={event => { measureViewport(); setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); setLoading(false); }}
                onError={() => { setError(t("imageView.displayFailed")); setLoading(false); }} />
            </div>
          </div>
        )}
      </div>
      <div className="shrink-0 truncate border-t border-border/40 px-3 py-1.5 text-[10px] text-muted-foreground" title={tab.filePath}>{tab.filePath || tab.title}</div>
    </div>
  );
}
