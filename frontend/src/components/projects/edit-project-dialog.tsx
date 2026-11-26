"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuCircleCheck,
  LuCircleAlert,
  LuEraser,
  LuKeyRound,
  LuLoaderCircle,
  LuPlay,
  LuPlus,
  LuSettings2,
  LuSparkles,
  LuTerminal,
  LuTrash2,
  LuUpload,
} from "react-icons/lu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toaster } from "@/components/ui/toaster";
import { API_BASE, authedAxios } from "@/lib/axios";
import { cn } from "@/lib/utils";
import { ENVIRONMENT_PRESETS, formatBytesCompact } from "@/lib/environment-presets";
import useSandboxProjectsStore from "@/stores/sandbox-projects";
import useWorkspacesStore from "@/stores/workspaces";
import type { IProject } from "@/stores/sandbox-projects";

function extractApiError(err: any, fallback: string): string {
  const data = err?.response?.data;
  if (typeof data === "string" && data.trim()) return data;
  if (data && typeof data === "object") {
    for (const key of ["key", "value", "content", "error", "detail"]) {
      const val = data[key];
      if (Array.isArray(val) && val.length > 0) return String(val[0]);
      if (typeof val === "string" && val.trim()) return val;
    }
  }
  return err?.message || fallback;
}

interface Props {
  project: IProject | null;
  onOpenChange: (open: boolean) => void;
  initialTab?: "general" | "scripts" | "secrets";
}

interface SecretItem {
  uuid: string;
  key: string;
  masked_value: string;
  description: string;
  scope?: "workspace" | "environment";
  overridden?: boolean;
}

export default function EditProjectDialog({ project, onOpenChange, initialTab = "general" }: Props) {
  const workspaceUuid = useWorkspacesStore(state => state.currentWorkspace?.uuid || state.currentWorkspaceUuid);
  const sandboxes = useSandboxProjectsStore(state => state.sandboxes);
  const liveProject = project ? sandboxes.find(item => item.uuid === project.uuid) || project : null;
  const activeProject = liveProject?.workspace_uuid === workspaceUuid ? liveProject : null;

  return (
    <Dialog open={Boolean(activeProject)} onOpenChange={onOpenChange}>
      {activeProject && (
        <EditProjectForm
          key={activeProject.uuid}
          project={activeProject}
          workspaceUuid={workspaceUuid || ""}
          initialTab={initialTab}
          onClose={() => onOpenChange(false)}
        />
      )}
    </Dialog>
  );
}

