"use client";

import { useState, useCallback, useMemo, type FC } from "react";
import { useTranslation } from "react-i18next";
import {
  LuImage,
  LuVideo,
  LuMusic,
  LuCode,
  LuFileText,
  LuDownload,
  LuExternalLink,
  LuCopy,
  LuCheck,
  LuMaximize2,
  LuInfo,
  LuX,
} from "react-icons/lu";
import { toaster } from "@/components/ui/toaster";
import ImageLightbox from "@/components/image-lightbox";
import AnimatedCollapse from "@/components/chat/animated-collapse";

export interface ContentItem {
  content_url: string;
  mime?: string;
  size_bytes?: number;
  return_type?: "image" | "video" | "audio" | "code" | "text";
  execution_id?: string;
  cost_usd?: string;
  title?: string;
  duration_seconds?: number;
  prompt?: string;
  seed?: number;
  width?: number;
  height?: number;
}

interface ContentRendererProps {
  content: ContentItem | ContentItem[];
  onDismiss?: () => void;
}

const detectType = (
  mime?: string,
  hint?: string
): "image" | "video" | "audio" | "code" | "text" => {
  if (
    hint === "image" ||
    hint === "video" ||
    hint === "audio" ||
    hint === "code" ||
    hint === "text"
  ) {
    return hint;
  }
  if (!mime) return "image";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (
    mime === "application/octet-stream" ||
    mime.startsWith("text/x-") ||
    mime.startsWith("application/x-") ||
    mime.includes("json") ||
    mime.includes("javascript") ||
    mime.includes("python")
  ) {
    return "code";
  }
  return "text";
};

const formatBytes = (bytes?: number): string => {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

const formatDuration = (sec?: number): string => {
  if (sec == null || sec <= 0) return "";
  if (sec < 1) return `${Math.round(sec * 1000)}ms`;
  return `${sec.toFixed(1)}s`;
};

const formatCost = (cost?: string | number): string => {
  if (!cost) return "";
  const num = typeof cost === "string" ? parseFloat(cost) : cost;
  if (isNaN(num) || num <= 0) return "";
  if (num < 0.0001) return "<$0.0001";
  return `$${num.toFixed(4)}`;
};

export const normalizeMediaUrl = (url?: string): string => {
  if (!url) return "";
  const trimmed = url.trim();
  if (
    trimmed.startsWith("data:") ||
    trimmed.startsWith("blob:") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://")
  ) {
    return trimmed;
  }
  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`;
  }
  if (trimmed.includes(".") && !trimmed.startsWith("/")) {
    return `https://${trimmed}`;
  }
  return trimmed;
};

