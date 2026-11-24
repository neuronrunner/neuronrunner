"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCheck, LuFolderGit2, LuLoaderCircle, LuRefreshCw, LuSearch } from "react-icons/lu";
import { cn } from "@/lib/utils";
import { isNoActiveVM, repositoryError, repositoryRequest, type WorkspaceRepository } from "@/lib/repository-api";
import useSandboxProjectsStore from "@/stores/sandbox-projects";
import useWorkspacesStore from "@/stores/workspaces";

type Props = { value: string; onChange: (path: string) => void; disabled?: boolean };

export default function ProjectFolderPicker({ value, onChange, disabled }: Props) {
  const { t } = useTranslation("workspace");
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ uuid?: string; repositories?: WorkspaceRepository[]; error?: string }>({});
  const workspaceSandbox = useSandboxProjectsStore(state => state.workspaceSandbox);
  const projects = useSandboxProjectsStore(state => state.sandboxes);
  const fetchSandboxes = useSandboxProjectsStore(state => state.fetchSandboxes);
  const workspaceUuid = useWorkspacesStore(state => state.currentWorkspace?.uuid || state.currentWorkspaceUuid);
  const uuid = workspaceSandbox?.workspace_uuid === workspaceUuid ? workspaceSandbox.uuid : undefined;
  useEffect(() => { if (!uuid && workspaceUuid) void fetchSandboxes(workspaceUuid); }, [uuid, workspaceUuid, fetchSandboxes]);
  useEffect(() => {
    if (!uuid) return;
    const controller = new AbortController();
    setResult({ uuid });
    repositoryRequest<{ repositories: WorkspaceRepository[] }>(uuid, "git/repositories", { wake: "1" }, controller.signal)
      .then(data => {
        if (!controller.signal.aborted) {
          setResult({ uuid, repositories: data.repositories });
        }
      })
      .catch(error => {
        if (!controller.signal.aborted) {
          if (isNoActiveVM(error)) {
            setResult({ uuid, repositories: [], error: undefined });
          } else {
            setResult({ uuid, error: repositoryError(error) });
          }
        }
      });
    return () => controller.abort();
  }, [uuid, revision, workspaceUuid]);
  const projectPaths = new Set(projects.filter(project => project.workspace_uuid === workspaceUuid).map(project => project.filesystem_path));
  const repositories = result.uuid === uuid ? result.repositories : undefined;
  const error = result.uuid === uuid ? result.error : undefined;
  const folders = (repositories || []).filter(repo => repo.path !== "/workspace" && repo.path.toLowerCase().includes(query.toLowerCase()));
  return <div className="space-y-2">
    <div className="flex items-center justify-between"><label className="text-xs font-medium" htmlFor="existing-repository-search">{t("projects.folderPicker.existingReposLabel")}</label><button type="button" aria-label={t("projects.folderPicker.refreshAria")} disabled={disabled} onClick={() => uuid ? setRevision(value => value + 1) : void fetchSandboxes(workspaceUuid || undefined)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"><LuRefreshCw className="h-3.5 w-3.5" /></button></div>
    <div className="overflow-hidden rounded-lg border border-border/60">
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/20 px-3"><LuSearch className="h-3.5 w-3.5 text-muted-foreground" /><input id="existing-repository-search" aria-label={t("projects.folderPicker.findRepoAria")} value={query} onChange={event => setQuery(event.target.value)} placeholder={t("projects.folderPicker.searchPlaceholder")} className="h-9 min-w-0 flex-1 bg-transparent text-xs outline-none" disabled={disabled} /></div>
      <div role="listbox" aria-label={t("projects.folderPicker.gitFoldersAria")} className="max-h-52 min-h-28 overflow-y-auto p-1">
        {folders.map(folder => <button key={folder.path} type="button" role="option" aria-selected={value === folder.path} disabled={disabled || projectPaths.has(folder.path)} onClick={() => onChange(folder.path)} className={cn("flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40", value === folder.path && "bg-muted")}><LuFolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{folder.name}</span><span className="block truncate font-mono text-[10px] text-muted-foreground">{folder.path}</span></span>{projectPaths.has(folder.path) ? <span className="text-[10px] text-muted-foreground">{t("projects.folderPicker.added")}</span> : value === folder.path && <LuCheck className="h-3.5 w-3.5" />}</button>)}
        {!folders.length && <div role={error ? "alert" : "status"} className="flex flex-col items-center gap-2 px-4 py-6 text-center text-xs text-muted-foreground">{!repositories && !error ? <LuLoaderCircle className="h-4 w-4 animate-spin" /> : <LuFolderGit2 className="h-5 w-5" />}<p>{error || (!repositories ? t("projects.folderPicker.findingRepos") : query ? t("projects.folderPicker.noMatchingRepos") : t("projects.folderPicker.noReposFound"))}</p></div>}
      </div>
    </div>
    <p className="text-[11px] text-muted-foreground">{t("projects.folderPicker.onlyGitHint")}</p>
  </div>;
}
