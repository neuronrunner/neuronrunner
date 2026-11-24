"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useTheme } from "next-themes";
import Editor from "@monaco-editor/react";
import { LuSave, LuFileCode2, LuUndo2 } from "react-icons/lu";
import useWorkspaceTabsStore, { IWorkspaceTab } from "@/stores/workspace-tabs";
import useSandboxProjectsStore from "@/stores/sandbox-projects";
import { toaster } from "@/components/ui/toaster";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function getLanguageFromPath(path?: string): string {
  if (!path) return "plaintext";
  const ext = (path.split(".").pop() || "").toLowerCase();
  switch (ext) {
    case "py": return "python";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs": return "javascript";
    case "ts":
    case "tsx": return "typescript";
    case "json": return "json";
    case "html":
    case "htm": return "html";
    case "css":
    case "scss":
    case "less": return "css";
    case "md":
    case "markdown": return "markdown";
    case "sh":
    case "bash":
    case "zsh": return "shell";
    case "sql": return "sql";
    case "yml":
    case "yaml": return "yaml";
    case "toml": return "ini";
    case "xml":
    case "svg": return "xml";
    case "rs": return "rust";
    case "go": return "go";
    case "cpp":
    case "c":
    case "h":
    case "hpp": return "cpp";
    default: return "plaintext";
  }
}

interface Props {
  tab: IWorkspaceTab;
}

