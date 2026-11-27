"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "@/lib/navigation";
import {
  LuArrowRight,
  LuChevronDown,
  LuChevronRight,
  LuCircleAlert,
  LuFolder,
  LuFolderPlus,
  LuGitBranch,
  LuGithub,
  LuGitlab,
  LuKeyRound,
  LuLoaderCircle,
  LuSparkles,
  LuTerminal,
} from "react-icons/lu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toaster } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";
import { API_BASE, authedAxios } from "@/lib/axios";
import { ENVIRONMENT_PRESETS } from "@/lib/environment-presets";
import { DEFAULT_GITLAB_HOST, normalizeProjectPath, parseGithubRepository, parseGitlabRepository } from "@/lib/project-import";
import RepositoryBrowser, { type GitProvider } from "@/components/git/repository-browser";
import ProjectFolderPicker from "./project-folder-picker";
import useChatStore from "@/stores/chat";
import useSandboxProjectsStore from "@/stores/sandbox-projects";
import useSidebarStore from "@/stores/sidebar";
import useWorkspacesStore from "@/stores/workspaces";
import useWorkspaceTabsStore from "@/stores/workspace-tabs";
import type { IProject } from "@/stores/sandbox-projects";

interface Props {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCreated?: (project: IProject) => Promise<void> | void;
  /** "github" and "gitlab" are kept for older callers; both open the single repository flow. */
  initialMode?: "new" | "folder" | "repo" | "github" | "gitlab";
}

type Mode = "new" | "folder" | "repo";
const normalizeMode = (mode: Props["initialMode"]): Mode => (mode === "new" || mode === "folder" ? mode : "repo");

/** The provider is read from what the user pastes or picks, never chosen separately. */
function detectRepository(value: string, gitlabHost: string) {
  const github = parseGithubRepository(value);
  if (github) return { provider: "github" as GitProvider, repository: github };
  const gitlab = parseGitlabRepository(value, gitlabHost);
  if (gitlab) return { provider: "gitlab" as GitProvider, repository: gitlab };
  return null;
}

