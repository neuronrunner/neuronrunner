"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { lazyView } from "@/lib/lazy-view";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useRouter } from "@/lib/navigation";
import {
  LuChevronDown, LuChevronRight, LuChevronsDownUp, LuEllipsis, LuFileCode2,
  LuFilePlus, LuFileText, LuFolder, LuFolderOpen, LuFolderPlus, LuGithub,
  LuCircleAlert, LuImage, LuLoaderCircle, LuPencil, LuRefreshCw, LuSearch, LuSettings, LuTable2, LuTerminal,
  LuTrash2, LuUpload,
} from "react-icons/lu";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import GithubRepositoryAccess from "@/components/git/github-repository-access";
import { toaster } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";
import { COMPUTE_TIERS, coresToVcpu, vcpuToCores } from "@/lib/compute";
import { droppedUploadFiles, selectedUploadFiles, uploadDestination, UploadSelection } from "@/lib/file-upload";
import FileOperationProgress, { FileOperation } from "./file-operation-progress";
import useSandboxProjectsStore from "@/stores/sandbox-projects";
import useChatStore from "@/stores/chat";
import useWorkspaceTabsStore from "@/stores/workspace-tabs";
import useWorkspacesStore from "@/stores/workspaces";
import { IProjectFile } from "@/stores/sandbox-projects";

const GitCloneProgress = lazyView(() => import("@/components/git/git-clone-progress").then(module => module.default));

const ROOT = "/workspace";
const parentPath = (path: string) => path.slice(0, path.lastIndexOf("/")) || ROOT;
const entryName = (path: string) => path.split("/").pop() || path;

function fileIcon(file: IProjectFile, expanded = false) {
  const className = "h-4 w-4 shrink-0";
  if (file.is_directory) {
    const Icon = expanded ? LuFolderOpen : LuFolder;
    return <Icon className={cn(className, "text-amber-500")} />;
  }
  const ext = entryName(file.path).split(".").pop()?.toLowerCase() || "";
  if (["xlsx", "xls", "csv"].includes(ext)) return <LuTable2 className={cn(className, "text-emerald-500")} />;
  if (["png", "jpg", "jpeg", "svg", "webp", "gif"].includes(ext)) return <LuImage className={cn(className, "text-violet-400")} />;
  if (["py", "js", "jsx", "ts", "tsx", "json", "css", "html", "sh", "go", "rs"].includes(ext)) return <LuFileCode2 className={cn(className, "text-sky-500")} />;
  return <LuFileText className={cn(className, "text-muted-foreground")} />;
}

type EntryDialog = "file" | "folder" | "rename" | null;

