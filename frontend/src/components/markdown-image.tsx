"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import ImageLightbox from "@/components/image-lightbox";
import { authedAxios, API_BASE } from "@/lib/axios";
import useSandboxProjectsStore from "@/stores/sandbox-projects";

export default function MarkdownImage({ source, alt, title, linked = false, thumbnail = false }: { source: string; alt?: string; title?: string; linked?: boolean; gallery?: boolean; thumbnail?: boolean }) {
  const { t } = useTranslation("chat");
  const workspaceUuid = useSandboxProjectsStore(state => state.workspaceSandbox?.uuid);
  const projectPath = useSandboxProjectsStore(state => state.currentSandbox?.filesystem_path || "/workspace");
  const local = !/^(https?:\/\/|data:image\/|blob:|\/\/)/i.test(source);
  const [loaded, setLoaded] = useState<{ key: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const key = `${workspaceUuid}:${projectPath}:${source}`;
  const url = local ? loaded?.key === key ? loaded.url : "" : source.startsWith("//") ? `https:${source}` : source;

  useEffect(() => {
    setError(null);
    setExpanded(false);
    if (!local) return;
    if (!workspaceUuid) { setError(t("markdownImage.selectWorkspace")); return; }
    const controller = new AbortController();
    let decoded = source;
    try { decoded = decodeURIComponent(source); } catch { /* Keep literal percent characters in filenames. */ }
    const path = decoded.startsWith("/") ? decoded : `${projectPath.replace(/\/$/, "")}/${decoded}`;
    void authedAxios.get(`${API_BASE}/sandbox/sandboxes/${workspaceUuid}/image-preview/`, { params: { path }, signal: controller.signal })
      .then(({ data }) => { if (!controller.signal.aborted) setLoaded({ key, url: data.content_url }); })
      .catch(error => { if (!controller.signal.aborted) setError(error.response?.data?.error || t("markdownImage.loadFailed")); });
    return () => controller.abort();
  }, [source, local, workspaceUuid, projectPath, key, attempt, t]);

  const image = url && <img src={url} alt={alt || t("markdownImage.imageFallback")} title={title} className="block h-full w-full object-cover" onLoad={event => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setError(t("markdownImage.loadFailed"))} />;
  return <span className={`block aspect-square min-w-0 max-w-full overflow-hidden rounded-xl bg-muted/30 ${thumbnail ? "w-40" : "w-64"}`} data-markdown-image>
    {error ? <span role="alert" className="block h-full overflow-auto p-3 text-xs text-muted-foreground">{alt || t("markdownImage.imageFallback")}: {error} {local && <button type="button" className="underline" onClick={() => setAttempt(value => value + 1)}>{t("markdownImage.retry")}</button>}</span>
      : !url ? <span role="status" className="block h-full animate-pulse bg-muted" aria-label={t("markdownImage.loading")} />
        : linked ? image : <button type="button" className="block h-full w-full cursor-zoom-in" aria-label={t("markdownImage.expand", { alt: alt || t("markdownImage.imageLowercase") })} onClick={() => setExpanded(true)}>
          {image}
        </button>}
    <ImageLightbox
      open={expanded}
      onClose={() => setExpanded(false)}
      images={url ? [{ uuid: key, image_uuid: key, image_url: url, prompt: title || alt || t("markdownImage.imageFallback"), negative_prompt: "", width: dimensions.width, height: dimensions.height, seed: null, created_at: "" }] : []}
    />
  </span>;
}