export default function CreateProjectDialog({
  open: controlledOpen,
  onOpenChange,
  onCreated,
  initialMode = "repo",
}: Props) {
  const { t } = useTranslation("workspace");
  const router = useRouter();
  const dialogOpen = useSandboxProjectsStore(state => state.isCreateProjectDialogOpen);
  const setDialogOpen = useSandboxProjectsStore(state => state.setCreateProjectDialogOpen);
  const open = controlledOpen ?? dialogOpen;
  const setOpen = onOpenChange ?? setDialogOpen;
  const workspaceSandbox = useSandboxProjectsStore(state => state.workspaceSandbox);
  const workspaceUuid = useWorkspacesStore(state => state.currentWorkspace?.uuid || state.currentWorkspaceUuid);

  const [mode, setMode] = useState<Mode>(normalizeMode(initialMode));
  const [displayName, setDisplayName] = useState("");
  const [displayNameEdited, setDisplayNameEdited] = useState(false);
  const [folderPath, setFolderPath] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [gitlabHost, setGitlabHost] = useState(DEFAULT_GITLAB_HOST);
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [workingSubdir, setWorkingSubdir] = useState("");
  const [destination, setDestination] = useState("");
  const [destinationEdited, setDestinationEdited] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [setupScript, setSetupScript] = useState("");
  const [maintenanceScript, setMaintenanceScript] = useState("");
  const [secretsText, setSecretsText] = useState("");
  const [usageGuide, setUsageGuide] = useState("");
  const [phase, setPhase] = useState<"idle" | "connecting" | "creating">("idle");
  const [connectingProvider, setConnectingProvider] = useState<GitProvider>("github");
  const [error, setError] = useState("");
  const submitting = useRef(false);

  const busy = phase !== "idle";
  const isRepoMode = mode === "repo";
  const detected = detectRepository(repoUrl, gitlabHost);
  const repository = detected?.repository ?? null;
  const provider = detected?.provider ?? null;
  const targetPath = normalizeProjectPath(isRepoMode ? destination : folderPath);

  useEffect(() => {
    if (open) {
      setMode(normalizeMode(initialMode));
      return;
    }
    setMode(normalizeMode(initialMode));
    setDisplayName("");
    setDisplayNameEdited(false);
    setFolderPath("");
    setRepoUrl("");
    setDefaultBranch("main");
    setWorkingSubdir("");
    setDestination("");
    setDestinationEdited(false);
    setShowAdvanced(false);
    setSetupScript("");
    setMaintenanceScript("");
    setSecretsText("");
    setUsageGuide("");
    setError("");
  }, [open, initialMode]);

  const changeRepository = (value: string, branch?: string | null) => {
    setRepoUrl(value);
    setError("");
    const repo = detectRepository(value, gitlabHost)?.repository ?? null;
    if (branch) setDefaultBranch(branch);
    if (!destinationEdited) {
      setDestination(repo ? `/workspace/${repo.name}` : "");
    }
    if (!displayNameEdited) {
      setDisplayName(repo ? repo.name : "");
    }
  };

  const close = () => {
    if (!busy && !submitting.current) setOpen(false);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || submitting.current || !workspaceUuid || !targetPath || (isRepoMode && !repository)) return;
    submitting.current = true;
    setError("");
    const store = useSandboxProjectsStore.getState();
    try {
      if (store.sandboxes.some(project => project.workspace_uuid === workspaceUuid && project.filesystem_path === targetPath)) {
        throw new Error(t("projects.create.alreadyProjectError"));
      }
      const currentWorkspace = useWorkspacesStore.getState();
      if ((currentWorkspace.currentWorkspace?.uuid || currentWorkspace.currentWorkspaceUuid) !== workspaceUuid) {
        throw new Error(t("projects.create.workspaceChangedError"));
      }
      setPhase("creating");
      const project = await store.createSandbox({
        display_name: displayName.trim() || undefined,
        filesystem_path: targetPath,
        workspace_uuid: workspaceUuid,
        source: isRepoMode ? provider ?? "github" : mode === "new" ? "new" : "existing",
        lazy: isRepoMode,
        ...(isRepoMode && repository
          ? {
              repo_full_name: repository.fullName,
              repo_url: repository.url,
              default_branch: defaultBranch.trim() || "main",
            }
          : {}),
        working_subdir: workingSubdir.trim().replace(/^\/+|\/+$/g, ""),
        setup_script: setupScript.trim(),
        maintenance_script: maintenanceScript.trim(),
        usage_guide: usageGuide.trim(),
      });
      if (!project) {
        throw new Error(useSandboxProjectsStore.getState().errorMessage || t("projects.create.createFailed"));
      }

      if (secretsText.trim()) {
        try {
          await authedAxios.post(`${API_BASE}/sandbox/workspaces/${workspaceUuid}/vm-secrets/bulk-import/`, {
            content: secretsText,
            sandbox_uuid: project.uuid,
          });
        } catch (secretErr: any) {
          toaster.create({
            title: t("projects.create.secretsPartialError", "Environment created, but some secrets could not be saved"),
            description: secretErr?.response?.data?.error || secretErr?.message,
            type: "warning",
          });
        }
      }

      if (onCreated) {
        await onCreated(project);
      } else {
        useChatStore.getState().reset();
        useChatStore.getState().setChatMode("code");
        useWorkspaceTabsStore.getState().openChatTab(undefined, undefined, "left");
        await useSidebarStore.getState().fetchConversations(false, project.uuid);
        router.push("/new");
      }
      setOpen(false);
      toaster.create({
        title: isRepoMode ? t("projects.create.toastImported") : t("projects.create.toastCreated"),
        description: project.repo_full_name || project.filesystem_path,
        type: "success",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("projects.create.createFailed"));
    } finally {
      submitting.current = false;
      setPhase("idle");
    }
  };

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) close(); }}>
      <DialogContent
        hideClose={busy}
        className="flex max-h-[90dvh] w-[calc(100%-2rem)] max-w-xl flex-col gap-0 overflow-hidden rounded-2xl p-0"
        onInteractOutside={event => { if (busy) event.preventDefault(); }}
        onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}
      >
        <DialogHeader className="shrink-0 px-5 pb-3 pt-5 text-left">
          <div className="mb-1 flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/10 text-violet-500">
              <LuFolderPlus className="h-4 w-4" />
            </div>
            <DialogTitle className="text-lg">{t("projects.create.title")}</DialogTitle>
          </div>
          <DialogDescription>{t("projects.create.description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={event => void submit(event)} className="flex min-h-0 flex-col">
          <div className="space-y-4 overflow-y-auto px-5 pb-5 pt-2">
            <div role="group" aria-label={t("projects.create.sourceAria")} className="grid grid-cols-3 gap-1 rounded-lg bg-muted/50 p-1">
              {(
                [
                  { id: "repo", Icon: LuGitBranch, title: t("projects.create.modeRepository") },
                  { id: "new", Icon: LuFolderPlus, title: t("projects.create.modeNew") },
                  { id: "folder", Icon: LuFolder, title: t("projects.create.modeExisting") },
                ] as const
              ).map(({ id, Icon, title }) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={mode === id}
                  disabled={busy}
                  onClick={() => {
                    if (id !== mode) {
                      setRepoUrl("");
                      if (!destinationEdited) setDestination("");
                      if (!displayNameEdited) setDisplayName("");
                    }
                    setMode(id);
                    setError("");
                  }}
                  className={cn(
                    "flex min-w-0 items-center justify-center gap-1.5 rounded-md px-1 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                    mode === id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{title}</span>
                </button>
              ))}
            </div>

            {isRepoMode ? (
              <div className="space-y-3.5">
                <div className="space-y-1.5">
                  <label htmlFor="project-repository" className="text-xs font-medium">{t("projects.create.repoLabel")}</label>
                  <div className="relative">
                    <Input
                      id="project-repository"
                      placeholder={t("projects.create.repoPlaceholder")}
                      value={repoUrl}
                      disabled={busy}
                      autoComplete="off"
                      spellCheck={false}
                      aria-describedby="repository-help"
                      className={provider ? "pr-24" : undefined}
                      onChange={event => changeRepository(event.target.value)}
                    />
                    {provider && (
                      <span className="pointer-events-none absolute right-2 top-1/2 inline-flex -translate-y-1/2 items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                        {provider === "github" ? <LuGithub aria-hidden className="h-3 w-3" /> : <LuGitlab aria-hidden className="h-3 w-3" />}
                        {provider === "github" ? "GitHub" : "GitLab"}
                      </span>
                    )}
                  </div>
                  <p id="repository-help" className="text-[11px] leading-relaxed text-muted-foreground">{t("projects.create.repoHelp")}</p>
                  {repoUrl.trim() && !repository && <p className="text-xs text-destructive">{t("projects.create.invalidRepoUrl")}</p>}
                </div>

                <RepositoryBrowser
                  key={`repos-${workspaceUuid}`}
                  uuid={workspaceSandbox?.workspace_uuid === workspaceUuid ? workspaceSandbox.uuid : undefined}
                  disabled={busy}
                  value={repository?.url}
                  onSelect={repo => changeRepository(repo.clone_url, repo.default_branch)}
                  onGitlabBaseUrl={baseUrl => { try { setGitlabHost(new URL(baseUrl).host); } catch { /* keep default host */ } }}
                  onConnectingChange={(connectingProvider, connecting) => {
                    if (connecting) setConnectingProvider(connectingProvider);
                    setPhase(current => connecting ? "connecting" : current === "connecting" ? "idle" : current);
                  }}
                />

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label htmlFor="env-display-name" className="text-xs font-medium">{t("projects.edit.nameLabel")}</label>
                    <Input
                      id="env-display-name"
                      placeholder={repository?.name || "my-app"}
                      value={displayName}
                      disabled={busy}
                      onChange={event => { setDisplayName(event.target.value); setDisplayNameEdited(true); }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="env-default-branch" className="text-xs font-medium">{t("projects.create.defaultBranchLabel", "Default branch")}</label>
                    <Input
                      id="env-default-branch"
                      placeholder="main"
                      value={defaultBranch}
                      disabled={busy}
                      className="font-mono text-xs"
                      onChange={event => setDefaultBranch(event.target.value)}
                    />
                  </div>
                </div>
              </div>
            ) : mode === "new" ? (
              <div className="space-y-2">
                <label htmlFor="new-project-path" className="text-xs font-medium">{t("projects.create.folderPath")}</label>
                <Input
                  id="new-project-path"
                  placeholder={t("projects.create.folderPlaceholder")}
                  value={folderPath}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  className="h-10 font-mono text-xs"
                  onChange={event => { setFolderPath(event.target.value); setError(""); }}
                />
                <p className="text-[11px] leading-relaxed text-muted-foreground">{t("projects.create.newFolderHint")}</p>
                {folderPath.trim() && !targetPath && <p className="text-xs text-destructive">{t("projects.create.invalidNewFolder")}</p>}
              </div>
            ) : (
              open && <ProjectFolderPicker value={folderPath} onChange={setFolderPath} disabled={busy} />
            )}

            {/* Collapsible Setup, Scripts & Secrets */}
            <div className="rounded-xl border border-border/70 bg-muted/20">
              <button
                type="button"
                disabled={busy}
                aria-expanded={showAdvanced}
                onClick={() => setShowAdvanced(prev => !prev)}
                className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-xs font-medium text-foreground hover:bg-muted/40 transition-colors rounded-xl"
              >
                <span className="flex items-center gap-2">
                  <LuTerminal className="h-3.5 w-3.5 text-muted-foreground" />
                  {t("projects.create.advancedToggle", "Setup scripts, secrets & instructions (optional)")}
                </span>
                {showAdvanced ? <LuChevronDown className="h-4 w-4 text-muted-foreground" /> : <LuChevronRight className="h-4 w-4 text-muted-foreground" />}
              </button>

              {showAdvanced && (
                <div className="space-y-3.5 border-t border-border/60 px-3.5 py-3">
                  {/* Stack Presets */}
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
                          className="rounded-md border border-border/80 bg-background px-2 py-1 text-[11px] font-medium text-foreground hover:border-violet-500/50 hover:bg-violet-500/5 transition-colors"
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {isRepoMode && (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <label htmlFor="project-destination" className="text-xs font-medium">{t("projects.create.folderPath")}</label>
                        <Input
                          id="project-destination"
                          className="font-mono text-xs"
                          placeholder={t("projects.create.destinationPlaceholder")}
                          value={destination}
                          disabled={busy}
                          autoComplete="off"
                          spellCheck={false}
                          onChange={event => { setDestination(event.target.value); setDestinationEdited(true); setError(""); }}
                        />
                        {destination.trim() && !targetPath && <p className="text-xs text-destructive">{t("projects.create.invalidDestination")}</p>}
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="env-working-subdir" className="text-xs font-medium">{t("projects.create.workingSubdirLabel", "Working subdirectory")}</label>
                        <Input
                          id="env-working-subdir"
                          className="font-mono text-xs"
                          placeholder="e.g. apps/web"
                          value={workingSubdir}
                          disabled={busy}
                          onChange={event => setWorkingSubdir(event.target.value)}
                        />
                      </div>
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <label htmlFor="env-setup-script" className="text-xs font-medium">{t("projects.create.setupScriptLabel", "Setup script")}</label>
                    <Textarea
                      id="env-setup-script"
                      rows={2}
                      className="font-mono text-xs"
                      placeholder="npm ci || uv sync"
                      value={setupScript}
                      disabled={busy}
                      onChange={event => setSetupScript(event.target.value)}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      {t("projects.create.setupScriptHelp", "Runs once when the environment boots fresh or lockfiles change.")}
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="env-maint-script" className="text-xs font-medium">{t("projects.create.maintenanceScriptLabel", "Maintenance script")}</label>
                    <Textarea
                      id="env-maint-script"
                      rows={2}
                      className="font-mono text-xs"
                      placeholder="npm ci --prefer-offline || true"
                      value={maintenanceScript}
                      disabled={busy}
                      onChange={event => setMaintenanceScript(event.target.value)}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="env-secrets-bulk" className="flex items-center gap-1.5 text-xs font-medium">
                      <LuKeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                      {t("projects.create.secretsLabel", "Environment secrets (.env)")}
                    </label>
                    <Textarea
                      id="env-secrets-bulk"
                      rows={3}
                      className="font-mono text-xs"
                      placeholder={"DATABASE_URL=postgres://...\nAPI_TOKEN=sk-..."}
                      value={secretsText}
                      disabled={busy}
                      onChange={event => setSecretsText(event.target.value)}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      {t("projects.create.secretsHelp", "Encrypted at rest and injected into agent runs for this environment only.")}
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="env-usage-guide" className="text-xs font-medium">{t("projects.create.instructionsLabel", "Agent instructions")}</label>
                    <Textarea
                      id="env-usage-guide"
                      rows={2}
                      className="text-xs"
                      placeholder={t("projects.create.instructionsPlaceholder", "Conventions, test commands, or notes for the agent…")}
                      value={usageGuide}
                      disabled={busy}
                      onChange={event => setUsageGuide(event.target.value)}
                    />
                  </div>
                </div>
              )}
            </div>

            {targetPath && (
              <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs">
                <LuGitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate text-muted-foreground">
                  {isRepoMode
                    ? t("projects.create.lazyGithubHint", "Saved instantly — repository clones automatically on first task.")
                    : mode === "new"
                      ? t("projects.create.emptyRepoHint")
                      : t("projects.create.existingRepoHint")}
                </span>
              </div>
            )}

            {error && (
              <div role="alert" className="flex gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
                <LuCircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0 break-words">{error}</div>
              </div>
            )}
          </div>

          <DialogFooter className="shrink-0 gap-2 border-t bg-muted/15 px-5 py-3 sm:space-x-0">
            <Button type="button" variant="ghost" onClick={close} disabled={busy}>{t("common.cancel")}</Button>
            <Button type="submit" className="gap-2" disabled={!workspaceUuid || !targetPath || busy || (isRepoMode && !repository)}>
              {busy ? <LuLoaderCircle className="h-4 w-4 animate-spin" /> : isRepoMode && provider === "github" ? <LuGithub className="h-4 w-4" /> : isRepoMode && provider === "gitlab" ? <LuGitlab className="h-4 w-4" /> : <LuArrowRight className="h-4 w-4" />}
              {phase === "connecting"
                ? t(connectingProvider === "gitlab" ? "projects.create.connectingGitlab" : "projects.create.connectingGithub")
                : phase === "creating"
                  ? t("projects.create.creatingProject")
                  : mode === "folder"
                    ? t("projects.create.addProject")
                    : t("projects.create.createProject")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