function EditProjectForm({
  project,
  workspaceUuid,
  initialTab,
  onClose,
}: {
  project: IProject;
  workspaceUuid: string;
  initialTab: "general" | "scripts" | "secrets";
  onClose: () => void;
}) {
  const { t } = useTranslation("workspace");
  const [tab, setTab] = useState<"general" | "scripts" | "secrets">(initialTab);

  // General + Scripts state
  const [name, setName] = useState(project.display_name);
  const [description, setDescription] = useState(project.description || "");
  const [repoFullName, setRepoFullName] = useState(project.repo_full_name || "");
  const [repoUrl, setRepoUrl] = useState(project.repo_url || "");
  const [defaultBranch, setDefaultBranch] = useState(project.default_branch || "main");
  const [workingSubdir, setWorkingSubdir] = useState(project.working_subdir || "");
  const [usageGuide, setUsageGuide] = useState(project.usage_guide || "");
  const [setupScript, setSetupScript] = useState(project.setup_script || "");
  const [maintenanceScript, setMaintenanceScript] = useState(project.maintenance_script || "");
  const [saving, setSaving] = useState(false);
  const [runningSetup, setRunningSetup] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);

  // Secrets state
  const [secrets, setSecrets] = useState<SecretItem[]>([]);
  const [inheritedSecrets, setInheritedSecrets] = useState<SecretItem[]>([]);
  const [canManageSecrets, setCanManageSecrets] = useState(true);
  const [secretsLoading, setSecretsLoading] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [showBulkPaste, setShowBulkPaste] = useState(false);
  const [bulkContent, setBulkContent] = useState("");
  const [secretBusy, setSecretBusy] = useState(false);

  const fetchSecrets = useCallback(async () => {
    if (!workspaceUuid) return;
    setSecretsLoading(true);
    try {
      const { data } = await authedAxios.get(`${API_BASE}/sandbox/workspaces/${workspaceUuid}/vm-secrets/`, {
        params: { sandbox_uuid: project.uuid },
      });
      setSecrets(Array.isArray(data?.secrets) ? data.secrets : []);
      setInheritedSecrets(Array.isArray(data?.inherited_secrets) ? data.inherited_secrets : []);
      setCanManageSecrets(data?.can_manage !== false);
    } catch {
      setSecrets([]);
    } finally {
      setSecretsLoading(false);
    }
  }, [workspaceUuid, project.uuid]);

  useEffect(() => {
    if (tab === "secrets") {
      void fetchSecrets();
    }
  }, [tab, fetchSecrets]);

  const persistFields = async () => {
    const updated = await useSandboxProjectsStore.getState().updateSandbox(project.uuid, {
      display_name: name.trim() || project.display_name,
      description: description.trim(),
      repo_full_name: repoFullName.trim(),
      repo_url: repoUrl.trim(),
      default_branch: defaultBranch.trim() || "main",
      working_subdir: workingSubdir.trim().replace(/^\/+|\/+$/g, ""),
      usage_guide: usageGuide.trim(),
      setup_script: setupScript.trim(),
      maintenance_script: maintenanceScript.trim(),
    });
    if (!updated) {
      throw new Error(useSandboxProjectsStore.getState().errorMessage || t("projects.edit.updateFailed"));
    }
    return updated;
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending.current || !name.trim()) return;
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      await persistFields();
      onClose();
      toaster.create({ title: t("projects.edit.toastUpdated"), type: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("projects.edit.updateFailed"));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  const handleRunSetup = async () => {
    if (runningSetup || saving) return;
    setRunningSetup(true);
    setError("");
    try {
      await persistFields();
      const res = await useSandboxProjectsStore.getState().runEnvironmentSetup(project.uuid, { force: true });
      if (res.ready) {
        toaster.create({ title: t("projects.edit.setupSucceeded", "Environment setup completed"), type: "success" });
      } else {
        setError(res.error || t("projects.edit.setupFailed", "Environment setup failed."));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("projects.edit.setupFailed", "Environment setup failed."));
    } finally {
      setRunningSetup(false);
    }
  };

  const handleClearCache = async () => {
    if (clearingCache) return;
    setClearingCache(true);
    setError("");
    try {
      const res = await useSandboxProjectsStore.getState().clearEnvironmentDepsCache(project.uuid);
      if (res.cleared) {
        toaster.create({ title: t("projects.edit.cacheCleared", "Dependency cache cleared"), type: "success" });
      } else {
        setError(res.error || t("projects.edit.cacheClearFailed", "Could not clear dependency cache."));
      }
    } finally {
      setClearingCache(false);
    }
  };

  const handleAddSecret = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newKey.trim() || !newValue || secretBusy || !workspaceUuid) return;
    setSecretBusy(true);
    setError("");
    try {
      await authedAxios.post(`${API_BASE}/sandbox/workspaces/${workspaceUuid}/vm-secrets/`, {
        key: newKey.trim(),
        value: newValue,
        description: newDesc.trim(),
        sandbox_uuid: project.uuid,
      });
      setNewKey("");
      setNewValue("");
      setNewDesc("");
      await fetchSecrets();
      toaster.create({ title: t("projects.edit.secretSaved", "Secret saved"), type: "success" });
    } catch (err: any) {
      setError(extractApiError(err, "Could not save secret."));
    } finally {
      setSecretBusy(false);
    }
  };

  const handleBulkImportSecrets = async () => {
    if (!bulkContent.trim() || secretBusy || !workspaceUuid) return;
    setSecretBusy(true);
    setError("");
    try {
      await authedAxios.post(`${API_BASE}/sandbox/workspaces/${workspaceUuid}/vm-secrets/bulk-import/`, {
        content: bulkContent,
        sandbox_uuid: project.uuid,
      });
      setBulkContent("");
      setShowBulkPaste(false);
      await fetchSecrets();
      toaster.create({ title: t("projects.edit.secretsImported", "Secrets imported"), type: "success" });
    } catch (err: any) {
      setError(extractApiError(err, "Could not import secrets."));
    } finally {
      setSecretBusy(false);
    }
  };

  const handleDeleteSecret = async (secretUuid: string) => {
    if (secretBusy || !workspaceUuid) return;
    setSecretBusy(true);
    try {
      await authedAxios.delete(`${API_BASE}/sandbox/workspaces/${workspaceUuid}/vm-secrets/${secretUuid}/`);
      await fetchSecrets();
    } catch (err: any) {
      setError(extractApiError(err, "Could not delete secret."));
    } finally {
      setSecretBusy(false);
    }
  };

  const statusBadge = (() => {
    const st = project.setup_status || "idle";
    if (st === "ready") {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
          <LuCircleCheck className="h-3.5 w-3.5" />
          {t("projects.edit.statusReady", "Ready")}
        </span>
      );
    }
    if (st === "running") {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
          <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
          {t("projects.edit.statusRunning", "Running")}
        </span>
      );
    }
    if (st === "failed") {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2.5 py-0.5 text-xs font-medium text-destructive">
          <LuCircleAlert className="h-3.5 w-3.5" />
          {t("projects.edit.statusFailed", "Failed")}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
        {t("projects.edit.statusIdle", "Idle")}
      </span>
    );
  })();

  const busy = saving || runningSetup || clearingCache;

  return (
    <DialogContent
      hideClose={busy}
      className="flex max-h-[90dvh] w-[calc(100%-2rem)] max-w-2xl flex-col gap-0 overflow-hidden rounded-2xl p-0"
      onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}
      onInteractOutside={event => { if (busy) event.preventDefault(); }}
    >
      <DialogHeader className="shrink-0 px-5 pb-3 pt-5 text-left">
        <div className="flex items-center justify-between gap-2 pr-6">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <LuSettings2 className="h-4 w-4 text-violet-500" />
            {t("projects.edit.title")}
          </DialogTitle>
          {statusBadge}
        </div>
        <DialogDescription className="truncate font-mono text-xs">
          {project.repo_full_name || project.filesystem_path}
        </DialogDescription>
      </DialogHeader>

      {/* Tabs */}
      <div className="shrink-0 px-5 pb-3">
        <div role="tablist" className="grid grid-cols-3 gap-1 rounded-lg bg-muted/50 p-1">
          {(
            [
              { id: "general", Icon: LuSettings2, label: t("projects.edit.tabGeneral", "General") },
              { id: "scripts", Icon: LuTerminal, label: t("projects.edit.tabScripts", "Scripts & Cache") },
              {
                id: "secrets",
                Icon: LuKeyRound,
                label: `${t("projects.edit.tabSecrets", "Secrets")}${secrets.length || project.secret_count ? ` (${secrets.length || project.secret_count})` : ""}`,
              },
            ] as const
          ).map(({ id, Icon, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => { setTab(id); setError(""); }}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                tab === id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {tab !== "secrets" ? (
        <form onSubmit={save} className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto px-5 pb-5">
            {tab === "general" ? (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="edit-project-name" className="mb-1.5 block text-xs font-medium">{t("projects.edit.nameLabel")}</label>
                    <Input id="edit-project-name" value={name} onChange={event => setName(event.target.value)} disabled={busy} autoFocus />
                  </div>
                  <div>
                    <label htmlFor="edit-env-branch" className="mb-1.5 block text-xs font-medium">{t("projects.create.defaultBranchLabel", "Default branch")}</label>
                    <Input id="edit-env-branch" className="font-mono text-xs" value={defaultBranch} onChange={event => setDefaultBranch(event.target.value)} disabled={busy} />
                  </div>
                </div>
                <div>
                  <label htmlFor="edit-project-description" className="mb-1.5 block text-xs font-medium">{t("projects.edit.descriptionLabel")}</label>
                  <Textarea id="edit-project-description" value={description} onChange={event => setDescription(event.target.value)} disabled={busy} rows={2} />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="edit-env-repo" className="mb-1.5 block text-xs font-medium">{t("projects.create.githubRepoLabel")}</label>
                    <Input id="edit-env-repo" className="font-mono text-xs" placeholder="owner/repo" value={repoFullName} onChange={event => setRepoFullName(event.target.value)} disabled={busy} />
                  </div>
                  <div>
                    <label htmlFor="edit-env-subdir" className="mb-1.5 block text-xs font-medium">{t("projects.create.workingSubdirLabel", "Working subdirectory")}</label>
                    <Input id="edit-env-subdir" className="font-mono text-xs" placeholder="e.g. apps/web" value={workingSubdir} onChange={event => setWorkingSubdir(event.target.value)} disabled={busy} />
                  </div>
                </div>
                <div>
                  <label htmlFor="edit-env-repo-url" className="mb-1.5 block text-xs font-medium">{t("projects.edit.repoUrlLabel", "Clone URL")}</label>
                  <Input id="edit-env-repo-url" className="font-mono text-xs" placeholder="https://github.com/owner/repo.git" value={repoUrl} onChange={event => setRepoUrl(event.target.value)} disabled={busy} />
                </div>
                <div>
                  <label htmlFor="edit-env-guide" className="mb-1.5 block text-xs font-medium">{t("projects.create.instructionsLabel", "Agent instructions")}</label>
                  <Textarea id="edit-env-guide" value={usageGuide} onChange={event => setUsageGuide(event.target.value)} disabled={busy} rows={3} placeholder={t("projects.create.instructionsPlaceholder", "Conventions, test commands, or notes for the agent…")} />
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/70 bg-muted/25 px-3.5 py-2.5 text-xs">
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
                    <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 text-xs" disabled={busy} onClick={() => void handleClearCache()}>
                      {clearingCache ? <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <LuEraser className="h-3.5 w-3.5" />}
                      {t("projects.edit.clearCache", "Clear cache")}
                    </Button>
                    <Button type="button" size="sm" className="h-8 gap-1.5 text-xs" disabled={busy} onClick={() => void handleRunSetup()}>
                      {runningSetup ? <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <LuPlay className="h-3.5 w-3.5" />}
                      {t("projects.edit.runSetup", "Run setup")}
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                    <LuSparkles className="h-3 w-3" />
                    {t("projects.create.presetsLabel", "Quick stack presets")}
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {ENVIRONMENT_PRESETS.map(preset => (
                      <button
                        key={preset.id}
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setSetupScript(preset.setupScript);
                          setMaintenanceScript(preset.maintenanceScript);
                        }}
                        className="rounded-md border border-border/80 bg-background px-2 py-1 text-[11px] font-medium hover:border-violet-500/50 hover:bg-violet-500/5 transition-colors"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="edit-setup-script" className="block text-xs font-medium">{t("projects.create.setupScriptLabel", "Setup script")}</label>
                  <Textarea id="edit-setup-script" rows={3} className="font-mono text-xs" value={setupScript} onChange={event => setSetupScript(event.target.value)} disabled={busy} placeholder="npm ci || uv sync" />
                  <p className="text-[11px] text-muted-foreground">{t("projects.create.setupScriptHelp", "Runs once when the environment boots fresh or lockfiles change.")}</p>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="edit-maint-script" className="block text-xs font-medium">{t("projects.create.maintenanceScriptLabel", "Maintenance script")}</label>
                  <Textarea id="edit-maint-script" rows={2} className="font-mono text-xs" value={maintenanceScript} onChange={event => setMaintenanceScript(event.target.value)} disabled={busy} placeholder="npm ci --prefer-offline || true" />
                </div>

                {project.setup_last_log && (
                  <div className="space-y-1.5">
                    <span className="block text-xs font-medium">{t("projects.edit.lastSetupLog", "Last setup log")}</span>
                    <pre className="max-h-40 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap break-words">
                      {project.setup_last_log}
                    </pre>
                  </div>
                )}
              </>
            )}

            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          </div>

          <DialogFooter className="shrink-0 gap-2 border-t bg-muted/15 px-5 py-3">
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={!name.trim() || busy} loading={saving}>{t("common.saveChanges")}</Button>
          </DialogFooter>
        </form>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto px-5 pb-5">
            {canManageSecrets && (
              <div className="space-y-3 rounded-xl border border-border/70 bg-muted/20 p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">{t("projects.edit.addSecretTitle", "Add environment secret")}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1.5 text-xs"
                    onClick={() => setShowBulkPaste(prev => !prev)}
                  >
                    <LuUpload className="h-3.5 w-3.5" />
                    {showBulkPaste ? t("projects.edit.singleMode", "Single key") : t("projects.edit.bulkPaste", "Paste .env")}
                  </Button>
                </div>

                {showBulkPaste ? (
                  <div className="space-y-2">
                    <Textarea
                      rows={4}
                      className="font-mono text-xs"
                      placeholder={"API_KEY=...\nDATABASE_URL=..."}
                      value={bulkContent}
                      disabled={secretBusy}
                      onChange={event => setBulkContent(event.target.value)}
                    />
                    <div className="flex justify-end">
                      <Button type="button" size="sm" disabled={!bulkContent.trim() || secretBusy} onClick={() => void handleBulkImportSecrets()}>
                        {secretBusy && <LuLoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                        {t("projects.edit.importEnv", "Import .env")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <form autoComplete="off" onSubmit={event => void handleAddSecret(event)} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    <Input
                      name="dialog-secret-key"
                      autoComplete="off"
                      data-1p-ignore
                      data-lpignore="true"
                      spellCheck={false}
                      className="font-mono text-xs"
                      placeholder="KEY_NAME"
                      value={newKey}
                      disabled={secretBusy}
                      onChange={event => setNewKey(event.target.value.toUpperCase())}
                    />
                    <Input
                      name="dialog-secret-value"
                      type="password"
                      autoComplete="new-password"
                      data-1p-ignore
                      data-lpignore="true"
                      className="font-mono text-xs"
                      placeholder={t("projects.edit.secretValuePlaceholder", "Secret value")}
                      value={newValue}
                      disabled={secretBusy}
                      onChange={event => setNewValue(event.target.value)}
                    />
                    <Button type="submit" size="sm" className="gap-1" disabled={!newKey.trim() || !newValue || secretBusy}>
                      <LuPlus className="h-3.5 w-3.5" />
                      {t("projects.edit.addSecret", "Add")}
                    </Button>
                  </form>
                )}
              </div>
            )}

            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}

            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {t("projects.edit.envSecretsHeading", "Environment secrets")} ({secrets.length})
              </h4>
              {secretsLoading ? (
                <div className="flex items-center justify-center py-4 text-muted-foreground">
                  <LuLoaderCircle className="h-4 w-4 animate-spin" />
                </div>
              ) : secrets.length === 0 ? (
                <p className="rounded-lg border border-dashed py-4 text-center text-xs text-muted-foreground">
                  {t("projects.edit.noEnvSecrets", "No environment-specific secrets yet.")}
                </p>
              ) : (
                <div className="divide-y rounded-lg border">
                  {secrets.map(item => (
                    <div key={item.uuid} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                      <div className="min-w-0">
                        <p className="truncate font-mono font-medium">{item.key}</p>
                        <p className="truncate font-mono text-[11px] text-muted-foreground">{item.masked_value}</p>
                      </div>
                      {canManageSecrets && (
                        <button
                          type="button"
                          disabled={secretBusy}
                          aria-label={`Delete ${item.key}`}
                          onClick={() => void handleDeleteSecret(item.uuid)}
                          className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        >
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
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  {t("projects.edit.inheritedSecretsHeading", "Inherited from workspace")} ({inheritedSecrets.length})
                </h4>
                <div className="divide-y rounded-lg border bg-muted/15">
                  {inheritedSecrets.map(item => (
                    <div key={item.uuid} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                      <div className="min-w-0">
                        <p className={cn("truncate font-mono font-medium", item.overridden && "line-through text-muted-foreground")}>
                          {item.key}
                        </p>
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
          </div>

          <DialogFooter className="shrink-0 border-t bg-muted/15 px-5 py-3">
            <Button type="button" variant="outline" onClick={onClose}>{t("common.close", "Close")}</Button>
          </DialogFooter>
        </div>
      )}
    </DialogContent>
  );
}
