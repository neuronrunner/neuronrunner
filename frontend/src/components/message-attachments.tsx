"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuDownload, LuPaperclip, LuLoader as LuLoader2, LuMaximize2 } from "react-icons/lu";
import { toaster } from "@/components/ui/toaster";
import ImageLightbox from "@/components/image-lightbox";
import { AttachmentData, ImageData } from "@/stores/chat";
import { Button } from "@/components/ui/button";

interface MessageAttachmentsProps {
  attachments?: AttachmentData[];
}

const formatFileSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const triggerBrowserDownload = (blob: Blob, fileName: string) => {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
};

const isImageAttachment = (att: AttachmentData): boolean => {
  return (
    Boolean(att.content_type?.startsWith("image/")) ||
    /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(att.original_name)
  );
};

const getAttachmentKey = (att: AttachmentData, index: number): string =>
  att.uuid || `${att.original_name}-${att.file_size}-${index}`;

interface LocalUrlEntry {
  url: string;
  count: number;
  revokeTimer?: ReturnType<typeof setTimeout>;
}

const localUrlCache = new WeakMap<File, LocalUrlEntry>();
const remoteUrlCache = new Map<string, string>();
const MAX_REMOTE_CACHE_SIZE = 100;

const getOrCreateLocalUrl = (file: File): string => {
  const existing = localUrlCache.get(file);
  if (existing) {
    if (existing.revokeTimer) {
      clearTimeout(existing.revokeTimer);
      existing.revokeTimer = undefined;
    }
    return existing.url;
  }
  const url = URL.createObjectURL(file);
  localUrlCache.set(file, { url, count: 0 });
  return url;
};

const retainLocalUrl = (file: File): string => {
  const url = getOrCreateLocalUrl(file);
  const entry = localUrlCache.get(file);
  if (entry) {
    entry.count += 1;
  }
  return url;
};

const releaseLocalUrl = (file: File) => {
  const entry = localUrlCache.get(file);
  if (!entry) return;
  entry.count = Math.max(0, entry.count - 1);
  if (entry.count === 0) {
    entry.revokeTimer = setTimeout(() => {
      const current = localUrlCache.get(file);
      if (current && current.count === 0) {
        URL.revokeObjectURL(current.url);
        localUrlCache.delete(file);
      }
    }, 500);
  }
};

const cacheRemoteUrl = (downloadUrl: string, objectUrl: string): string => {
  const existing = remoteUrlCache.get(downloadUrl);
  if (existing) {
    URL.revokeObjectURL(objectUrl);
    return existing;
  }
  if (remoteUrlCache.size >= MAX_REMOTE_CACHE_SIZE) {
    const oldestKey = remoteUrlCache.keys().next().value;
    if (oldestKey) {
      const oldestUrl = remoteUrlCache.get(oldestKey);
      remoteUrlCache.delete(oldestKey);
      if (oldestUrl) URL.revokeObjectURL(oldestUrl);
    }
  }
  remoteUrlCache.set(downloadUrl, objectUrl);
  return objectUrl;
};
interface PreviewState {
  urls: Record<string, string>;
  failed: Record<string, boolean>;
}