export const ToolOutputCard: FC<{
  item: ContentItem;
  onDismiss?: () => void;
}> = ({ item, onDismiss }) => {
  const { t } = useTranslation("chat");
  const [copied, setCopied] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const kind = detectType(item.mime, item.return_type);
  const url = normalizeMediaUrl(item.content_url || "");

  const handleCopyUrl = useCallback(async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toaster.create({
        title: t("contentRenderer.urlCopiedTitle"),
        description: t("contentRenderer.urlCopiedDescription"),
        type: "success",
        duration: 2000,
      });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toaster.create({
        title: t("contentRenderer.copyFailedTitle"),
        type: "error",
        duration: 2000,
      });
    }
  }, [url, t]);

  const handleDownload = useCallback(() => {
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    const imageExtensions: Record<string, string> = { "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/bmp": ".bmp", "image/avif": ".avif" };
    const ext = kind === "image" ? imageExtensions[item.mime || ""] || ".png" : kind === "video" ? ".mp4" : "";
    a.download = `output-${item.execution_id?.slice(0, 8) || Date.now()}${ext}`;
    a.target = "_blank";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [url, kind, item.execution_id, item.mime]);

  const lightboxImages = useMemo(() => {
    if (kind !== "image" || !url) return [];
    return [
      {
        uuid: item.execution_id || "generated-img",
        image_uuid: item.execution_id || "generated-img",
        image_url: url,
        prompt: item.prompt || item.title || t("contentRenderer.generatedImage"),
        negative_prompt: "",
        width: item.width || 1024,
        height: item.height || 1024,
        seed: item.seed ?? null,
        created_at: new Date().toISOString(),
      },
    ];
  }, [kind, url, item, t]);

  const typeConfig = useMemo(() => {
    switch (kind) {
      case "image":
        return {
          label: item.title || t("contentRenderer.types.image"),
          icon: LuImage,
          accentBg: "bg-zinc-500/15 dark:bg-zinc-500/20 text-zinc-200 dark:text-zinc-300",
        };
      case "video":
        return {
          label: item.title || t("contentRenderer.types.video"),
          icon: LuVideo,
          accentBg: "bg-fuchsia-500/10 dark:bg-fuchsia-500/20 text-fuchsia-600 dark:text-fuchsia-400",
        };
      case "audio":
        return {
          label: item.title || t("contentRenderer.types.audio"),
          icon: LuMusic,
          accentBg: "bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400",
        };
      case "code":
        return {
          label: item.title || t("contentRenderer.types.code"),
          icon: LuCode,
          accentBg: "bg-amber-500/10 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400",
        };
      default:
        return {
          label: item.title || t("contentRenderer.types.default"),
          icon: LuFileText,
          accentBg: "bg-zinc-500/15 dark:bg-zinc-500/20 text-zinc-200 dark:text-zinc-300",
        };
    }
  }, [kind, item.title, t]);

  const IconComp = typeConfig.icon;
  const formattedSize = formatBytes(item.size_bytes);
  const formattedDuration = formatDuration(item.duration_seconds);
  const formattedCost = formatCost(item.cost_usd);

  return (
    <div className="my-3 rounded-xl overflow-hidden relative isolate border border-slate-200/80 dark:border-white/10 bg-white dark:bg-[#121218]/85 backdrop-blur-md shadow-sm dark:shadow-[0_8px_32px_-4px_rgba(0,0,0,0.4)] transition-all max-w-full w-full">
      {/* Tool Header Bar */}
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-slate-200/60 dark:border-white/10 bg-slate-50/70 dark:bg-white/[0.03]">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          {/* Tool Icon Badge */}
          <div
            className={`flex items-center justify-center w-7 h-7 rounded-lg flex-shrink-0 ${typeConfig.accentBg}`}
          >
            <IconComp size={15} />
          </div>

          {/* Title & Status */}
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 font-mono tracking-tight truncate">
              {typeConfig.label}
            </span>

            <span className="inline-flex items-center gap-1 text-[10px] font-medium rounded-full px-2 py-0.5 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
              <span className="text-[10px]">✓</span> {t("contentRenderer.ready")}
            </span>

            {formattedDuration && (
              <span className="inline-flex items-center text-[10px] font-medium rounded-full px-2 py-0.5 border border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400">
                {formattedDuration}
              </span>
            )}

            {formattedCost && (
              <span className="inline-flex items-center text-[10px] font-medium rounded-full px-2 py-0.5 border border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400">
                {formattedCost}
              </span>
            )}
          </div>
        </div>

        {/* Right Action Buttons */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {url && (
            <>
              <button
                type="button"
                title={t("contentRenderer.copyLink")}
                aria-label={t("contentRenderer.copyLink")}
                className="p-1 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
                onClick={handleCopyUrl}
              >
                {copied ? <LuCheck size={14} className="text-emerald-500" /> : <LuCopy size={14} />}
              </button>

              <button
                type="button"
                title={t("contentRenderer.downloadFile")}
                aria-label={t("contentRenderer.download")}
                className="p-1 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
                onClick={handleDownload}
              >
                <LuDownload size={14} />
              </button>

              {kind === "image" && (
                <button
                  type="button"
                  title={t("contentRenderer.expandFullScreen")}
                  aria-label={t("contentRenderer.fullScreen")}
                  className="p-1 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
                  onClick={() => setLightboxOpen(true)}
                >
                  <LuMaximize2 size={14} />
                </button>
              )}
            </>
          )}

          <button
            type="button"
            title={showDetails ? t("contentRenderer.hideDetails") : t("contentRenderer.showDetails")}
            aria-label={t("contentRenderer.toggleDetails")}
            className={`p-1 rounded-md transition-colors ${
              showDetails
                ? "text-zinc-200 dark:text-zinc-300 bg-zinc-500/15"
                : "text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10"
            }`}
            onClick={() => setShowDetails((prev) => !prev)}
          >
            <LuInfo size={14} />
          </button>

          {onDismiss && (
            <button
              type="button"
              aria-label={t("contentRenderer.dismiss")}
              className="p-1 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
              onClick={onDismiss}
            >
              <LuX size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Main Media Body */}
      <div className="p-2.5 bg-slate-50/50 dark:bg-black/40">
        {!url ? (
          <div className="flex items-center justify-center p-6 text-slate-400 text-sm">
            <span>{t("contentRenderer.noOutputUrl")}</span>
          </div>
        ) : kind === "image" ? (
          <div
            className="relative rounded-lg overflow-hidden bg-white dark:bg-[#09090b] cursor-pointer group"
            onClick={() => setLightboxOpen(true)}
          >
            <img
              src={url}
              alt={item.prompt || item.title || t("contentRenderer.generatedImage")}
              className="w-full h-auto max-h-[520px] object-contain block mx-auto"
            />
            {/* Hover overlay hint */}
            <div className="absolute bottom-2.5 right-2.5 bg-black/75 backdrop-blur-md text-white rounded-full px-2.5 py-1 flex items-center gap-1.5 text-[11px] opacity-80 group-hover:opacity-100 transition-opacity">
              <LuMaximize2 size={11} />
              <span className="font-medium">{t("contentRenderer.clickToExpand")}</span>
            </div>
          </div>
        ) : kind === "video" ? (
          <div className="rounded-lg overflow-hidden border border-slate-200/80 dark:border-white/10 bg-black">
            <video
              src={url}
              controls
              playsInline
              className="w-full max-h-[520px] block bg-black"
            />
          </div>
        ) : kind === "audio" ? (
          <div className="flex items-center gap-3 p-4 rounded-lg bg-white dark:bg-[#18181b] border border-slate-200 dark:border-white/10">
            <audio src={url} controls className="w-full" />
          </div>
        ) : kind === "code" ? (
          <div className="flex flex-col rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-[#0d1117] overflow-hidden">
            <iframe
              src={url}
              title={t("contentRenderer.generatedCodeTitle")}
              className="w-full h-[280px] border-0"
            />
          </div>
        ) : (
          <div className="flex items-center justify-between p-3 rounded-lg bg-white dark:bg-[#18181b] border border-slate-200 dark:border-white/10">
            <span className="text-sm text-slate-800 dark:text-slate-200 truncate flex-1">
              {url}
            </span>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md border border-slate-200 dark:border-white/10 hover:bg-slate-100 dark:hover:bg-white/5 font-medium transition-colors"
            >
              <LuExternalLink size={12} /> {t("contentRenderer.open")}
            </a>
          </div>
        )}
      </div>

      {/* Expandable Metadata Section */}
      <AnimatedCollapse in={showDetails}>
        <div className="p-3 border-t border-slate-200/60 dark:border-white/10 bg-slate-50/80 dark:bg-black/20 text-xs font-mono">
          <p className="text-[10px] font-bold text-zinc-300 uppercase tracking-wider mb-2">
            {t("contentRenderer.artifactDetails")}
          </p>

          <div className="flex flex-col gap-1.5">
            {item.prompt && (
              <div className="flex gap-2 items-start py-0.5">
                <span className="text-zinc-300 font-semibold w-[28%] flex-shrink-0">
                  {t("contentRenderer.fields.prompt")}
                </span>
                <span className="text-slate-600 dark:text-slate-400 flex-1 whitespace-pre-wrap">
                  {item.prompt}
                </span>
              </div>
            )}

            {(item.width || item.height) && (
              <div className="flex gap-2 items-center py-0.5">
                <span className="text-zinc-300 font-semibold w-[28%] flex-shrink-0">
                  {t("contentRenderer.fields.dimensions")}
                </span>
                <span className="text-slate-600 dark:text-slate-400 flex-1">
                  {item.width || "?"} × {item.height || "?"} px
                </span>
              </div>
            )}

            {item.mime && (
              <div className="flex gap-2 items-center py-0.5">
                <span className="text-zinc-300 font-semibold w-[28%] flex-shrink-0">
                  {t("contentRenderer.fields.mime")}
                </span>
                <span className="text-slate-600 dark:text-slate-400 flex-1">
                  {item.mime}
                </span>
              </div>
            )}

            {formattedSize && (
              <div className="flex gap-2 items-center py-0.5">
                <span className="text-zinc-300 font-semibold w-[28%] flex-shrink-0">
                  {t("contentRenderer.fields.size")}
                </span>
                <span className="text-slate-600 dark:text-slate-400 flex-1">
                  {formattedSize}
                </span>
              </div>
            )}

            {item.execution_id && (
              <div className="flex gap-2 items-center py-0.5">
                <span className="text-zinc-300 font-semibold w-[28%] flex-shrink-0">
                  {t("contentRenderer.fields.executionId")}
                </span>
                <span className="text-slate-600 dark:text-slate-400 flex-1 truncate">
                  {item.execution_id}
                </span>
              </div>
            )}

            {item.seed != null && (
              <div className="flex gap-2 items-center py-0.5">
                <span className="text-zinc-300 font-semibold w-[28%] flex-shrink-0">
                  {t("contentRenderer.fields.seed")}
                </span>
                <span className="text-slate-600 dark:text-slate-400 flex-1">
                  {item.seed === -1 ? t("contentRenderer.randomSeed") : item.seed}
                </span>
              </div>
            )}

            {url && (
              <div className="flex gap-2 items-start py-0.5">
                <span className="text-zinc-300 font-semibold w-[28%] flex-shrink-0">
                  {t("contentRenderer.fields.url")}
                </span>
                <span className="text-slate-600 dark:text-slate-400 flex-1 truncate" title={url}>
                  {url}
                </span>
              </div>
            )}
          </div>
        </div>
      </AnimatedCollapse>

      {/* Lightbox Modal */}
      {kind === "image" && (
        <ImageLightbox
          open={lightboxOpen}
          onClose={() => setLightboxOpen(false)}
          images={lightboxImages}
          initialIndex={0}
        />
      )}
    </div>
  );
};

const ContentRenderer: FC<ContentRendererProps> = ({ content, onDismiss }) => {
  const items: ContentItem[] = Array.isArray(content) ? content : [content];
  if (items.length === 0) return null;

  return (
    <div className="mt-2 w-full max-w-[540px]">
      {items.map((item, idx) => (
        <ToolOutputCard
          key={`${item.content_url || item.execution_id || "item"}-${idx}`}
          item={item}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
};

export default ContentRenderer;
