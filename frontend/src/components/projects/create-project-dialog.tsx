"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { lazyView } from "@/lib/lazy-view";
import { useRouter } from "@/lib/navigation";
import { LuArrowRight, LuCircleAlert, LuFolder, LuFolderPlus, LuGitBranch, LuGithub, LuLoaderCircle } from "react-icons/lu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toaster } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";
import { normalizeProjectPath, parseGithubRepository } from "@/lib/project-import";
import GithubRepositoryAccess from "@/components/git/github-repository-access";
import ProjectFolderPicker from "./project-folder-picker";
import useChatStore from "@/stores/chat";
import useSandboxProjectsStore from "@/stores/sandbox-projects";
import useSidebarStore from "@/stores/sidebar";
import useWorkspacesStore from "@/stores/workspaces";
import useWorkspaceTabsStore from "@/stores/workspace-tabs";
import type { IProject } from "@/stores/sandbox-projects";

const GitCloneProgress = lazyView(() => import("@/components/git/git-clone-progress").then(module => module.default));

interface Props {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCreated?: (project: IProject) => Promise<void> | void;
  initialMode?: "new" | "folder" | "github";
}

export default function CreateProjectDialog({ open: controlledOpen, onOpenChange, onCreated, initialMode = "new" }: Props) {
  const { t } = useTranslation("workspace");
  const router = useRouter();
  const dialogOpen = useSandboxProjectsStore(state => state.isCreateProjectDialogOpen);
  const setDialogOpen = useSandboxProjectsStore(state => state.setCreateProjectDialogOpen);
  const open = controlledOpen ?? dialogOpen;
  const setOpen = onOpenChange ?? setDialogOpen;
  const workspaceSandbox = useSandboxProjectsStore(state => state.workspaceSandbox);
  const workspaceUuid = useWorkspacesStore(state => state.currentWorkspace?.uuid || state.currentWorkspaceUuid);
  const [mode, setMode] = useState<"new" | "folder" | "github">("new");
  const [folderPath, setFolderPath] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [destination, setDestination] = useState("");
  const [destinationEdited, setDestinationEdited] = useState(false);
  const [phase, setPhase] = useState<"idle" | "connecting" | "cloning" | "creating">("idle");
  const [cloned, setCloned] = useState<string | null>(null);
  const [cloneLog, setCloneLog] = useState("");
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const busy = phase !== "idle";
  const repository = parseGithubRepository(repoUrl);
  const targetPath = normalizeProjectPath(mode !== "github" ? folderPath : destination);
  const cloneKey = `${workspaceUuid}:${repository?.url}:${targetPath}`;
  const alreadyCloned = cloned === cloneKey;
  const showProgress = mode === "github" && (phase === "cloning" || phase === "creating" || !!cloneLog);

  useEffect(() => {
    if (open) { setMode(initialMode); return; }
    setMode("new"); setFolderPath(""); setRepoUrl(""); setDestination("");
    setDestinationEdited(false); setCloned(null); setCloneLog(""); setError("");
  }, [open, initialMode]);

  const changeRepository = (value: string) => {
    setRepoUrl(value); setError(""); setCloneLog("");
    if (!destinationEdited) { const repo = parseGithubRepository(value); setDestination(repo ? `/workspace/${repo.name}` : ""); }
  };
  const close = () => { if (!busy && !submitting.current) setOpen(false); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || submitting.current || !workspaceUuid || !targetPath || (mode === "github" && !repository)) return;
    submitting.current = true;
    setError("");
    const store = useSandboxProjectsStore.getState();
    const activeVmUuid: string | undefined = undefined;
    try {
      if (!alreadyCloned && store.sandboxes.some(project => project.workspace_uuid === workspaceUuid && project.filesystem_path === targetPath)) {
        throw new Error(t("projects.create.alreadyProjectError"));
      }
      if (mode === "github" && repository && !alreadyCloned) {
        setPhase("cloning"); setCloneLog("");
        let filesystem = store.workspaceSandbox;
        if (!filesystem || filesystem.workspace_uuid !== workspaceUuid) {
          await store.fetchSandboxes(workspaceUuid);
          filesystem = useSandboxProjectsStore.getState().workspaceSandbox;
        }
        if (!filesystem || filesystem.workspace_uuid !== workspaceUuid) throw new Error(t("projects.create.workspaceLoadError"));
        await store.cloneRepository(filesystem.uuid, repository.url, text => setCloneLog(previous => (previous + text).slice(-16000)), targetPath, activeVmUuid);
        setCloned(cloneKey);
      }
      const currentWorkspace = useWorkspacesStore.getState();
      if ((currentWorkspace.currentWorkspace?.uuid || currentWorkspace.currentWorkspaceUuid) !== workspaceUuid) throw new Error(t("projects.create.workspaceChangedError"));
      setPhase("creating");
      let project: IProject | null;
      if (mode === "github") {
        if (alreadyCloned) await store.fetchSandboxes(workspaceUuid);
        const registered = useSandboxProjectsStore.getState().sandboxes.find(project => project.workspace_uuid === workspaceUuid && project.filesystem_path === targetPath);
        if (!registered) throw new Error(t("projects.create.clonedReloadError"));
        project = await store.pickSandbox(registered.uuid);
      } else {
        project = await store.createSandbox({
          filesystem_path: targetPath,
          workspace_uuid: workspaceUuid,
          vm_uuid: activeVmUuid,
          source: mode === "new" ? "new" : "existing",
        });
      }
      if (!project) throw new Error(useSandboxProjectsStore.getState().errorMessage || t("projects.create.createFailed"));
      if (onCreated) await onCreated(project);
      else {
        useChatStore.getState().reset();
        useChatStore.getState().setChatMode("code");
        useWorkspaceTabsStore.getState().openChatTab(undefined, undefined, "left");
        await useSidebarStore.getState().fetchConversations(false, project.uuid);
        router.push("/new");
      }
      setOpen(false);
      toaster.create({ title: mode === "github" ? t("projects.create.toastImported") : t("projects.create.toastCreated"), description: project.filesystem_path, type: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("projects.create.createFailed"));
    } finally { submitting.current = false; setPhase("idle"); }
  };

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) close(); }}>
      <DialogContent hideClose={busy} className="flex max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg flex-col gap-0 overflow-hidden rounded-2xl p-0" onInteractOutside={event => { if (busy) event.preventDefault(); }} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
        <DialogHeader className="shrink-0 px-5 pb-3 pt-5 text-left">
          <div className="mb-1 flex items-center gap-3"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/10 text-violet-500"><LuFolderPlus className="h-4 w-4" /></div><DialogTitle className="text-lg">{t("projects.create.title")}</DialogTitle></div>
          <DialogDescription>{t("projects.create.description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={event => void submit(event)} className="flex min-h-0 flex-col">
          <div className="space-y-4 overflow-y-auto px-5 pb-5 pt-2">
            {showProgress ? <>
              <GitCloneProgress log={cloneLog} status={error ? "error" : phase === "creating" ? "creating" : alreadyCloned ? "success" : "cloning"} repository={repository?.fullName} destination={targetPath || destination} />
              {!busy && <Button type="button" size="sm" variant="outline" onClick={() => { setCloneLog(""); setError(""); }}>{t("projects.create.backToRepositories")}</Button>}
            </> : <>
            <div role="group" aria-label={t("projects.create.sourceAria")} className="grid grid-cols-3 gap-1 rounded-lg bg-muted/50 p-1">
              {([{ id: "new", Icon: LuFolderPlus, title: t("projects.create.modeNew") }, { id: "folder", Icon: LuFolder, title: t("projects.create.modeExisting") }, { id: "github", Icon: LuGithub, title: t("projects.create.modeGithub") }] as const).map(({ id, Icon, title }) => (
                <button key={id} type="button" aria-pressed={mode === id} disabled={busy} onClick={() => { setMode(id); setFolderPath(""); setError(""); }} className={cn("flex min-w-0 items-center justify-center gap-1.5 rounded-md px-1 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", mode === id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                  <Icon className="h-3.5 w-3.5 shrink-0" /><span>{title}</span>
                </button>
              ))}
            </div>
            {mode === "new" ? <div className="space-y-2">
              <label htmlFor="new-project-path" className="text-xs font-medium">{t("projects.create.folderPath")}</label>
              <Input id="new-project-path" placeholder={t("projects.create.folderPlaceholder")} value={folderPath} disabled={busy} autoComplete="off" spellCheck={false} className="h-10 font-mono text-xs" onChange={event => { setFolderPath(event.target.value); setError(""); }} />
              <p className="text-[11px] leading-relaxed text-muted-foreground">{t("projects.create.newFolderHint")}</p>
              {folderPath.trim() && !targetPath && <p className="text-xs text-destructive">{t("projects.create.invalidNewFolder")}</p>}
            </div> : mode === "folder" ? open && <ProjectFolderPicker value={folderPath} onChange={setFolderPath} disabled={busy} /> : <div className="space-y-4">
              <GithubRepositoryAccess key={workspaceUuid} uuid={workspaceSandbox?.workspace_uuid === workspaceUuid ? workspaceSandbox.uuid : undefined} disabled={busy || alreadyCloned} value={repository?.url} onSelect={changeRepository} onConnectingChange={connecting => setPhase(current => connecting ? "connecting" : current === "connecting" ? "idle" : current)} />
              <div className="space-y-2">
                <label htmlFor="project-repository" className="text-sm font-medium">{t("projects.create.githubRepoLabel")}</label>
                <Input id="project-repository" placeholder={t("projects.create.githubRepoPlaceholder")} value={repoUrl} disabled={busy || alreadyCloned} autoComplete="off" spellCheck={false} aria-describedby="repository-help" onChange={event => changeRepository(event.target.value)} />
                <p id="repository-help" className="text-xs leading-relaxed text-muted-foreground">{t("projects.create.githubRepoHelp")}</p>
                {repoUrl.trim() && !repository && <p className="text-xs text-destructive">{t("projects.create.invalidGithubUrl")}</p>}
              </div>
              <div className="space-y-2">
                <label htmlFor="project-destination" className="text-sm font-medium">{t("projects.create.folderPath")}</label>
                <Input id="project-destination" className="font-mono text-xs" placeholder={t("projects.create.destinationPlaceholder")} value={destination} disabled={busy || alreadyCloned} autoComplete="off" spellCheck={false} onChange={event => { setDestination(event.target.value); setDestinationEdited(true); setError(""); }} />
                <p className="text-xs text-muted-foreground">{t("projects.create.destinationHelp")}</p>
                {destination.trim() && !targetPath && <p className="text-xs text-destructive">{t("projects.create.invalidDestination")}</p>}
              </div>
            </div>}
            {targetPath && <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2.5 text-xs"><LuGitBranch className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 truncate text-muted-foreground">{mode === "new" ? t("projects.create.emptyRepoHint") : t("projects.create.existingRepoHint")}</span></div>}
            </>}
            {error && <div role="alert" className="flex gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive"><LuCircleAlert className="mt-0.5 h-4 w-4 shrink-0" /><div className="min-w-0 break-words">{error}{alreadyCloned && <p className="mt-1 text-xs">{t("projects.create.readyRetryHint")}</p>}</div></div>}
          </div>
          <DialogFooter className="shrink-0 gap-2 border-t bg-muted/15 px-5 py-3 sm:space-x-0">
            <Button type="button" variant="ghost" onClick={close} disabled={busy}>{t("common.cancel")}</Button>
            <Button type="submit" className="gap-2" disabled={!workspaceUuid || !targetPath || busy || (mode === "github" && !repository)}>
              {busy ? <LuLoaderCircle className="h-4 w-4 animate-spin" /> : mode === "github" && !alreadyCloned ? <LuGithub className="h-4 w-4" /> : <LuArrowRight className="h-4 w-4" />}
              {phase === "connecting" ? t("projects.create.connectingGithub") : phase === "cloning" ? t("projects.create.cloningRepo") : phase === "creating" ? t("projects.create.creatingProject") : mode === "github" && !alreadyCloned ? t("projects.create.cloneRepo") : mode === "folder" ? t("projects.create.addProject") : t("projects.create.createProject")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