const MessageAttachments = ({ attachments = [] }: MessageAttachmentsProps) => {
  const { t } = useTranslation("chat");
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [previews, setPreviews] = useState<PreviewState>({ urls: {}, failed: {} });
  const [loadedKeys, setLoadedKeys] = useState<Record<string, boolean>>({});
  const [dimensions, setDimensions] = useState<Record<string, { width: number; height: number }>>({});
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const syncUrls = useMemo(() => {
    const map: Record<string, string> = {};
    attachments.forEach((attachment, index) => {
      if (!isImageAttachment(attachment)) return;
      const key = getAttachmentKey(attachment, index);
      if (attachment.local_file) {
        map[key] = getOrCreateLocalUrl(attachment.local_file);
      } else if (attachment.download_url) {
        const cached = remoteUrlCache.get(attachment.download_url);
        if (cached) {
          map[key] = cached;
        }
      }
    });
    return map;
  }, [attachments]);

  useEffect(() => {
    const controller = new AbortController();
    const retainedFiles: File[] = [];

    attachments.forEach((attachment, index) => {
      if (!isImageAttachment(attachment)) return;
      const key = getAttachmentKey(attachment, index);

      if (attachment.local_file) {
        retainLocalUrl(attachment.local_file);
        retainedFiles.push(attachment.local_file);
        return;
      }

      if (!attachment.download_url) {
        setPreviews((prev) => ({
          ...prev,
          failed: { ...prev.failed, [key]: true },
        }));
        return;
      }

      const cached = remoteUrlCache.get(attachment.download_url);
      if (cached) {
        return;
      }

      const downloadUrl = attachment.download_url;
      const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
      fetch(downloadUrl, {
        method: "GET",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      })
        .then((response) => {
          if (!response.ok) throw new Error("Failed to load image preview");
          return response.blob();
        })
        .then((blob) => {
          if (controller.signal.aborted) return;
          const alreadyCached = remoteUrlCache.get(downloadUrl);
          const resolvedUrl = alreadyCached || cacheRemoteUrl(downloadUrl, URL.createObjectURL(blob));
          setPreviews((prev) => ({
            urls: { ...prev.urls, [key]: resolvedUrl },
            failed: { ...prev.failed, [key]: false },
          }));
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setPreviews((prev) => ({
            ...prev,
            failed: { ...prev.failed, [key]: true },
          }));
        });
    });

    return () => {
      controller.abort();
      retainedFiles.forEach((file) => releaseLocalUrl(file));
    };
  }, [attachments]);

  const resolvedUrls = useMemo(
    () => ({ ...previews.urls, ...syncUrls }),
    [previews.urls, syncUrls]
  );

  const lightboxImages = useMemo<ImageData[]>(() => {
    return attachments.flatMap((attachment, index) => {
      if (!isImageAttachment(attachment)) return [];
      const key = getAttachmentKey(attachment, index);
      const url = resolvedUrls[key];
      if (!url) return [];
      const dims = dimensions[key];
      return [
        {
          uuid: key,
          image_uuid: key,
          image_url: url,
          prompt: attachment.original_name,
          negative_prompt: "",
          width: dims?.width ?? 0,
          height: dims?.height ?? 0,
          seed: null,
          created_at: attachment.created_at ?? "",
        },
      ];
    });
  }, [attachments, resolvedUrls, dimensions]);

  if (!attachments.length) {
    return null;
  }

  const downloadAttachment = async (attachment: AttachmentData) => {
    const attachmentKey = attachment.uuid || attachment.original_name;
    setLoadingId(attachmentKey);

    try {
      if (attachment.local_file) {
        triggerBrowserDownload(attachment.local_file, attachment.original_name);
        return;
      }

      if (!attachment.download_url) {
        throw new Error("Attachment download URL is missing");
      }

      const token = localStorage.getItem("token");
      const response = await fetch(attachment.download_url, {
        method: "GET",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!response.ok) {
        throw new Error("Attachment download failed");
      }

      const blob = await response.blob();
      triggerBrowserDownload(blob, attachment.original_name);
    } catch (error) {
      console.error(error);
      toaster.create({
        title: t("attachments.downloadFailed"),
        description: t("attachments.tryAgain"),
        type: "error",
      });
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {attachments.map((attachment, index) => {
          const attachmentKey = getAttachmentKey(attachment, index);
          const isLoading = loadingId === (attachment.uuid || attachment.original_name);
          const isImg = isImageAttachment(attachment);
          const previewUrl = resolvedUrls[attachmentKey];
          const previewFailed = previews.failed[attachmentKey];
          const isSyncPreview = Boolean(syncUrls[attachmentKey]);
          const isImageReady = isSyncPreview || Boolean(loadedKeys[attachmentKey]);

          if (isImg && !previewFailed) {
            if (!previewUrl) {
              return (
                <div
                  key={attachmentKey}
                  role="status"
                  aria-label={t("markdownImage.loading")}
                  className="h-32 w-44 animate-pulse rounded-xl border border-border/50 bg-muted/60"
                />
              );
            }

            const imageIndex = lightboxImages.findIndex((img) => img.uuid === attachmentKey);

            return (
              <div
                key={attachmentKey}
                className="group relative overflow-hidden rounded-xl border border-border/60 bg-muted/30 shadow-sm transition-all duration-200 hover:border-border hover:shadow-md"
              >
                <button
                  type="button"
                  onClick={() => {
                    if (imageIndex >= 0) setLightboxIndex(imageIndex);
                  }}
                  aria-label={t("markdownImage.expand", { alt: attachment.original_name })}
                  className="block cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <img
                    src={previewUrl}
                    alt={attachment.original_name}
                    decoding={isSyncPreview ? "sync" : "async"}
                    onLoad={(e) => {
                      const { naturalWidth, naturalHeight } = e.currentTarget;
                      setLoadedKeys((prev) => (prev[attachmentKey] ? prev : { ...prev, [attachmentKey]: true }));
                      setDimensions((prev) => ({
                        ...prev,
                        [attachmentKey]: { width: naturalWidth, height: naturalHeight },
                      }));
                    }}
                    onError={() => {
                      setPreviews((prev) => ({
                        ...prev,
                        failed: { ...prev.failed, [attachmentKey]: true },
                      }));
                    }}
                    className={`block max-h-44 max-w-[220px] min-h-[88px] min-w-[88px] object-cover transition-[transform,opacity] duration-200 group-hover:scale-[1.03] ${
                      isImageReady ? "opacity-100" : "opacity-0"
                    }`}
                  />
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 transition-colors duration-200 group-hover:bg-black/25">
                    <LuMaximize2 className="h-5 w-5 text-white opacity-0 drop-shadow transition-opacity duration-200 group-hover:opacity-100" />
                  </div>
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/35 to-transparent px-2.5 pb-1.5 pt-5 text-left opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                    <p className="truncate text-[11px] font-medium text-white">
                      {attachment.original_name}
                    </p>
                    <p className="text-[10px] text-white/75">
                      {formatFileSize(attachment.file_size)}
                    </p>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    downloadAttachment(attachment);
                  }}
                  disabled={isLoading}
                  title={t("attachments.clickToDownloadImage")}
                  aria-label={t("attachments.clickToDownloadImage")}
                  className="absolute right-1.5 top-1.5 z-10 cursor-pointer rounded-lg bg-black/60 p-1.5 text-white opacity-0 backdrop-blur-sm transition-opacity duration-200 hover:bg-black/80 focus:opacity-100 group-hover:opacity-100 disabled:opacity-50"
                >
                  {isLoading ? (
                    <LuLoader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <LuDownload className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            );
          }

          return (
            <Button
              key={attachmentKey}
              size="sm"
              variant="ghost"
              onClick={() => downloadAttachment(attachment)}
              disabled={isLoading}
              className="h-7 px-2.5 text-xs bg-muted/60 hover:bg-muted text-muted-foreground hover:text-foreground rounded-lg flex items-center gap-1.5"
            >
              {isLoading ? <LuLoader2 className="h-3.5 w-3.5 animate-spin" /> : <LuPaperclip className="h-3.5 w-3.5" />}
              <span className="max-w-[220px] truncate">
                {attachment.original_name} ({formatFileSize(attachment.file_size)})
              </span>
              <LuDownload className="h-3.5 w-3.5 opacity-70" />
            </Button>
          );
        })}
      </div>

      <ImageLightbox
        open={lightboxIndex !== null}
        onClose={() => setLightboxIndex(null)}
        images={lightboxImages}
        initialIndex={lightboxIndex ?? 0}
      />
    </>
  );
};

export default MessageAttachments;
