"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Link } from "react-router-dom";
import { useParams, useRouter } from "@/lib/navigation";
import {
  LuArrowLeft,
  LuArrowUpRight,
  LuCheck,
  LuCircleAlert,
  LuCircleCheck,
  LuEllipsis,
  LuEraser,
  LuFileText,
  LuFolderCode,
  LuFolderOpen,
  LuGitBranch,
  LuKeyRound,
  LuLoader,
  LuLoaderCircle,
  LuMessageSquare,
  LuNotebookPen,
  LuPencil,
  LuPin,
  LuPlay,
  LuPlus,
  LuSearch,
  LuSparkles,
  LuTerminal,
  LuTrash2,
  LuUpload,
  LuX,
} from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { toaster } from "@/components/ui/toaster";
import { authedAxios, API_BASE } from "@/lib/axios";
import { ENVIRONMENT_PRESETS, formatBytesCompact } from "@/lib/environment-presets";
import { cn } from "@/lib/utils";
import EditProjectDialog from "@/components/projects/edit-project-dialog";
import useAuthStore from "@/stores/auth";
import useChatStore from "@/stores/chat";
import useSandboxProjectsStore from "@/stores/sandbox-projects";
import useSidebarStore, { Conversation } from "@/stores/sidebar";
import useWorkspacesStore from "@/stores/workspaces";
import useWorkspaceTabsStore from "@/stores/workspace-tabs";
import type { IProject } from "@/stores/sandbox-projects";

interface ProjectNote {
  uuid: string;
  content: string;
  created_at: string;
}

interface EnvSecretItem {
  uuid: string;
  key: string;
  masked_value: string;
  description: string;
  scope?: "workspace" | "environment";
  overridden?: boolean;
}

function errorText(error: unknown, fallback: string) {
  const response = error as { response?: { data?: Record<string, unknown> | string }; message?: string };
  const data = response?.response?.data;
  if (typeof data === "string" && data.trim()) return data;
  if (data && typeof data === "object") {
    for (const key of ["key", "value", "content", "error", "detail"]) {
      const val = data[key];
      if (Array.isArray(val) && val.length > 0) return String(val[0]);
      if (typeof val === "string" && val.trim()) return val;
    }
  }
  return response?.message || fallback;
}

function relativeTime(value: string | undefined, t: TFunction<"workspace">, locale: string) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  if (minutes < 1) return t("projectDetail.relativeTime.justNow");
  if (minutes < 60) return t("projectDetail.relativeTime.minutesAgo", { count: minutes });
  if (minutes < 1440) return t("projectDetail.relativeTime.hoursAgo", { count: Math.floor(minutes / 60) });
  if (minutes < 10080) return t("projectDetail.relativeTime.daysAgo", { count: Math.floor(minutes / 1440) });
  return date.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

const tabClass = "relative h-11 gap-2 rounded-none border-b-2 border-transparent px-3 text-xs text-muted-foreground transition-colors data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none sm:px-4 sm:text-sm";

