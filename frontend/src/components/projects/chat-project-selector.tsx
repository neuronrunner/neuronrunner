"use client";

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuArrowLeft, LuCheck, LuChevronDown, LuFolderCode, LuFolderPlus, LuGithub, LuMessageSquare, LuSearch, LuTrash2 } from "react-icons/lu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import CreateProjectDialog from "./create-project-dialog";
import ProjectBranchPicker from "./project-branch-picker";
import RemoveProjectDialog from "./remove-project-dialog";
import useSandboxProjectsStore, { type IProject } from "@/stores/sandbox-projects";
import useWorkspacesStore from "@/stores/workspaces";
import useChatStore from "@/stores/chat";

export default function ChatProjectSelector() {
  const { t } = useTranslation("workspace");
  const current = useSandboxProjectsStore(state => state.currentSandbox);
  const projects = useSandboxProjectsStore(state => state.sandboxes);
  const filesystem = useSandboxProjectsStore(state => state.workspaceSandbox);
  const loading = useSandboxProjectsStore(state => state.isLoading);
  const workspaceUuid = useWorkspacesStore(state => state.currentWorkspace?.uuid || state.currentWorkspaceUuid);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<IProject | null>(null);
  const [removeTarget, setRemoveTarget] = useState<IProject | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<"new" | "folder" | "github">("new");
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = current?.workspace_uuid === workspaceUuid ? current : null;
  const target = pending?.workspace_uuid === workspaceUuid ? pending : null;
  const filesystemUuid = filesystem?.workspace_uuid === workspaceUuid ? filesystem.uuid : undefined;
  const query = search.trim().toLocaleLowerCase();
  const visibleProjects = projects.filter(project => project.workspace_uuid === workspaceUuid)
    .filter(project => `${project.display_name} ${project.filesystem_path}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(b.is_favorite) - Number(a.is_favorite) || a.display_name.localeCompare(b.display_name));
  const select = (project: IProject | null) => {
    const active = useWorkspacesStore.getState();
    if (workspaceUuid !== (active.currentWorkspace?.uuid || active.currentWorkspaceUuid)) return;
    useSandboxProjectsStore.setState({ currentSandbox: project });
    if (project) void useSandboxProjectsStore.getState().pickSandbox(project.uuid);
    useChatStore.getState().setChatMode(project ? "code" : "chat");
    setOpen(false); setPending(null);
  };
  const create = (mode: "new" | "folder" | "github") => { setCreateMode(mode); setOpen(false); setPending(null); setCreateOpen(true); };
  const remove = (project: IProject) => { setOpen(false); setPending(null); setRemoveTarget(project); };
  return <>
    <div className="flex min-w-0 flex-wrap items-center gap-1 px-1 py-1 text-left">
      <Popover open={open} onOpenChange={next => { setOpen(next); if (!next) { setSearch(""); setPending(null); } }}>
        <PopoverTrigger asChild><button type="button" aria-label={t("projects.selector.chooseProjectAria", { name: selected?.display_name || t("projects.selector.noProject") })} title={selected?.filesystem_path} className="flex h-9 max-w-64 items-center gap-2 rounded-lg bg-transparent px-2.5 text-sm font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">{selected ? <LuFolderCode className="h-4 w-4 shrink-0 text-muted-foreground" /> : <LuMessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />}<span className="truncate">{selected?.display_name || t("projects.selector.noProject")}</span><LuChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /></button></PopoverTrigger>
        <PopoverContent align="start" sideOffset={8} className="w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl p-0 shadow-xl" onOpenAutoFocus={event => { event.preventDefault(); searchRef.current?.focus(); }}>
          {target ? <><div className="flex items-center gap-2 border-b px-3 py-3"><button type="button" aria-label={t("projects.selector.backToProjects")} onClick={() => setPending(null)} className="rounded-md p-1 hover:bg-muted"><LuArrowLeft className="h-4 w-4" /></button><span className="min-w-0"><span className="block truncate text-sm font-medium">{target.display_name}</span><span className="block truncate font-mono text-xs text-muted-foreground">{target.filesystem_path}</span></span></div><div className="p-2"><ProjectBranchPicker key={target.uuid} uuid={filesystemUuid || target.uuid} path={target.filesystem_path} inline onSelected={() => select(target)} project={target} /></div></> : <>
            <div className="flex items-center gap-2 border-b px-3 py-2.5"><LuSearch className="h-4 w-4 shrink-0 text-muted-foreground" /><input ref={searchRef} aria-label={t("projects.selector.searchAria")} placeholder={t("projects.selector.searchPlaceholder")} value={search} onChange={event => setSearch(event.target.value)} className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none" /></div>
            <div className="p-1"><button type="button" aria-pressed={!selected} onClick={() => select(null)} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted"><LuMessageSquare className="h-4 w-4 text-muted-foreground" /><span className="flex-1">{t("projects.selector.noProject")}</span>{!selected && <LuCheck className="h-4 w-4" />}</button></div>
            <div className="max-h-60 overflow-y-auto overscroll-contain px-1 pb-1">{visibleProjects.map(project => <div key={project.uuid} className="flex items-center rounded-md hover:bg-muted"><button type="button" aria-pressed={selected?.uuid === project.uuid} onClick={() => select(project)} className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left"><LuFolderCode className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{project.display_name}</span><span className="block truncate font-mono text-xs text-muted-foreground">{project.filesystem_path}</span></span>{selected?.uuid === project.uuid && <LuCheck className="h-4 w-4 shrink-0" />}</button><button type="button" aria-label={t("projects.selector.removeProjectAria", { name: project.display_name })} title={t("projectDetail.removeProject")} onClick={() => remove(project)} className="mr-1 shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><LuTrash2 className="h-4 w-4" /></button></div>)}{!visibleProjects.length && <p role="status" className="px-3 py-5 text-center text-sm text-muted-foreground">{loading ? t("projects.selector.loadingProjects") : query ? t("projects.selector.noMatchingProjects") : t("projects.selector.noProjectsYet")}</p>}</div>
            <div className="border-t bg-muted/15 p-1"><button type="button" onClick={() => create("new")} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted"><LuFolderPlus className="h-4 w-4 text-muted-foreground" />{t("projects.selector.newProject")}</button><button type="button" onClick={() => create("github")} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted"><LuGithub className="h-4 w-4 text-muted-foreground" />{t("projects.selector.cloneFromGithub")}</button></div>
          </>}
        </PopoverContent>
      </Popover>
      {selected && <><span className="h-4 w-px bg-border/60" /><ProjectBranchPicker key={selected.uuid} uuid={filesystemUuid || selected.uuid} path={selected.filesystem_path} project={selected} /></>}
    </div>
    <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} initialMode={createMode} />
    <RemoveProjectDialog project={removeTarget} onOpenChange={open => { if (!open) setRemoveTarget(null); }} />
  </>;
}
