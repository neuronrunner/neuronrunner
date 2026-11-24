"use client";

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTheme } from "next-themes";
import { LuTable2, LuRefreshCw } from "react-icons/lu";
import { XlsxViewer } from "@extend-ai/react-xlsx";
import useWorkspaceTabsStore, { IWorkspaceTab } from "@/stores/workspace-tabs";
import useSandboxProjectsStore from "@/stores/sandbox-projects";
import { toaster } from "@/components/ui/toaster";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function stringToArrayBuffer(str: string): ArrayBuffer {
  return new TextEncoder().encode(str).buffer;
}

interface Props {
  tab: IWorkspaceTab;
}

export const XlsxEditorTabView: React.FC<Props> = ({ tab }) => {
  const { t } = useTranslation("workspace");
  const { resolvedTheme } = useTheme();
  const isLight = resolvedTheme === "light";

  const { setTabContentLoaded } = useWorkspaceTabsStore();
  const { workspaceSandbox: currentSandbox, fetchFileFullContent } = useSandboxProjectsStore();

  const [isLoading, setIsLoading] = useState(!tab.isContentLoaded);
  const [arrayBuffer, setArrayBuffer] = useState<ArrayBuffer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadData = async () => {
    if (!currentSandbox?.uuid || !tab.fileUuid) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetchFileFullContent(currentSandbox.uuid, tab.fileUuid);
      if (res) {
        setTabContentLoaded(tab.id, res.content, res.isBinary);
        const buf = res.isBinary
          ? base64ToArrayBuffer(res.content)
          : stringToArrayBuffer(res.content);
        setArrayBuffer(buf);
      } else {
        setLoadError(t("xlsxView.fetchFailed"));
      }
    } catch (err: any) {
      console.error("Failed to load xlsx content:", err);
      setLoadError(err?.message || t("xlsxView.loadFailed"));
      toaster.create({
        title: t("xlsxView.loadErrorToast"),
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
        const buf = tab.isBinary
          ? base64ToArrayBuffer(tab.content)
          : stringToArrayBuffer(tab.content);
        setArrayBuffer(buf);
        setIsLoading(false);
      } catch {
        loadData();
      }
    } else {
      loadData();
    }
  }, [tab.id, tab.fileUuid, currentSandbox?.uuid]);

  if (isLoading) {
    return (
      <div className={cn("flex flex-1 h-full min-h-[300px] items-center justify-center flex-col gap-3 bg-background")}>
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
        <span className="text-sm text-muted-foreground">{t("xlsxView.loading")}</span>
      </div>
    );
  }

  if (loadError || !arrayBuffer) {
    return (
      <div className={cn("flex flex-1 h-full min-h-[300px] items-center justify-center flex-col gap-3 bg-background")}>
        <LuTable2 className="h-8 w-8 text-emerald-500" />
        <span className="text-sm text-muted-foreground">
          {loadError || t("xlsxView.noContent")}
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
          "flex h-[34px] px-3 items-center justify-between text-xs border-b shrink-0 bg-background border-border/50"
        )}
      >
        <div className="flex items-center gap-2">
          <LuTable2 className="h-3.5 w-3.5 text-emerald-500" />
          <span className="font-medium text-foreground">
            {tab.filePath || tab.title}
          </span>
          <Badge variant="subtle" className="text-[10px] text-emerald-500 bg-emerald-500/10">
            {t("xlsxView.badge")}
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant="ghost"
            onClick={loadData}
            title={t("xlsxView.reloadTitle")}
            className="h-6 px-2 text-xs gap-1"
          >
            <LuRefreshCw className="h-3 w-3" />
            {t("common.reload")}
          </Button>
        </div>
      </div>

      {/* Extend AI XLSX Viewer */}
      <div className="flex-1 w-full min-h-0 overflow-hidden">
        <XlsxViewer
          file={arrayBuffer}
          fileName={tab.title}
          showDefaultToolbar={true}
          isDark={!isLight}
          readOnly={false}
          height="100%"
        />
      </div>
    </div>
  );
};

export default XlsxEditorTabView;