export const CodeEditorTabView: React.FC<Props> = ({ tab }) => {
  const { t } = useTranslation("workspace");
  const { resolvedTheme } = useTheme();
  const isLight = resolvedTheme === "light";
  const editorRef = useRef<any>(null);

  const { updateTabContent, markTabSaved, setTabContentLoaded } =
    useWorkspaceTabsStore();
  const { workspaceSandbox: currentSandbox, fetchFileContent, saveFileContent } =
    useSandboxProjectsStore();

  const [isLoading, setIsLoading] = useState(!tab.isContentLoaded);
  const [isSaving, setIsSaving] = useState(false);
  const [canUndo, setCanUndo] = useState(false);

  const sandboxUuid = currentSandbox?.uuid;

  const checkCanUndo = useCallback(() => {
    const model = editorRef.current?.getModel();
    if (model && typeof model.canUndo === "function") {
      setCanUndo(model.canUndo());
    } else {
      setCanUndo(Boolean(tab.isDirty));
    }
  }, [tab.isDirty]);

  useEffect(() => {
    checkCanUndo();
  }, [tab.content, tab.isDirty, checkCanUndo]);

  const handleUndo = () => {
    if (!editorRef.current) return;
    editorRef.current.focus();
    editorRef.current.trigger("toolbar", "undo", null);
    setTimeout(checkCanUndo, 50);
  };

  useEffect(() => {
    if (!tab.isContentLoaded && sandboxUuid && tab.fileUuid) {
      setIsLoading(true);
      fetchFileContent(sandboxUuid, tab.fileUuid)
        .then((content) => {
          setTabContentLoaded(tab.id, content || "", false);
        })
        .catch((err) => {
          console.error("Failed to load file content:", err);
          toaster.create({
            title: t("codeEditor.loadFailed"),
            type: "error",
          });
        })
        .finally(() => {
          setIsLoading(false);
        });
    } else if (tab.isContentLoaded) {
      setIsLoading(false);
    }
  }, [tab.id, tab.fileUuid, tab.isContentLoaded, sandboxUuid, fetchFileContent, setTabContentLoaded]);

  const handleEditorChange = (value?: string) => {
    updateTabContent(tab.id, value || "");
    setTimeout(checkCanUndo, 0);
  };

  const handleBeforeMount = (monaco: any) => {
    monaco.editor.defineTheme("neuronrunner-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#050508",
        "editorGutter.background": "#050508",
        "minimap.background": "#050508",
        "minimapGutter.background": "#050508",
        "editor.lineHighlightBackground": "#ffffff08",
        "editorLineNumber.foreground": "#52525b",
        "editorLineNumber.activeForeground": "#a1a1aa",
      },
    });
    monaco.editor.defineTheme("neuronrunner-light", {
      base: "vs",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#f9fafb",
        "editorGutter.background": "#f9fafb",
        "minimap.background": "#f9fafb",
        "minimapGutter.background": "#f9fafb",
        "editor.lineHighlightBackground": "#00000008",
        "editorLineNumber.foreground": "#a1a1aa",
        "editorLineNumber.activeForeground": "#18181b",
      },
    });
  };

  const handleSave = async () => {
    if (!sandboxUuid || !tab.fileUuid || isSaving) return;
    setIsSaving(true);
    try {
      const content = tab.content || "";
      const ok = await saveFileContent(sandboxUuid, tab.fileUuid, content);
      if (ok) {
        markTabSaved(tab.id);
        toaster.create({
          title: t("codeEditor.fileSaved"),
          description: tab.title,
          type: "success",
        });
      }
    } catch {
      toaster.create({
        title: t("codeEditor.saveFailed"),
        type: "error",
      });
    } finally {
      setIsSaving(false);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSave();
      } else if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "z" &&
        !e.shiftKey
      ) {
        if (editorRef.current && !editorRef.current.hasTextFocus?.()) {
          e.preventDefault();
          editorRef.current.focus();
          editorRef.current.trigger("keyboard", "undo", null);
          setTimeout(checkCanUndo, 50);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [tab.content, tab.fileUuid, sandboxUuid, checkCanUndo]);

  const language = getLanguageFromPath(tab.filePath || tab.title);
  const modelPath = tab.filePath
    ? (tab.filePath.startsWith("/") ? tab.filePath : `/${tab.filePath}`)
    : `/${tab.id}`;

  if (isLoading) {
    return (
      <div className={cn("flex flex-1 h-full min-h-[300px] items-center justify-center bg-background")}>
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-400 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col w-full h-full min-h-0 bg-background")}>
      {/* Editor Sub-Header / Status Bar */}
      <div
        className={cn(
          "flex h-[34px] px-3 items-center justify-between text-xs border-b shrink-0 bg-background border-border/40"
        )}
      >
        <div className="flex items-center gap-2">
          <LuFileCode2 className="h-3.5 w-3.5 text-purple-500" />
          <span className="font-medium text-foreground">
            {tab.filePath || tab.title}
          </span>
          <span className="text-muted-foreground text-[10px]">
            ({language})
          </span>
        </div>

        <div className="flex items-center gap-2">
          {tab.isDirty && (
            <span className="text-amber-500 text-[11px] font-medium">
              {t("codeEditor.unsavedChanges")}
            </span>
          )}

          <Button
            size="xs"
            variant="outline"
            onClick={handleUndo}
            disabled={!canUndo}
            className="h-[24px] px-2 text-xs gap-1"
            title={t("codeEditor.undoTitle")}
          >
            <LuUndo2 className="h-3 w-3" />
            {t("codeEditor.undo")}
          </Button>

          <Button
            size="xs"
            variant={tab.isDirty ? "default" : "outline"}
            onClick={handleSave}
            disabled={isSaving || !tab.isDirty}
            className="h-[24px] px-2.5 text-xs gap-1.5"
          >
            {isSaving ? (
              <span className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
            ) : (
              <>
                <LuSave className="h-3 w-3" />
                {t("common.save")}
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Monaco Editor Container */}
      <div className="flex-1 w-full min-h-0 relative bg-background">
        <Editor
          height="100%"
          path={modelPath}
          language={language}
          value={tab.content || ""}
          theme={isLight ? "neuronrunner-light" : "neuronrunner-dark"}
          beforeMount={handleBeforeMount}
          loading={
            <div className="flex flex-1 h-full w-full items-center justify-center bg-background">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-400 border-t-transparent" />
            </div>
          }
          onChange={handleEditorChange}
          onMount={(editor) => {
            editorRef.current = editor;
            const model = editor.getModel();
            if (model) {
              if (typeof model.canUndo === "function") {
                setCanUndo(model.canUndo());
              }
              const disposable = model.onDidChangeContent(() => {
                if (typeof model.canUndo === "function") {
                  setCanUndo(model.canUndo());
                }
              });
              editor.onDidDispose(() => disposable.dispose());
            }
            checkCanUndo();
          }}
          options={{
            fontSize: 13,
            minimap: { enabled: true },
            scrollBeyondLastLine: false,
            wordWrap: "on",
            lineNumbers: "on",
            automaticLayout: true,
            tabSize: 2,
            padding: { top: 8, bottom: 8 },
            fontFamily: "var(--font-geist-mono), 'Fira Code', 'Courier New', monospace",
          }}
        />
      </div>
    </div>
  );
};

export default CodeEditorTabView;
