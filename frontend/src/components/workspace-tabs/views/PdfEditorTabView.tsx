"use client";

import React, { useEffect, useState, useRef } from "react";
import { useTheme } from "next-themes";
import { useTranslation } from "react-i18next";
import { LuFile, LuDownload, LuExternalLink, LuRefreshCw } from "react-icons/lu";
import useWorkspaceTabsStore, { IWorkspaceTab } from "@/stores/workspace-tabs";
import useSandboxProjectsStore from "@/stores/sandbox-projects";
import { toaster } from "@/components/ui/toaster";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

function base64ToBlob(base64: string, mimeType = "application/pdf"): Blob {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

interface Props {
  tab: IWorkspaceTab;
}

export const PdfEditorTabView: React.FC<Props> = ({ tab }) => {
  const { t } = useTranslation("workspace");
  const { resolvedTheme } = useTheme();
  const isLight = resolvedTheme === "light";

  const { setTabContentLoaded } = useWorkspaceTabsStore();
  const { workspaceSandbox: currentSandbox, fetchFileFullContent } = useSandboxProjectsStore();

  const [isLoading, setIsLoading] = useState(!tab.isContentLoaded);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const prevBlobUrlRef = useRef<string | null>(null);

  const loadData = async () => {
    if (!currentSandbox?.uuid || !tab.fileUuid) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetchFileFullContent(currentSandbox.uuid, tab.fileUuid);
      if (res) {
        setTabContentLoaded(tab.id, res.content, res.isBinary);
        if (prevBlobUrlRef.current) {
          URL.revokeObjectURL(prevBlobUrlRef.current);
        }
        const blob = res.isBinary
          ? base64ToBlob(res.content)
          : new Blob([res.content], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        prevBlobUrlRef.current = url;
        setBlobUrl(url);
      } else {
        setLoadError(t("pdfView.fetchFailed"));
      }
    } catch (err: any) {
      console.error("Failed to load PDF content:", err);
      setLoadError(err?.message || t("pdfView.loadFailed"));
      toaster.create({
        title: t("pdfView.loadErrorToast"),
        description: tab.title,
        type: "error",
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (tab.isContentLoaded && tab.content) {
      try {
        if (prevBlobUrlRef.current) {
          URL.revokeObjectURL(prevBlobUrlRef.current);
        }
        const blob = tab.isBinary
          ? base64ToBlob(tab.content)
          : new Blob([tab.content], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        prevBlobUrlRef.current = url;
        setBlobUrl(url);
        setIsLoading(false);
      } catch {
        loadData();
      }
    } else {
      loadData();
    }

    return () => {
      if (prevBlobUrlRef.current) {
        URL.revokeObjectURL(prevBlobUrlRef.current);
      }
    };
  }, [tab.id, tab.fileUuid, currentSandbox?.uuid]);

  const handleDownload = () => {
    if (!blobUrl) return;
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = tab.title.endsWith(".pdf") ? tab.title : `${tab.title}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleOpenExternal = () => {
    if (!blobUrl) return;
    window.open(blobUrl, "_blank");
  };

  if (isLoading) {
    return (
      <div className={cn("flex flex-1 h-full min-h-[300px] items-center justify-center flex-col gap-3 bg-background")}>
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-red-500 border-t-transparent" />
        <span className="text-sm text-muted-foreground">{t("pdfView.loading")}</span>
      </div>
    );
  }

  if (loadError || !blobUrl) {
    return (
      <div className={cn("flex flex-1 h-full min-h-[300px] items-center justify-center flex-col gap-3 bg-background")}>
        <LuFile className="h-8 w-8 text-red-500" />
        <span className="text-sm text-muted-foreground">
          {loadError || t("pdfView.noContent")}
        </span>
        <Button size="xs" variant="outline" onClick={loadData} className="gap-1.5">
          <LuRefreshCw className="h-3 w-3" />
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col w-full h-full min-h-0 bg-background")}>
      {/* Subheader */}
      <div
        className={cn(
          "flex h-[36px] px-3 items-center justify-between text-xs border-b shrink-0 bg-background border-border/50"
        )}
      >
        <div className="flex items-center gap-2">
          <LuFile className="h-3.5 w-3.5 text-red-500" />
          <span className="font-medium text-foreground">
            {tab.filePath || tab.title}
          </span>
          <Badge variant="subtle" className="text-[10px] text-red-500 bg-red-500/10">
            {t("pdfView.badge")}
          </Badge>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            size="xs"
            variant="ghost"
            onClick={loadData}
            title={t("pdfView.reloadTitle")}
            className="h-6 px-2 text-xs gap-1"
          >
            <LuRefreshCw className="h-3 w-3" />
            {t("common.reload")}
          </Button>

          <Button
            size="xs"
            variant="ghost"
            onClick={handleDownload}
            title={t("pdfView.downloadTitle")}
            className="h-6 px-2 text-xs gap-1"
          >
            <LuDownload className="h-3 w-3" />
            {t("pdfView.download")}
          </Button>

          <button
            type="button"
            aria-label={t("pdfView.openNewWindow")}
            onClick={handleOpenExternal}
            title={t("pdfView.openNewWindow")}
            className="h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
          >
            <LuExternalLink className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* PDF Viewport */}
      <div className={cn("flex-1 w-full min-h-0 relative", isLight ? "bg-[#e5e7eb]" : "bg-[#050508]")}>
        <object
          data={`${blobUrl}#toolbar=1&navpanes=1`}
          type="application/pdf"
          width="100%"
          height="100%"
          style={{ border: "none", display: "block" }}
        >
          <div className="flex h-full items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <span className="text-sm text-muted-foreground">
                {t("pdfView.cannotDisplay")}
              </span>
              <Button size="sm" variant="default" onClick={handleOpenExternal} className="gap-1.5">
                <LuExternalLink className="h-4 w-4" />
                {t("pdfView.openPdf")}
              </Button>
            </div>
          </div>
        </object>
      </div>
    </div>
  );
};

export default PdfEditorTabView;