export default function ProjectDetailClient() {
  const { t, i18n } = useTranslation("workspace");
  const locale = i18n.resolvedLanguage || "en";
  const { slug = "" } = useParams<{ slug: string }>();
  const router = useRouter();
  const token = useAuthStore((state) => state.token);
  const { currentWorkspace, currentWorkspaceUuid } = useWorkspacesStore();
  const workspaceUuid = currentWorkspace?.uuid || currentWorkspaceUuid;
  const { sandboxes, fetchSandboxes, pickSandbox, updateSandbox, deleteSandbox } = useSandboxProjectsStore();
  const { projectConversations, fetchConversations, isLoading: chatsLoading, isLoadingMore, hasMore, conversationProjectId } = useSidebarStore();
  const generatingConversations = useChatStore((state) => state.generatingConversations);
  const [loaded, setLoaded] = useState<{ scope: string; project: IProject } | null>(null);
  const [projectLoading, setProjectLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [tab, setTab] = useState("chats");
  const [search, setSearch] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const [pinning, setPinning] = useState(false);
  const scope = `${workspaceUuid || ""}:${slug}`;
  const project = sandboxes.find((item) => item.workspace_uuid === workspaceUuid && (item.slug === slug || item.uuid === slug))
    || (loaded?.scope === scope ? loaded.project : null);
  const projectUuid = project?.uuid;
  const activeProjectRef = useRef(projectUuid);

  const [instructions, setInstructions] = useState("");
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [instructionsError, setInstructionsError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");

  // Scripts & Cache inline tab state
  const [defaultBranch, setDefaultBranch] = useState("");
  const [workingSubdir, setWorkingSubdir] = useState("");
  const [setupScript, setSetupScript] = useState("");
  const [maintenanceScript, setMaintenanceScript] = useState("");
  const [savingScripts, setSavingScripts] = useState(false);
  const [runningSetup, setRunningSetup] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [scriptsError, setScriptsError] = useState("");

  // Secrets inline tab state
  const [secrets, setSecrets] = useState<EnvSecretItem[]>([]);
  const [inheritedSecrets, setInheritedSecrets] = useState<EnvSecretItem[]>([]);
  const [canManageSecrets, setCanManageSecrets] = useState(true);
  const [secretsLoading, setSecretsLoading] = useState(false);
  const [newSecretKey, setNewSecretKey] = useState("");
  const [newSecretValue, setNewSecretValue] = useState("");
  const [showBulkSecrets, setShowBulkSecrets] = useState(false);
  const [bulkSecretsText, setBulkSecretsText] = useState("");
  const [secretBusy, setSecretBusy] = useState(false);
  const [secretError, setSecretError] = useState("");

  const [notes, setNotes] = useState<ProjectNote[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesError, setNotesError] = useState("");
  const [notesAttempt, setNotesAttempt] = useState(0);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [deletingNote, setDeletingNote] = useState<string | null>(null);

  useEffect(() => {
    activeProjectRef.current = projectUuid;
    setTab("chats");
    setSearch("");
    setNewNote("");
    setNotes([]);
    setNotesError("");
    setSettingsOpen(false);
    setRemoveOpen(false);
  }, [projectUuid]);

  useEffect(() => {
    setInstructions(project?.usage_guide || "");
    setInstructionsError("");
  }, [projectUuid, project?.usage_guide]);

  useEffect(() => {
    setDefaultBranch(project?.default_branch || "main");
    setWorkingSubdir(project?.working_subdir || "");
    setSetupScript(project?.setup_script || "");
    setMaintenanceScript(project?.maintenance_script || "");
    setScriptsError("");
  }, [projectUuid, project?.default_branch, project?.working_subdir, project?.setup_script, project?.maintenance_script]);

  const fetchSecrets = useCallback(async () => {
    if (!workspaceUuid || !projectUuid) return;
    setSecretsLoading(true);
    setSecretError("");
    try {
      const { data } = await authedAxios.get(`${API_BASE}/sandbox/workspaces/${workspaceUuid}/vm-secrets/`, {
        params: { sandbox_uuid: projectUuid },
      });
      setSecrets(Array.isArray(data?.secrets) ? data.secrets : []);
      setInheritedSecrets(Array.isArray(data?.inherited_secrets) ? data.inherited_secrets : []);
      setCanManageSecrets(data?.can_manage !== false);
    } catch (err) {
      setSecretError(errorText(err, "Could not load environment secrets."));
    } finally {
      setSecretsLoading(false);
    }
  }, [workspaceUuid, projectUuid]);

  useEffect(() => {
    if (tab === "secrets") {
      void fetchSecrets();
    }
  }, [tab, fetchSecrets]);

  useEffect(() => {
    if (!token || !workspaceUuid) return;
    let cancelled = false;
    const controller = new AbortController();
    setProjectLoading(true);
    setLoadError("");
    const load = async () => {
      try {
        let projects = useSandboxProjectsStore.getState().sandboxes;
        let matched = projects.find((item) => item.workspace_uuid === workspaceUuid && (item.slug === slug || item.uuid === slug));
        if (!matched) {
          projects = await fetchSandboxes(workspaceUuid);
          if (cancelled) return;
          matched = projects.find((item) => item.slug === slug || item.uuid === slug);
        }
        if (!matched) {
          const response = await authedAxios.get<IProject>(`${API_BASE}/sandbox/sandboxes/${encodeURIComponent(slug)}/`, { signal: controller.signal });
          matched = response.data;
        }
        if (cancelled) return;
        if (matched.workspace_uuid !== workspaceUuid) throw new Error(t("projectDetail.errors.unavailableInWorkspace"));
        setLoaded({ scope, project: matched });
        setProjectLoading(false);
        if (useSandboxProjectsStore.getState().currentSandbox?.uuid !== matched.uuid) await pickSandbox(matched.uuid);
      } catch (error) {
        if (!cancelled) setLoadError(errorText(error, t("projectDetail.errors.loadFailed")));
      } finally {
        if (!cancelled) setProjectLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; controller.abort(); };
  }, [slug, workspaceUuid, scope, token, fetchSandboxes, pickSandbox, loadAttempt, t]);

  useEffect(() => {
    if (projectUuid && token) void fetchConversations(false, projectUuid);
  }, [projectUuid, token, fetchConversations]);

  useEffect(() => {
    if (!projectUuid || !token) return;
    const controller = new AbortController();
    setNotesLoading(true);
    setNotesError("");
    void authedAxios.get(`${API_BASE}/tools/note/list/`, { params: { sandbox_uuid: projectUuid }, signal: controller.signal })
      .then(({ data }) => { if (!controller.signal.aborted) setNotes(data.notes || []); })
      .catch((error) => { if (!controller.signal.aborted) setNotesError(errorText(error, t("projectDetail.errors.notesLoadFailed"))); })
      .finally(() => { if (!controller.signal.aborted) setNotesLoading(false); });
    return () => controller.abort();
  }, [projectUuid, token, notesAttempt, t]);

  const chats = useMemo(() => projectUuid ? projectConversations[projectUuid] || [] : [], [projectUuid, projectConversations]);
  const filteredChats = useMemo(() => chats.filter((chat) => (chat.title || t("projectDetail.chats.untitled")).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())), [chats, search, t]);
  const ownChatRequest = conversationProjectId === projectUuid;
  const instructionsChanged = instructions !== (project?.usage_guide || "");

  const ensureProject = async () => {
    if (!project) return null;
    const store = useSandboxProjectsStore.getState();
    const selected = store.currentSandbox?.uuid === project.uuid ? store.currentSandbox : await pickSandbox(project.uuid);
    if (!selected) toaster.create({ title: t("projectDetail.toasts.projectUnavailable"), description: useSandboxProjectsStore.getState().errorMessage || t("common.pleaseTryAgain"), type: "error" });
    return selected;
  };

  const openChat = async (conversation?: Conversation) => {
    if (opening) return;
    setOpening(conversation?.uuid || "new");
    try {
      if (!await ensureProject()) return;
      const chatStore = useChatStore.getState();
      chatStore.setChatMode("code");
      if (conversation) {
        useWorkspaceTabsStore.getState().openChatTab(conversation.uuid, conversation.title, "left");
        chatStore.switchConversation(conversation.uuid);
        router.push(`/chat/${conversation.uuid}`);
      } else {
        chatStore.reset();
        useWorkspaceTabsStore.getState().openChatTab(undefined, undefined, "left");
        router.push("/new");
      }
    } finally { setOpening(null); }
  };

  const openFiles = async () => {
    if (opening) return;
    setOpening("files");
    try {
      if (!await ensureProject()) return;
      useWorkspaceTabsStore.getState().openFilesTab();
      const { tabs, activeTabId } = useWorkspaceTabsStore.getState();
      const activeTab = tabs.find((item) => item.id === activeTabId);
      const conversationUuid = activeTab?.type === "chat" ? activeTab.conversationUuid : useChatStore.getState().conversationId;
      router.push(conversationUuid ? `/chat/${conversationUuid}` : "/new");
    } finally { setOpening(null); }
  };

  const togglePin = async () => {
    if (!project || pinning) return;
    setPinning(true);
    try {
      const updated = await updateSandbox(project.uuid, { is_favorite: !project.is_favorite });
      if (!updated) throw new Error(useSandboxProjectsStore.getState().errorMessage || t("projectDetail.errors.projectUpdateFailed"));
      setLoaded({ scope, project: updated });
    } catch (error) { toaster.create({ title: t("projectDetail.errors.pinUpdateFailed"), description: errorText(error, t("common.pleaseTryAgain")), type: "error" }); }
    finally { setPinning(false); }
  };

  const saveInstructions = async () => {
    if (!project || savingInstructions) return;
    setSavingInstructions(true);
    setInstructionsError("");
    try {
      const updated = await updateSandbox(project.uuid, { usage_guide: instructions });
      if (!updated) throw new Error(useSandboxProjectsStore.getState().errorMessage || t("projectDetail.errors.instructionsSaveFailed"));
      setLoaded({ scope, project: updated });
      toaster.create({ title: t("projectDetail.toasts.instructionsSaved"), type: "success" });
    } catch (error) { setInstructionsError(errorText(error, t("projectDetail.errors.instructionsSaveFailed"))); }
    finally { setSavingInstructions(false); }
  };

  const scriptsChanged =
    defaultBranch !== (project?.default_branch || "main") ||
    workingSubdir !== (project?.working_subdir || "") ||
    setupScript !== (project?.setup_script || "") ||
    maintenanceScript !== (project?.maintenance_script || "");

  const saveScripts = async () => {
    if (!project || savingScripts) return null;
    setSavingScripts(true);
    setScriptsError("");
    try {
      const updated = await updateSandbox(project.uuid, {
        default_branch: defaultBranch.trim() || "main",
        working_subdir: workingSubdir.trim().replace(/^\/+|\/+$/g, ""),
        setup_script: setupScript.trim(),
        maintenance_script: maintenanceScript.trim(),
      });
      if (!updated) throw new Error(useSandboxProjectsStore.getState().errorMessage || t("projects.edit.updateFailed"));
      setLoaded({ scope, project: updated });
      toaster.create({ title: t("projects.edit.toastUpdated"), type: "success" });
      return updated;
    } catch (error) {
      setScriptsError(errorText(error, t("projects.edit.updateFailed")));
      return null;
    } finally {
      setSavingScripts(false);
    }
  };

  const handleRunSetup = async () => {
    if (!project || runningSetup) return;
    setRunningSetup(true);
    setScriptsError("");
    try {
      if (scriptsChanged) {
        const saved = await saveScripts();
        if (!saved) return;
      }
      const res = await useSandboxProjectsStore.getState().runEnvironmentSetup(project.uuid, { force: true });
      if (res.environment) setLoaded({ scope, project: res.environment });
      if (res.ready) {
        toaster.create({ title: t("projects.edit.setupSucceeded", "Environment setup completed"), type: "success" });
      } else {
        setScriptsError(res.error || t("projects.edit.setupFailed", "Environment setup failed."));
      }
    } finally {
      setRunningSetup(false);
    }
  };

  const handleClearCache = async () => {
    if (!project || clearingCache) return;
    setClearingCache(true);
    setScriptsError("");
    try {
      const res = await useSandboxProjectsStore.getState().clearEnvironmentDepsCache(project.uuid);
      if (res.environment) setLoaded({ scope, project: res.environment });
      if (res.cleared) {
        toaster.create({ title: t("projects.edit.cacheCleared", "Dependency cache cleared"), type: "success" });
      } else {
        setScriptsError(res.error || t("projects.edit.cacheClearFailed", "Could not clear dependency cache."));
      }
    } finally {
      setClearingCache(false);
    }
  };

  const handleAddSecret = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!workspaceUuid || !project || !newSecretKey.trim() || !newSecretValue || secretBusy) return;
    setSecretBusy(true);
    setSecretError("");
    try {
      await authedAxios.post(`${API_BASE}/sandbox/workspaces/${workspaceUuid}/vm-secrets/`, {
        key: newSecretKey.trim(),
        value: newSecretValue,
        sandbox_uuid: project.uuid,
      });
      setNewSecretKey("");
      setNewSecretValue("");
      await fetchSecrets();
      toaster.create({ title: t("projects.edit.secretSaved", "Secret saved"), type: "success" });
    } catch (err) {
      setSecretError(errorText(err, "Could not save secret."));
    } finally {
      setSecretBusy(false);
    }
  };

  const handleBulkImportSecrets = async () => {
    if (!workspaceUuid || !project || !bulkSecretsText.trim() || secretBusy) return;
    setSecretBusy(true);
    setSecretError("");
    try {
      await authedAxios.post(`${API_BASE}/sandbox/workspaces/${workspaceUuid}/vm-secrets/bulk-import/`, {
        content: bulkSecretsText,
        sandbox_uuid: project.uuid,
      });
      setBulkSecretsText("");
      setShowBulkSecrets(false);
      await fetchSecrets();
      toaster.create({ title: t("projects.edit.secretsImported", "Secrets imported"), type: "success" });
    } catch (err) {
      setSecretError(errorText(err, "Could not import secrets."));
    } finally {
      setSecretBusy(false);
    }
  };

  const handleDeleteSecret = async (secretUuid: string) => {
    if (!workspaceUuid || secretBusy) return;
    setSecretBusy(true);
    setSecretError("");
    try {
      await authedAxios.delete(`${API_BASE}/sandbox/workspaces/${workspaceUuid}/vm-secrets/${secretUuid}/`);
      await fetchSecrets();
    } catch (err) {
      setSecretError(errorText(err, "Could not delete secret."));
    } finally {
      setSecretBusy(false);
    }
  };

  const removeProject = async () => {
    if (!project || removing) return;
    setRemoving(true);
    setRemoveError("");
    try {
      if (!await deleteSandbox(project.uuid)) throw new Error(useSandboxProjectsStore.getState().errorMessage || t("projectDetail.errors.projectRemoveFailed"));
      setRemoveOpen(false);
      router.push("/new");
      toaster.create({ title: t("projectDetail.toasts.projectRemoved"), type: "success" });
    } catch (error) { setRemoveError(errorText(error, t("projectDetail.errors.projectRemoveFailed"))); }
    finally { setRemoving(false); }
  };

  const addNote = async () => {
    if (!project || !newNote.trim() || addingNote) return;
    const uuid = project.uuid;
    setAddingNote(true);
    setNotesError("");
    try {
      const { data } = await authedAxios.post<ProjectNote>(`${API_BASE}/tools/note/add/`, { content: newNote.trim(), sandbox_uuid: uuid });
      if (activeProjectRef.current === uuid) { setNotes((items) => [data, ...items]); setNewNote(""); }
    } catch (error) { if (activeProjectRef.current === uuid) setNotesError(errorText(error, t("projectDetail.errors.noteAddFailed"))); }
    finally { setAddingNote(false); }
  };

  const deleteNote = async (note: ProjectNote) => {
    if (!project || deletingNote) return;
    const uuid = project.uuid;
    setDeletingNote(note.uuid);
    setNotesError("");
    try {
      const { data } = await authedAxios.post(`${API_BASE}/tools/note/remove/`, { uuid: note.uuid, sandbox_uuid: uuid });
      if (activeProjectRef.current === uuid) setNotes((items) => items.filter((item) => item.uuid !== data.removed_uuid));
    } catch (error) { if (activeProjectRef.current === uuid) setNotesError(errorText(error, t("projectDetail.errors.noteDeleteFailed"))); }
    finally { setDeletingNote(null); }
  };

  if (!project && projectLoading) return (
    <div className="mx-auto max-w-5xl px-5 py-10 sm:px-8" role="status" aria-label={t("projectDetail.loadingProjectAria")}>
      <div className="mb-4 h-4 w-24 animate-pulse rounded bg-muted" />
      <div className="h-8 w-56 animate-pulse rounded bg-muted" />
      <div className="mt-3 h-4 w-72 max-w-full animate-pulse rounded bg-muted" />
      <div className="mt-10 h-10 animate-pulse rounded bg-muted" />
      <div className="mt-5 space-y-3">{[1, 2, 3].map((row) => <div key={row} className="h-14 animate-pulse rounded-lg bg-muted" />)}</div>
    </div>
  );

  if (!project) return (
    <div className="mx-auto max-w-md px-5 py-20 text-center">
      <LuFolderCode className="mx-auto mb-4 h-8 w-8 text-muted-foreground" />
      <h1 className="text-lg font-semibold">{t("projectDetail.unavailableTitle")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{loadError || t("projectDetail.unavailableDescription")}</p>
      <div className="mt-6 flex justify-center gap-2">
        <Button variant="outline" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>{t("common.tryAgain")}</Button>
        <Button asChild>
          <Link to="/new">{t("projectDetail.backToChats")}</Link>
        </Button>
      </div>
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-12 pt-6 text-foreground sm:px-8 sm:pt-9 lg:px-10" aria-label={t("projectDetail.detailAria")}>
      <Link to="/new" className="mb-6 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <LuArrowLeft className="h-3.5 w-3.5" />{t("projectDetail.backToChats")}</Link>
      <header className="mb-7 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-muted">
            <LuFolderCode className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="break-words text-2xl font-semibold tracking-tight">{project.display_name}</h1>
              {project.setup_status === "ready" && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                  <LuCircleCheck className="h-3 w-3" />{t("projects.edit.statusReady", "Ready")}
                </span>
              )}
              {project.setup_status === "running" && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                  <LuLoaderCircle className="h-3 w-3 animate-spin" />{t("projects.edit.statusRunning", "Running")}
                </span>
              )}
              {project.setup_status === "failed" && (
                <span className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-[11px] font-medium text-destructive">
                  <LuCircleAlert className="h-3 w-3" />{t("projects.edit.statusFailed", "Failed")}
                </span>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] leading-relaxed text-muted-foreground">
              <span className="break-all">{project.repo_full_name || project.filesystem_path || `/workspace/${project.slug}`}</span>
              {project.default_branch && (
                <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px]">
                  <LuGitBranch className="h-3 w-3" />{project.default_branch}
                </span>
              )}
            </div>
            {project.description && <p className="mt-3 max-w-xl whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{project.description}</p>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => void openFiles()} disabled={Boolean(opening)}>
            <LuFolderOpen />{t("common.files")}</Button>
          <Button size="sm" onClick={() => void openChat()} disabled={Boolean(opening)} loading={opening === "new"}>
            <LuPlus />{t("common.newChat")}</Button>
          <span className="mx-1 h-5 w-px bg-border" />
          <Button variant="ghost" size="icon-sm" aria-label={project.is_favorite ? t("projectDetail.unpinProject") : t("projectDetail.pinProject")} aria-pressed={project.is_favorite} onClick={() => void togglePin()} disabled={pinning} className={cn(project.is_favorite && "text-foreground bg-muted")}>
            <LuPin className="rotate-45" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t("projectDetail.actionsAria")}>
                <LuEllipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
                <LuPencil />{t("projects.edit.title")}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => { setRemoveError(""); setRemoveOpen(true); }}>
                <LuTrash2 />{t("projectDetail.removeProject")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label={t("projectDetail.sectionsAria")} className="mb-6 flex h-auto w-full justify-start gap-1 overflow-x-auto rounded-none border-b border-border bg-transparent p-0">
          <TabsTrigger value="chats" className={tabClass}>
            <LuMessageSquare className="hidden h-3.5 w-3.5 sm:block" />{t("projectDetail.tabs.chats")}<span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">{chats.length}</span>
          </TabsTrigger>
          <TabsTrigger value="scripts" className={tabClass}>
            <LuTerminal className="hidden h-3.5 w-3.5 sm:block" />{t("projects.edit.tabScripts", "Scripts & Cache")}
          </TabsTrigger>
          <TabsTrigger value="secrets" className={tabClass}>
            <LuKeyRound className="hidden h-3.5 w-3.5 sm:block" />{t("projects.edit.tabSecrets", "Secrets")}{(secrets.length || project.secret_count || 0) > 0 && <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">{secrets.length || project.secret_count}</span>}
          </TabsTrigger>
          <TabsTrigger value="instructions" className={tabClass}>
            <LuFileText className="hidden h-3.5 w-3.5 sm:block" />{t("projectDetail.tabs.instructions")}</TabsTrigger>
          <TabsTrigger value="notes" className={tabClass}>
            <LuNotebookPen className="hidden h-3.5 w-3.5 sm:block" />{t("projectDetail.tabs.notes")}{notes.length > 0 && <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">{notes.length}</span>}</TabsTrigger>
        </TabsList>

        <TabsContent value="chats" className="mt-0">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="relative w-full max-w-sm">
              <LuSearch className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input aria-label={t("projectDetail.chats.searchAria")} placeholder={t("projectDetail.chats.searchPlaceholder")} value={search} onChange={(event) => setSearch(event.target.value)} className="h-9 bg-background pl-9 pr-8 text-xs" />{search && <button type="button" aria-label={t("projectDetail.chats.clearSearchAria")} onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <LuX className="h-3.5 w-3.5" />
              </button>}</div>
            <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:block">{t("projectDetail.chats.lastMessage")}</span>
          </div>
          {chatsLoading && ownChatRequest && chats.length === 0 ? (
            <div role="status" aria-label={t("projectDetail.chats.loadingAria")} className="space-y-2 py-3">{[1, 2, 3].map((row) => <div key={row} className="h-14 animate-pulse rounded-lg bg-muted" />)}</div>
          ) : filteredChats.length === 0 ? (
            <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-5 py-14 text-center">
              {search ? <LuSearch className="mb-4 h-6 w-6 text-muted-foreground opacity-60" /> : <LuMessageSquare className="mb-4 h-6 w-6 text-muted-foreground opacity-60" />}
              <h2 className="text-sm font-medium">{search ? t("projectDetail.chats.emptySearchTitle") : t("projectDetail.chats.emptyTitle")}</h2>
              <p className="mt-2 max-w-xs text-xs leading-relaxed text-muted-foreground">{search ? t("projectDetail.chats.emptySearchDescription") : t("projectDetail.chats.emptyDescription")}</p>
              <Button variant="outline" size="sm" className="mt-5" onClick={() => search ? setSearch("") : void openChat()} disabled={Boolean(opening)}>{search ? t("projectDetail.chats.clearSearch") : <>
                <LuPlus />{t("common.newChat")}</>}</Button>
            </div>
          ) : (
            <ul className="divide-y divide-border" aria-label={t("projectDetail.chats.listAria")}>
              {filteredChats.map((conversation) => {
                const generating = Boolean(generatingConversations[conversation.uuid] ?? conversation.is_generating);
                const activity = conversation.last_activity_at || conversation.created_at;
                return <li key={conversation.uuid}>
                  <button type="button" onClick={() => void openChat(conversation)} disabled={Boolean(opening)} className="group flex w-full items-center gap-3 rounded-lg px-3 py-4 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60">
                    <LuMessageSquare className="h-4 w-4 shrink-0 text-muted-foreground opacity-60" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{conversation.title || t("projectDetail.chats.untitled")}</span>{generating && <LuLoader className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-label={t("projectDetail.chats.generatingAria")} />}<time dateTime={activity} title={activity ? new Date(activity).toLocaleString(locale) : undefined} className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{relativeTime(activity, t, locale)}</time>
                    <LuArrowUpRight className="hidden h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 sm:block" />
                  </button>
                </li>;
              })}
            </ul>
          )}
          {ownChatRequest && hasMore && <div className="mt-5 flex justify-center">
            <Button variant="ghost" size="sm" loading={isLoadingMore} onClick={() => void fetchConversations(true, project.uuid)}>{t("projectDetail.chats.loadMore")}</Button>
          </div>}
        </TabsContent>

        <TabsContent value="scripts" className="mt-0 max-w-3xl space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/20 px-4 py-3 text-xs">
            <div className="space-y-0.5">
              <p className="font-medium text-foreground">{t("projects.edit.stateSummaryTitle", "Snapshot & dependency cache")}</p>
              <p className="text-[11px] text-muted-foreground">
                {project.state_saved_at
                  ? `${t("projects.edit.stateSaved", "State saved")}: ${formatBytesCompact(project.state_size_bytes)}`
                  : t("projects.edit.noStateYet", "No uncommitted state archived yet")}
                {project.deps_lock_hash ? ` · cache #${project.deps_lock_hash.slice(0, 8)}` : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 text-xs" disabled={clearingCache || runningSetup} onClick={() => void handleClearCache()}>
                {clearingCache ? <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <LuEraser className="h-3.5 w-3.5" />}
                {t("projects.edit.clearCache", "Clear cache")}
              </Button>
              <Button type="button" size="sm" className="h-8 gap-1.5 text-xs" disabled={runningSetup || savingScripts} onClick={() => void handleRunSetup()}>
                {runningSetup ? <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <LuPlay className="h-3.5 w-3.5" />}
                {t("projects.edit.runSetup", "Run setup")}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <LuSparkles className="h-3 w-3" />{t("projects.create.presetsLabel", "Quick stack presets")}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {ENVIRONMENT_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => {
                    setSetupScript(preset.setupScript);
                    setMaintenanceScript(preset.maintenanceScript);
                  }}
                  className="rounded-md border border-border/80 bg-background px-2.5 py-1 text-xs font-medium hover:border-violet-500/50 hover:bg-violet-500/5 transition-colors"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="env-page-branch" className="text-xs font-medium">{t("projects.create.defaultBranchLabel", "Default branch")}</label>
              <Input id="env-page-branch" className="font-mono text-xs" value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} disabled={savingScripts} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="env-page-subdir" className="text-xs font-medium">{t("projects.create.workingSubdirLabel", "Working subdirectory")}</label>
              <Input id="env-page-subdir" className="font-mono text-xs" placeholder="e.g. apps/web" value={workingSubdir} onChange={(e) => setWorkingSubdir(e.target.value)} disabled={savingScripts} />
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="env-page-setup" className="text-xs font-medium">{t("projects.create.setupScriptLabel", "Setup script")}</label>
            <Textarea id="env-page-setup" rows={3} className="font-mono text-xs" placeholder="npm ci || uv sync" value={setupScript} onChange={(e) => setSetupScript(e.target.value)} disabled={savingScripts} />
            <p className="text-[11px] text-muted-foreground">{t("projects.create.setupScriptHelp", "Runs once when the environment boots fresh or lockfiles change.")}</p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="env-page-maint" className="text-xs font-medium">{t("projects.create.maintenanceScriptLabel", "Maintenance script")}</label>
            <Textarea id="env-page-maint" rows={2} className="font-mono text-xs" placeholder="npm ci --prefer-offline || true" value={maintenanceScript} onChange={(e) => setMaintenanceScript(e.target.value)} disabled={savingScripts} />
          </div>

          {scriptsError && (
            <div role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">{scriptsError}</div>
          )}

          <div className="flex justify-end gap-2">
            {scriptsChanged && (
              <Button variant="ghost" size="sm" disabled={savingScripts} onClick={() => {
                setDefaultBranch(project.default_branch || "main");
                setWorkingSubdir(project.working_subdir || "");
                setSetupScript(project.setup_script || "");
                setMaintenanceScript(project.maintenance_script || "");
              }}>
                {t("projectDetail.instructions.discard")}
              </Button>
            )}
            <Button size="sm" disabled={!scriptsChanged || savingScripts} loading={savingScripts} onClick={() => void saveScripts()}>
              <LuCheck />{t("common.save")}
            </Button>
          </div>

          {project.setup_last_log && (
            <div className="space-y-1.5">
              <span className="block text-xs font-medium">{t("projects.edit.lastSetupLog", "Last setup log")}</span>
              <pre className="max-h-56 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap break-words">
                {project.setup_last_log}
              </pre>
            </div>
          )}
        </TabsContent>

        <TabsContent value="secrets" className="mt-0 max-w-3xl space-y-5">
          {canManageSecrets && (
            <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">{t("projects.edit.addSecretTitle", "Add environment secret")}</span>
                <Button type="button" size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => setShowBulkSecrets((prev) => !prev)}>
                  <LuUpload className="h-3.5 w-3.5" />
                  {showBulkSecrets ? t("projects.edit.singleMode", "Single key") : t("projects.edit.bulkPaste", "Paste .env")}
                </Button>
              </div>
              {showBulkSecrets ? (
                <div className="space-y-2">
                  <Textarea rows={4} className="font-mono text-xs" placeholder={"API_KEY=...\nDATABASE_URL=..."} value={bulkSecretsText} disabled={secretBusy} onChange={(e) => setBulkSecretsText(e.target.value)} />
                  <div className="flex justify-end">
                    <Button type="button" size="sm" disabled={!bulkSecretsText.trim() || secretBusy} onClick={() => void handleBulkImportSecrets()}>
                      {secretBusy && <LuLoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                      {t("projects.edit.importEnv", "Import .env")}
                    </Button>
                  </div>
                </div>
              ) : (
                <form autoComplete="off" onSubmit={(e) => void handleAddSecret(e)} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                  <Input
                    name="env-secret-key"
                    autoComplete="off"
                    data-1p-ignore
                    data-lpignore="true"
                    spellCheck={false}
                    className="font-mono text-xs"
                    placeholder="KEY_NAME"
                    value={newSecretKey}
                    disabled={secretBusy}
                    onChange={(e) => setNewSecretKey(e.target.value.toUpperCase())}
                  />
                  <Input
                    name="env-secret-value"
                    type="password"
                    autoComplete="new-password"
                    data-1p-ignore
                    data-lpignore="true"
                    className="font-mono text-xs"
                    placeholder={t("projects.edit.secretValuePlaceholder", "Secret value")}
                    value={newSecretValue}
                    disabled={secretBusy}
                    onChange={(e) => setNewSecretValue(e.target.value)}
                  />
                  <Button type="submit" size="sm" className="gap-1" disabled={!newSecretKey.trim() || !newSecretValue || secretBusy}>
                    <LuPlus className="h-3.5 w-3.5" />{t("projects.edit.addSecret", "Add")}
                  </Button>
                </form>
              )}
            </div>
          )}

          {secretError && (
            <div role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">{secretError}</div>
          )}

          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t("projects.edit.envSecretsHeading", "Environment secrets")} ({secrets.length})
            </h3>
            {secretsLoading ? (
              <div className="flex justify-center py-8"><LuLoaderCircle className="h-4 w-4 animate-spin text-muted-foreground" /></div>
            ) : secrets.length === 0 ? (
              <p className="rounded-xl border border-dashed py-8 text-center text-xs text-muted-foreground">
                {t("projects.edit.noEnvSecrets", "No environment-specific secrets yet.")}
              </p>
            ) : (
              <div className="divide-y rounded-xl border">
                {secrets.map((item) => (
                  <div key={item.uuid} className="flex items-center justify-between gap-2 px-3.5 py-2.5 text-xs">
                    <div className="min-w-0">
                      <p className="truncate font-mono font-medium">{item.key}</p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">{item.masked_value}</p>
                    </div>
                    {canManageSecrets && (
                      <button type="button" disabled={secretBusy} aria-label={`Delete ${item.key}`} onClick={() => void handleDeleteSecret(item.uuid)} className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                        <LuTrash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {inheritedSecrets.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t("projects.edit.inheritedSecretsHeading", "Inherited from workspace")} ({inheritedSecrets.length})
              </h3>
              <div className="divide-y rounded-xl border bg-muted/15">
                {inheritedSecrets.map((item) => (
                  <div key={item.uuid} className="flex items-center justify-between gap-2 px-3.5 py-2.5 text-xs">
                    <div className="min-w-0">
                      <p className={cn("truncate font-mono font-medium", item.overridden && "line-through text-muted-foreground")}>{item.key}</p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">{item.masked_value}</p>
                    </div>
                    {item.overridden && (
                      <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                        {t("projects.edit.overriddenBadge", "Overridden")}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="instructions" className="mt-0 max-w-3xl">
          <div className="mb-5">
            <h2 className="text-sm font-semibold">{t("projectDetail.instructions.title")}</h2>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{t("projectDetail.instructions.description")}</p>
          </div>
          <div className="rounded-xl border border-border bg-background p-3">
            <label htmlFor="project-instructions" className="sr-only">{t("projectDetail.instructions.title")}</label>
            <Textarea
              id="project-instructions"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              disabled={savingInstructions}
              placeholder={t("projectDetail.instructions.placeholder")}
              rows={9}
              className="min-h-[220px] resize-y border-0 bg-transparent p-1 text-sm leading-relaxed shadow-none focus-visible:ring-0"
            />
            <div className="mt-3 flex items-center justify-between border-t border-border/40 pt-2.5">
              <span className="text-[11px] text-muted-foreground">
                {instructionsChanged ? t("projectDetail.instructions.unsavedChanges") : t("projectDetail.instructions.appliesToConversations")}
              </span>
              <div className="flex shrink-0 gap-2">
                {instructionsChanged && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={savingInstructions}
                    onClick={() => {
                      setInstructions(project.usage_guide || "");
                      setInstructionsError("");
                    }}
                  >
                    {t("projectDetail.instructions.discard")}
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={() => void saveInstructions()}
                  disabled={!instructionsChanged}
                  loading={savingInstructions}
                >
                  <LuCheck />{t("common.save")}
                </Button>
              </div>
            </div>
          </div>
          {instructionsError && (
            <div role="alert" className="mt-4 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">
              {instructionsError}
            </div>
          )}
        </TabsContent>

        <TabsContent value="notes" className="mt-0 max-w-3xl">
          <div className="mb-5">
            <h2 className="text-sm font-semibold">{t("projectDetail.notes.title")}</h2>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{t("projectDetail.notes.description")}</p>
          </div>
          <form onSubmit={(event) => { event.preventDefault(); void addNote(); }} className="rounded-xl border border-border bg-background p-3">
            <label htmlFor="project-new-note" className="sr-only">{t("projectDetail.notes.newNoteLabel")}</label>
            <Textarea
              id="project-new-note"
              value={newNote}
              onChange={(event) => setNewNote(event.target.value)}
              placeholder={t("projectDetail.notes.placeholder")}
              disabled={addingNote || notesLoading}
              rows={3}
              className="min-h-[80px] resize-y border-0 bg-transparent p-1 text-sm leading-relaxed shadow-none focus-visible:ring-0"
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                  event.preventDefault();
                  void addNote();
                }
              }}
            />
            <div className="mt-3 flex items-center justify-between border-t border-border/40 pt-2.5">
              <span className="text-[11px] text-muted-foreground">
                {t("projectDetail.notes.shortcutHint")}
              </span>
              <Button type="submit" size="sm" disabled={!newNote.trim() || notesLoading} loading={addingNote}>
                <LuPlus />{t("projectDetail.notes.addNote")}
              </Button>
            </div>
          </form>
          {notesError && (
            <div role="alert" className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">
              <span>{notesError}</span>
              <Button variant="ghost" size="xs" onClick={() => setNotesAttempt((attempt) => attempt + 1)}>{t("common.retry")}</Button>
            </div>
          )}
          {notesLoading ? <div className="flex justify-center py-12" role="status" aria-label={t("projectDetail.notes.loadingAria")}>
            <LuLoader className="h-4 w-4 animate-spin text-muted-foreground" />
          </div> : notes.length === 0 && !notesError ? <div className="py-12 text-center">
            <LuNotebookPen className="mx-auto mb-3 h-5 w-5 text-muted-foreground opacity-60" />
            <p className="text-xs text-muted-foreground">{t("projectDetail.notes.empty")}</p>
          </div> : <ul className="mt-5 space-y-3" aria-label={t("projectDetail.notes.listAria")}>{notes.map((note) => <li key={note.uuid} className="rounded-xl border border-border bg-background p-4">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-relaxed">{note.content}</p>
              <Button variant="ghost" size="icon-sm" aria-label={t("projectDetail.notes.deleteNoteAria")} disabled={Boolean(deletingNote)} onClick={() => void deleteNote(note)} className="shrink-0 text-muted-foreground hover:text-destructive">{deletingNote === note.uuid ? <LuLoader className="animate-spin" /> : <LuTrash2 />}</Button>
            </div>
            <time dateTime={note.created_at} className="mt-3 block text-[11px] text-muted-foreground">{relativeTime(note.created_at, t, locale)}</time>
          </li>)}</ul>}
        </TabsContent>
      </Tabs>

      <EditProjectDialog project={settingsOpen ? project : null} onOpenChange={(open) => setSettingsOpen(open)} />
      <Dialog open={removeOpen} onOpenChange={(open) => { if (!removing) setRemoveOpen(open); }}>
        <DialogContent className="w-[calc(100%-2rem)] rounded-xl" onEscapeKeyDown={(event) => { if (removing) event.preventDefault(); }} onInteractOutside={(event) => { if (removing) event.preventDefault(); }}>
          <DialogHeader>
            <DialogTitle className="break-words">{t("projectDetail.removeDialog.title", { name: project.display_name })}</DialogTitle>
            <DialogDescription>
              <Trans
                i18nKey="projectDetail.removeDialog.description"
                ns="workspace"
                values={{ path: project.filesystem_path || `/workspace/${project.slug}` }}
                components={{ path: <span className="break-all font-mono text-xs" /> }}
              />
            </DialogDescription>
          </DialogHeader>{removeError && <p role="alert" className="text-xs text-destructive">{removeError}</p>}<DialogFooter>
            <Button variant="ghost" disabled={removing} onClick={() => setRemoveOpen(false)}>{t("common.cancel")}</Button>
            <Button variant="destructive" loading={removing} onClick={() => void removeProject()}>{t("projectDetail.removeProject")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