export const FileSystemExplorer: React.FC = () => {
  const { t } = useTranslation("git");
  const router = useRouter();
  const {
    currentSandbox, workspaceSandbox: filesystem, files, isLoading, errorMessage, fetchSandboxes, ensureSandboxes, fetchFiles,
    createFileOrFolder, renameFile, deleteFile, uploadFile, cloneRepository, updateSandbox,
  } = useSandboxProjectsStore();
  const workspaceUuid = useWorkspacesStore((state) => state.currentWorkspace?.uuid || state.currentWorkspaceUuid);
  const fetchWorkspaces = useWorkspacesStore((state) => state.fetchWorkspaces);
  const { openFileTab, openTerminalTab } = useWorkspaceTabsStore();
  // Follow the selected sandbox/project when present, falling back to the workspace root.
  const activeSandbox = currentSandbox?.workspace_uuid === workspaceUuid ? currentSandbox : filesystem;
  const sandboxId = activeSandbox?.workspace_uuid === workspaceUuid ? activeSandbox?.uuid : undefined;
  const activeRoot = useMemo(() => {
    const raw = activeSandbox?.filesystem_path?.replace(/\/+$/, "");
    return raw && (raw === ROOT || raw.startsWith(`${ROOT}/`)) ? raw : ROOT;
  }, [activeSandbox?.filesystem_path]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [entryDialog, setEntryDialog] = useState<EntryDialog>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [cloneLog, setCloneLog] = useState("");
  const [cloneError, setCloneError] = useState("");
  const [cloning, setCloning] = useState(false);
  const [connectingGithub, setConnectingGithub] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cpu, setCpu] = useState(4); // vCPU (shared); 1 physical core = 2 vCPU
  const [memory, setMemory] = useState(8192);
  const [operation, setOperation] = useState<FileOperation | null>(null);
  const [uploadEntries, setUploadEntries] = useState<IProjectFile[]>([]);
  const reducedMotion = useReducedMotion();
  const operationLock = useRef(false);
  const operationVersion = useRef(0);
  const uploadInput = useRef<HTMLInputElement>(null);
  const folderUploadInput = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const activeId = useRef(sandboxId);
  activeId.current = sandboxId;

  useEffect(() => {
    setOperation(null);
    setUploadEntries([]);
    setBusy(false);
    operationLock.current = false;
    operationVersion.current++;
    setDragging(false);
    setSelectedPath(null);
    setExpanded(new Set());
    setQuery("");
    setEntryDialog(null);
    setCloneOpen(false);
    setSettingsOpen(false);
  }, [sandboxId]);

  useEffect(() => {
    if (workspaceUuid) void ensureSandboxes(workspaceUuid);
    else void fetchWorkspaces();
  }, [workspaceUuid, ensureSandboxes, fetchWorkspaces]);

  useEffect(() => {
    if (!sandboxId) return;
    let active = true;
    setRefreshing(true);
    void fetchFiles(sandboxId).finally(() => {
      if (active) setRefreshing(false);
    });
    return () => { active = false; };
  }, [sandboxId, fetchFiles]);

  useEffect(() => {
    if (operation?.status !== "success") return;
    const timeout = setTimeout(() => setOperation(null), 4000);
    return () => clearTimeout(timeout);
  }, [operation]);

  const entries = useMemo(() => {
    const map = new Map<string, IProjectFile>();
    if (!sandboxId) return map;
    for (const file of [...uploadEntries, ...files]) {
      const path = file.path.replace(/\/+$/, "");
      if (!path.startsWith(`${activeRoot}/`)) continue;
      map.set(path, { ...file, path });
      let parent = parentPath(path);
      while (parent !== activeRoot && parent.startsWith(`${activeRoot}/`)) {
        if (!map.has(parent)) map.set(parent, { uuid: parent, path: parent, is_directory: true, file_size_bytes: 0, sha256: "", mime_type: "inode/directory", modified_at: null, created_at: "" });
        parent = parentPath(parent);
      }
    }
    return map;
  }, [files, uploadEntries, sandboxId, activeRoot]);

  const pendingPaths = useMemo(() => {
    const existing = new Set(files.map(file => file.path));
    return new Set(uploadEntries.filter(entry => !existing.has(entry.path)).map(entry => entry.path));
  }, [files, uploadEntries]);
  const operationPaths = operation?.paths;
  const operationKind = operation?.kind;
  const operationStatus = operation?.status;
  const affectedPaths = useMemo(() => {
    const paths = new Set<string>();
    if (operationStatus !== "running" || !operationPaths) return paths;
    if (operationKind === "delete") {
      for (const path of entries.keys()) {
        if (operationPaths.some(deleted => path === deleted || path.startsWith(`${deleted}/`))) paths.add(path);
      }
    } else {
      for (const path of operationPaths) {
        paths.add(path);
        let parent = parentPath(path);
        while (parent !== activeRoot && parent.startsWith(`${activeRoot}/`)) { paths.add(parent); parent = parentPath(parent); }
      }
    }
    return paths;
  }, [operationPaths, operationKind, operationStatus, entries, activeRoot]);

  const selected = selectedPath ? entries.get(selectedPath) : undefined;
  const targetFolder = selected?.is_directory ? selected.path : selected ? parentPath(selected.path) : activeRoot;
  const rows = useMemo(() => {
    const children = new Map<string, IProjectFile[]>();
    for (const file of entries.values()) {
      const parent = parentPath(file.path);
      const siblings = children.get(parent) || [];
      siblings.push(file);
      children.set(parent, siblings);
    }
    for (const siblings of children.values()) {
      siblings.sort((a, b) => Number(b.is_directory) - Number(a.is_directory) || entryName(a.path).localeCompare(entryName(b.path), undefined, { numeric: true }));
    }
    const result: { file: IProjectFile; depth: number }[] = [];
    const matching = new Set<string>();
    if (query.trim()) {
      for (const file of entries.values()) {
        if (!file.path.toLowerCase().includes(query.trim().toLowerCase())) continue;
        matching.add(file.path);
        let parent = parentPath(file.path);
        while (parent !== activeRoot && parent.startsWith(`${activeRoot}/`)) {
          matching.add(parent);
          parent = parentPath(parent);
        }
      }
    }
    const visit = (parent: string, depth: number) => {
      for (const file of children.get(parent) || []) {
        if (query.trim() && !matching.has(file.path)) continue;
        result.push({ file, depth });
        if (file.is_directory && (query.trim() || expanded.has(file.path))) visit(file.path, depth + 1);
      }
    };
    visit(activeRoot, 0);
    return result;
  }, [entries, expanded, query, activeRoot]);

  const toggleFolder = (path: string) => setExpanded((previous) => {
    const next = new Set(previous);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });
  const openEntryDialog = (kind: EntryDialog) => {
    setName(kind === "rename" && selectedPath ? entryName(selectedPath) : "");
    setEntryDialog(kind);
  };
  const reportError = (fallback: string) => toaster.create({ title: useSandboxProjectsStore.getState().errorMessage || fallback, type: "error" });

  const refresh = async () => {
    if (!sandboxId || refreshing) return;
    setRefreshing(true);
    useSandboxProjectsStore.getState().resetError();
    try { await fetchFiles(sandboxId); } finally { setRefreshing(false); }
  };
  const saveEntry = async () => {
    const trimmed = name.trim();
    if (!sandboxId || busy || !trimmed) return;
    if (trimmed.includes("/") || trimmed === "." || trimmed === "..") {
      toaster.create({ title: t("explorer.invalidName"), type: "error" });
      return;
    }
    const id = sandboxId;
    const path = `${entryDialog === "rename" && selected ? parentPath(selected.path) : targetFolder}/${trimmed}`;
    setBusy(true);
    try {
      const ok = entryDialog === "rename" && selected
        ? await renameFile(id, selected.path, path)
        : await createFileOrFolder(id, path, entryDialog === "folder");
      if (!ok) { reportError(t("explorer.unableToSave")); return; }
      if (activeId.current !== id) return;
      setExpanded((previous) => new Set([...previous, parentPath(path)]));
      setSelectedPath(path);
      setEntryDialog(null);
      if (entryDialog === "file") openFileTab({ uuid: path, path });
    } finally { setBusy(false); }
  };
  const removeEntry = async (file: IProjectFile) => {
    if (!sandboxId || busy || operationLock.current || !confirm(file.is_directory ? t("explorer.confirmDeleteFolder", { name: entryName(file.path) }) : t("explorer.confirmDeleteFile", { name: entryName(file.path) }))) return;
    const id = sandboxId;
    const version = ++operationVersion.current;
    const isCurrent = () => activeId.current === id && operationVersion.current === version;
    operationLock.current = true;
    setBusy(true);
    setOperation({ kind: "delete", status: "running", label: file.is_directory ? t("explorer.deletingFolder") : t("explorer.deletingFile"), detail: file.path, paths: [file.path] });
    try {
      const ok = await deleteFile(id, file.path);
      if (!isCurrent()) return;
      if (ok) {
        setOperation(previous => previous && { ...previous, status: "success", label: file.is_directory ? t("explorer.folderDeleted") : t("explorer.fileDeleted") });
        setSelectedPath(null);
        if (useWorkspaceTabsStore.getState().closeDeletedFileTabs(file.path)) {
          useChatStore.getState().reset();
          router.push("/new");
        }
      } else {
        setOperation(previous => previous && { ...previous, status: "error", label: t("explorer.deletionFailed"), detail: useSandboxProjectsStore.getState().errorMessage || t("explorer.pleaseTryAgain") });
        reportError(t("explorer.unableToDelete"));
      }
    } finally {
      if (isCurrent()) { setBusy(false); operationLock.current = false; }
    }
  };
  const upload = useCallback(async (selection: UploadSelection | Promise<UploadSelection>) => {
    if (!sandboxId || busy || operationLock.current) return;
    const id = sandboxId;
    const version = ++operationVersion.current;
    const isCurrent = () => activeId.current === id && operationVersion.current === version;
    const destination = targetFolder;
    operationLock.current = true;
    setBusy(true);
    setOperation({ kind: "upload", status: "running", label: t("explorer.preparingUpload"), detail: destination, paths: [] });
    let uploaded = 0;
    let failed = 0;
    let createdFolders = 0;
    let total = 0;
    let refreshNeeded = false;
    try {
      const incoming = await selection;
      if (!isCurrent()) return;
      total = incoming.files.length;
      if (!total && !incoming.directories.length) { setOperation(null); return; }
      // Validate every path before writing, and retain the hierarchy of folder uploads.
      const items = incoming.files.map(item => ({ ...item, path: uploadDestination(destination, item.relativePath) }));
      const directories = incoming.directories.map(path => uploadDestination(destination, path));
      const pending = [...directories.map(path => ({ path, is_directory: true })), ...items.map(item => ({ path: item.path, is_directory: false }))]
        .map(item => ({ ...item, uuid: item.path, file_size_bytes: 0, sha256: "", mime_type: item.is_directory ? "inode/directory" : "", modified_at: null, created_at: "" }));
      setUploadEntries(pending);
      const parents = new Set<string>();
      for (const entry of pending) {
        let parent = parentPath(entry.path);
        while (parent !== activeRoot && parent.startsWith(`${activeRoot}/`)) { parents.add(parent); parent = parentPath(parent); }
      }
      setExpanded(previous => new Set([...previous, ...parents]));
      setQuery("");
      const paths = pending.map(entry => entry.path);
      const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0);
      let completedBytes = 0;
      const update = (label: string, detail: string, progress?: number) => {
        if (isCurrent()) setOperation({ kind: "upload", status: "running", label, detail, paths, progress });
      };
      // Explicit directory creation also preserves empty folders from drag and drop.
      for (const path of directories) {
        if (!isCurrent()) return;
        update(t("explorer.creatingFolders"), path);
        refreshNeeded = true;
        const ok = await createFileOrFolder(id, path, true, { refresh: false });
        if (!isCurrent()) return;
        if (ok) createdFolders++;
        else { failed++; reportError(t("explorer.unableToCreate", { name: entryName(path) })); }
      }
      for (let index = 0; index < items.length; index++) {
        if (!isCurrent()) return;
        const item = items[index];
        const label = t("explorer.uploadingFile", { current: index + 1, total });
        const progress = (fraction: number) => totalBytes ? (completedBytes + item.file.size * fraction) / totalBytes : index / total;
        update(label, item.relativePath, progress(0));
        refreshNeeded = true;
        const ok = await uploadFile(id, item.file, item.path, { refresh: false, onProgress: fraction => {
          update(fraction === 1 ? t("explorer.savingFile", { current: index + 1, total }) : label, item.relativePath, progress(fraction));
        } });
        if (!isCurrent()) return;
        completedBytes += item.file.size;
        if (ok) uploaded++;
        else { failed++; reportError(t("explorer.unableToUpload", { name: item.relativePath })); }
      }
      if (!isCurrent()) return;
      update(t("explorer.updatingFiles"), destination, 1);
      // Keep the current tree visible; reconcile once at the end of the batch.
      await fetchFiles(id);
      refreshNeeded = false;
      if (!isCurrent()) return;
      const summaryParts = [
        t("explorer.uploadSummaryCount", { uploaded, total }),
        createdFolders ? t("explorer.uploadSummaryFolders", { count: createdFolders }) : "",
        failed ? t("explorer.uploadSummaryFailed", { count: failed }) : "",
      ].filter(Boolean);
      setOperation({ kind: "upload", status: failed ? "error" : "success", label: failed ? t("explorer.uploadIncomplete") : t("explorer.uploadComplete"), detail: summaryParts.join(" · "), paths: [], progress: 1 });
    } catch (error) {
      if (isCurrent()) {
        setOperation({ kind: "upload", status: "error", label: t("explorer.uploadFailed"), detail: error instanceof Error ? error.message : t("explorer.pleaseTryAgain"), paths: [] });
      }
    } finally {
      if (isCurrent()) {
        if (refreshNeeded) await fetchFiles(id);
        if (isCurrent()) { setUploadEntries([]); setBusy(false); operationLock.current = false; }
      }
    }
  }, [sandboxId, busy, targetFolder, uploadFile, createFileOrFolder, fetchFiles, t]);
  const clone = async () => {
    if (!sandboxId || !repoUrl.trim() || cloning || connectingGithub) return;
    const id = sandboxId;
    setCloning(true);
    setCloneError("");
    setCloneLog("");
    try {
      await cloneRepository(id, repoUrl.trim(), (text) => setCloneLog((previous) => previous + text));
      if (activeId.current === id) toaster.create({ title: t("explorer.repoCloned"), type: "success" });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("explorer.cloneFailed");
      setCloneError(message);
      toaster.create({ title: message, type: "error" });
    } finally { setCloning(false); }
  };
  const onTreeKeyDown = (event: React.KeyboardEvent) => {
    if ((event.target as HTMLElement).closest("button, input, [role=menu]")) return;
    if (busy && ["Enter", "F2", "Delete"].includes(event.key)) { event.preventDefault(); return; }
    const index = rows.findIndex(({ file }) => file.path === selectedPath);
    const file = rows[index]?.file;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = index < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      if (rows[next]) setSelectedPath(rows[next].file.path);
    } else if (event.key === "ArrowRight" && file?.is_directory) {
      event.preventDefault();
      if (!expanded.has(file.path)) toggleFolder(file.path);
      else if (rows[index + 1]) setSelectedPath(rows[index + 1].file.path);
    } else if (event.key === "ArrowLeft" && file) {
      event.preventDefault();
      if (file.is_directory && expanded.has(file.path)) toggleFolder(file.path);
      else setSelectedPath(parentPath(file.path) === activeRoot ? null : parentPath(file.path));
    } else if (event.key === "Enter" && file) {
      event.preventDefault();
      if (file.is_directory) toggleFolder(file.path); else openFileTab(file, undefined, undefined, { preview: true });
    } else if (event.key === "F2" && file) {
      event.preventDefault(); openEntryDialog("rename");
    } else if (event.key === "Delete" && file) {
      event.preventDefault(); void removeEntry(file);
    }
  };

  useEffect(() => {
    const row = treeRef.current?.querySelector('[aria-selected="true"]');
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedPath]);

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background text-foreground"
      onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer.types.includes("Files")) setDragging(true); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); setDragging(false); if (sandboxId && !busy && !operationLock.current) void upload(droppedUploadFiles(event.dataTransfer)); }}>
      <div className="workspace-tool-header workspace-tool-toolbar justify-between">
        <span className="min-w-0 truncate px-2 text-xs font-medium text-muted-foreground" title={activeRoot}>
          {currentSandbox?.workspace_uuid === workspaceUuid ? currentSandbox.display_name : t("explorer.title")}
        </span>
        <div className="flex items-center gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" title={t("explorer.fileActions")} aria-label={t("explorer.fileActions")} disabled={!sandboxId || busy} className="workspace-tool-icon-button"><LuFilePlus className="h-4 w-4" /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => openEntryDialog("file")}><LuFilePlus className="mr-2 h-4 w-4" />{t("explorer.newFile")}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => uploadInput.current?.click()}><LuUpload className="mr-2 h-4 w-4" />{t("explorer.uploadFiles")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" title={t("explorer.folderActions")} aria-label={t("explorer.folderActions")} disabled={!sandboxId || busy} className="workspace-tool-icon-button"><LuFolderPlus className="h-4 w-4" /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => openEntryDialog("folder")}><LuFolderPlus className="mr-2 h-4 w-4" />{t("explorer.newFolder")}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => { setCloneLog(""); setCloneError(""); setRepoUrl(""); setCloneOpen(true); }}><LuGithub className="mr-2 h-4 w-4" />{t("explorer.githubClone")}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => folderUploadInput.current?.click()}><LuFolderOpen className="mr-2 h-4 w-4" />{t("explorer.uploadFolder")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button type="button" title={t("explorer.refreshFiles")} aria-label={t("explorer.refreshFiles")} disabled={!sandboxId || refreshing || busy} onClick={() => void refresh()} className="workspace-tool-icon-button"><LuRefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} /></button>
          <button type="button" title={t("explorer.collapseFolders")} aria-label={t("explorer.collapseFolders")} onClick={() => setExpanded(new Set())} className="workspace-tool-icon-button"><LuChevronsDownUp className="h-4 w-4" /></button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><button type="button" title={t("explorer.moreActions")} aria-label={t("explorer.moreActions")} className="workspace-tool-icon-button"><LuEllipsis className="h-4 w-4" /></button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={!sandboxId} onClick={() => openTerminalTab()}><LuTerminal className="mr-2 h-4 w-4" />{t("explorer.openTerminal")}</DropdownMenuItem>
              <DropdownMenuItem disabled={!sandboxId} onClick={() => { setCpu(coresToVcpu(filesystem?.sandbox_cpu) || 4); setMemory(filesystem?.sandbox_memory || 8192); setSettingsOpen(true); }}><LuSettings className="mr-2 h-4 w-4" />{t("explorer.runtimeSettings")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="relative mx-2 my-1.5 shrink-0">
        <LuSearch className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
        <Input aria-label={t("explorer.filterFiles")} placeholder={t("explorer.filterFiles")} value={query} onChange={(event) => setQuery(event.target.value)} className="workspace-tool-field w-full !pl-7" />
      </div>

      <div ref={treeRef} role="tree" aria-label={t("explorer.filesAriaLabel")} tabIndex={0} onKeyDown={onTreeKeyDown} className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-500">
        <AnimatePresence initial={false}>
        {rows.map(({ file, depth }) => {
          const affected = affectedPaths.has(file.path);
          const pending = pendingPaths.has(file.path);
          return (
          <motion.div key={file.path} initial={{ opacity: 0, height: 0 }} animate={{ opacity: affected && operation?.kind === "delete" ? 0.45 : 1, height: 28 }} exit={{ opacity: 0, height: 0 }} transition={{ duration: reducedMotion ? 0 : 0.2 }}
            aria-busy={affected || undefined} role="treeitem" aria-level={depth + 1} aria-selected={selectedPath === file.path} aria-expanded={file.is_directory ? expanded.has(file.path) || !!query.trim() : undefined}
            onClick={() => { if (affected && (pending || operation?.kind === "delete")) return; setSelectedPath(file.path); treeRef.current?.focus(); if (file.is_directory) toggleFolder(file.path); else openFileTab(file, undefined, undefined, { preview: true }); }}
            onDoubleClick={() => { if (!file.is_directory) openFileTab(file, undefined, undefined, { preview: false }); }}
            className={cn("group flex h-7 overflow-hidden cursor-pointer items-center gap-1.5 pr-1 text-[13px]", selectedPath === file.path ? "bg-sky-500/15 text-foreground ring-1 ring-inset ring-sky-500/35" : "hover:bg-muted/60")}
            style={{ paddingLeft: 8 + depth * 16 }} title={file.path}>
            <span className="flex w-3.5 shrink-0 justify-center">{file.is_directory && (expanded.has(file.path) || query.trim() ? <LuChevronDown className="h-3.5 w-3.5" /> : <LuChevronRight className="h-3.5 w-3.5" />)}</span>
            {fileIcon(file, expanded.has(file.path))}
            <span className="min-w-0 flex-1 truncate">{entryName(file.path)}</span>
            {affected && <LuLoaderCircle aria-label={operation?.kind === "delete" ? t("explorer.deletingAriaLabel") : t("explorer.uploadingAriaLabel")} className="mr-1 h-3.5 w-3.5 shrink-0 animate-spin text-sky-500 motion-reduce:animate-none" />}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label={t("explorer.actionsFor", { name: entryName(file.path) })} disabled={busy} onClick={(event) => { event.stopPropagation(); setSelectedPath(file.path); }} className="rounded p-1 opacity-0 hover:bg-muted focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"><LuEllipsis className="h-3.5 w-3.5" /></button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                {file.is_directory && <DropdownMenuItem onClick={() => openEntryDialog("file")}><LuFilePlus className="mr-2 h-4 w-4" />{t("explorer.newFile")}</DropdownMenuItem>}
                <DropdownMenuItem onClick={() => openEntryDialog("rename")} disabled={busy}><LuPencil className="mr-2 h-4 w-4" />{t("explorer.rename")}<span className="ml-auto text-xs text-muted-foreground">F2</span></DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void removeEntry(file)} disabled={busy} className="text-red-500 focus:text-red-500"><LuTrash2 className="mr-2 h-4 w-4" />{t("explorer.delete")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </motion.div>
          );
        })}
        </AnimatePresence>
        {!rows.length && (
          <div className="workspace-tool-empty" data-files-empty-state>
            <div className="flex w-full max-w-xs flex-col items-center">
              <div className="workspace-tool-empty-icon">
                {isLoading || refreshing ? <LuLoaderCircle className="h-5 w-5 animate-spin" /> : errorMessage ? <LuCircleAlert className="h-5 w-5" /> : query ? <LuSearch className="h-5 w-5" /> : <LuFolderOpen className="h-5 w-5" />}
              </div>
              {isLoading || refreshing || (!sandboxId && !errorMessage) ? (
                <p role="status" className="text-[13px] font-medium text-foreground">{t("explorer.loadingFiles")}</p>
              ) : errorMessage ? (
                <>
                  <h3 className="workspace-tool-empty-title">{t("explorer.filesUnavailable")}</h3>
                  <p className="workspace-tool-empty-description break-words">{errorMessage}</p>
                  <Button size="sm" variant="outline" className="mt-5" onClick={() => sandboxId ? void refresh() : workspaceUuid && void fetchSandboxes(workspaceUuid)}>
                    <LuRefreshCw />{t("explorer.tryAgain")}
                  </Button>
                </>
              ) : query ? (
                <>
                  <h3 className="workspace-tool-empty-title">{t("explorer.noMatchingFiles")}</h3>
                  <p className="workspace-tool-empty-description">{t("explorer.noMatchingFilesDesc")}</p>
                  <Button size="sm" variant="ghost" className="mt-4" onClick={() => setQuery("")}>{t("explorer.clearSearch")}</Button>
                </>
              ) : (
                <>
                  <h3 className="workspace-tool-empty-title">{t("explorer.noFilesYet")}</h3>
                  <p className="workspace-tool-empty-description">{t("explorer.noFilesYetDesc")}</p>
                  <div className="mt-5 flex w-full max-w-[248px] flex-col gap-2">
                    <Button size="sm" disabled={busy} onClick={() => openEntryDialog("file")} className="h-8 w-full shadow-none">
                      <LuFilePlus />{t("explorer.newFile")}
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy || cloning} className="h-8 w-full shadow-none" onClick={() => { setCloneLog(""); setCloneError(""); setRepoUrl(""); setCloneOpen(true); }}>
                      <LuGithub />{t("explorer.githubClone")}
                    </Button>
                  </div>
                  <button type="button" disabled={busy} onClick={() => uploadInput.current?.click()} className="mt-5 inline-flex items-center gap-1.5 rounded text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50">
                    <LuUpload className="h-3 w-3" />{t("explorer.uploadFilesLower")}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
      <AnimatePresence initial={false}>{operation && <FileOperationProgress key={operation.kind} operation={operation} onDismiss={() => setOperation(null)} />}</AnimatePresence>
      <div className="workspace-tool-footer flex items-center justify-between gap-3"><span className="truncate" title={selectedPath || targetFolder}>{selectedPath || targetFolder}</span><span className="shrink-0">{entries.size === 1 ? t("explorer.itemCountOne", { count: entries.size }) : t("explorer.itemCountOther", { count: entries.size })}</span></div>
      <input ref={uploadInput} type="file" multiple aria-label={t("explorer.uploadFilesLower")} className="hidden" onChange={(event) => { void upload(selectedUploadFiles(Array.from(event.target.files || []))); event.target.value = ""; }} />
      <input ref={folderUploadInput} type="file" multiple {...{ webkitdirectory: "", directory: "" }} aria-label={t("explorer.uploadFolder")} className="hidden" onChange={(event) => { void upload(selectedUploadFiles(Array.from(event.target.files || []))); event.target.value = ""; }} />
      {dragging && <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed border-sky-500 bg-background/90 text-sm">{t("explorer.dropInto", { folder: targetFolder })}</div>}

      <Dialog open={entryDialog !== null} onOpenChange={(open) => { if (!open && !busy) setEntryDialog(null); }}>
        <DialogContent><DialogHeader><DialogTitle>{entryDialog === "rename" ? t("explorer.rename") : entryDialog === "folder" ? t("explorer.newFolder") : t("explorer.newFile")}</DialogTitle></DialogHeader>
          <p className="truncate text-xs text-muted-foreground">{entryDialog === "rename" && selected ? parentPath(selected.path) : targetFolder}</p>
          <Input aria-label={t("explorer.nameAriaLabel")} autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveEntry(); }} placeholder={entryDialog === "folder" ? t("explorer.folderNamePlaceholder") : t("explorer.fileNamePlaceholder")} disabled={busy} />
          <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setEntryDialog(null)}>{t("explorer.cancel")}</Button><Button disabled={busy || !name.trim()} onClick={() => void saveEntry()}>{busy ? t("explorer.saving") : entryDialog === "rename" ? t("explorer.rename") : t("explorer.create")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={cloneOpen} onOpenChange={open => { if (!cloning && !connectingGithub) setCloneOpen(open); }}>
        <DialogContent hideClose={cloning || connectingGithub} className="flex max-h-[90dvh] w-[calc(100%-2rem)] max-w-xl flex-col gap-0 overflow-hidden rounded-xl p-0">
          <DialogHeader className="shrink-0 border-b px-5 py-4"><DialogTitle className="flex items-center gap-2 text-base"><LuGithub className="h-5 w-5 text-violet-500" />{t("explorer.githubClone")}</DialogTitle></DialogHeader>
          <div className="space-y-4 overflow-y-auto p-5">
            {cloning || cloneLog ? <>
              <GitCloneProgress log={cloneLog} status={cloning ? "cloning" : cloneError ? "error" : "success"} repository={repoUrl} />
              {!cloning && <Button type="button" size="sm" variant="outline" onClick={() => { setCloneLog(""); setCloneError(""); }}>{t("explorer.backToRepos")}</Button>}
            </> : <>
              <GithubRepositoryAccess key={sandboxId} uuid={cloneOpen ? sandboxId : undefined} disabled={cloning} value={repoUrl} onSelect={setRepoUrl} onConnectingChange={setConnectingGithub} />
              <div className="space-y-2"><label htmlFor="files-github-repository" className="text-xs font-medium">{t("explorer.selectedRepoUrl")}</label><Input id="files-github-repository" aria-label={t("explorer.repoUrlAriaLabel")} autoFocus placeholder="https://github.com/owner/repository" value={repoUrl} onChange={event => { setRepoUrl(event.target.value); setCloneError(""); }} disabled={cloning || connectingGithub} onKeyDown={event => { if (event.key === "Enter") void clone(); }} /><p className="text-xs text-muted-foreground">{t("explorer.chooseOrPasteUrl")}</p></div>
            </>}
            {cloneError && <p role="alert" className="break-words text-xs text-destructive">{cloneError}</p>}
          </div>
          <DialogFooter className="shrink-0 gap-2 border-t bg-muted/20 px-5 py-3 sm:space-x-0"><Button variant="outline" disabled={cloning || connectingGithub} onClick={() => setCloneOpen(false)}>{t("explorer.close")}</Button>{(!cloneLog || cloneError || cloning) && <Button disabled={cloning || connectingGithub || !repoUrl.trim() || !sandboxId} onClick={() => void clone()}>{cloning ? t("explorer.cloning") : t("explorer.cloneRepo")}</Button>}</DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent><DialogHeader><DialogTitle>{t("explorer.runtimeSettings")}</DialogTitle></DialogHeader>
          <p className="text-xs text-muted-foreground">{t("explorer.runtimeSettingsDesc")}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {COMPUTE_TIERS.map((tier) => {
              const selected = cpu === tier.cpu && memory === tier.memory_mb;
              return (
                <button
                  key={tier.id}
                  type="button"
                  onClick={() => { setCpu(tier.cpu); setMemory(tier.memory_mb); }}
                  className={cn("rounded-xl border px-3 py-2.5 text-left text-xs transition-colors", selected ? "border-primary bg-primary/10 text-primary" : "border-border/60 hover:bg-muted/40")}
                >
                  <span className="block font-semibold">{tier.label}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">{t("explorer.tierSpecs", { memory: tier.memory_gb, disk: tier.disk_gb })}</span>
                </button>
              );
            })}
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setSettingsOpen(false)}>{t("explorer.cancel")}</Button><Button disabled={busy || !sandboxId || !COMPUTE_TIERS.some((t) => t.cpu === cpu && t.memory_mb === memory)} onClick={async () => {
            if (!sandboxId) return; setBusy(true);
            try { if (await updateSandbox(sandboxId, { sandbox_cpu: vcpuToCores(cpu), sandbox_memory: memory })) setSettingsOpen(false); else reportError(t("explorer.unableToUpdateResources")); } finally { setBusy(false); }
          }}>{t("explorer.save")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default FileSystemExplorer;
