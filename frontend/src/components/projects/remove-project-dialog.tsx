"use client";

import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toaster } from "@/components/ui/toaster";
import useSandboxProjectsStore from "@/stores/sandbox-projects";
import useWorkspacesStore from "@/stores/workspaces";
import useChatStore from "@/stores/chat";
import useSidebarStore from "@/stores/sidebar";
import type { IProject } from "@/stores/sandbox-projects";

export default function RemoveProjectDialog({ project, onOpenChange }: { project: IProject | null; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation("workspace");
  const workspaceUuid = useWorkspacesStore(state => state.currentWorkspace?.uuid || state.currentWorkspaceUuid);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const currentProject = useRef(project?.uuid);
  currentProject.current = project?.uuid;
  useEffect(() => { setError(""); }, [project?.uuid]);
  const activeProject = project?.workspace_uuid === workspaceUuid ? project : null;
  const changeOpen = (open: boolean) => { if (!pending.current) onOpenChange(open); };
  const remove = async () => {
    if (!activeProject || pending.current) return;
    const target = activeProject;
    const wasSelected = useSandboxProjectsStore.getState().currentSandbox?.uuid === target.uuid;
    pending.current = true;
    setRemoving(true); setError("");
    try {
      if (!await useSandboxProjectsStore.getState().deleteSandbox(target.uuid)) {
        if (currentProject.current === target.uuid) setError(useSandboxProjectsStore.getState().errorMessage || t("projects.remove.removeFailed"));
        return;
      }
      const workspace = useWorkspacesStore.getState();
      if ((workspace.currentWorkspace?.uuid || workspace.currentWorkspaceUuid) !== target.workspace_uuid) return;
      if (wasSelected && !useSandboxProjectsStore.getState().currentSandbox) useChatStore.getState().setChatMode("chat");
      const filesystem = useSandboxProjectsStore.getState().workspaceSandbox;
      if (filesystem?.workspace_uuid === target.workspace_uuid) void useSidebarStore.getState().fetchGeneralConversations(false, filesystem.uuid);
      if (currentProject.current === target.uuid) onOpenChange(false);
      toaster.create({ title: t("projects.remove.toastRemoved"), type: "success" });
    } finally { pending.current = false; setRemoving(false); }
  };

  return <Dialog open={Boolean(activeProject)} onOpenChange={changeOpen}>
    <DialogContent hideClose={removing} className="w-[calc(100%-2rem)] rounded-xl" onEscapeKeyDown={event => { if (removing) event.preventDefault(); }} onInteractOutside={event => { if (removing) event.preventDefault(); }}>
      <DialogHeader>
        <DialogTitle className="break-words">{t("projects.remove.title", { name: activeProject?.display_name })}</DialogTitle>
        <DialogDescription>
          <Trans
            i18nKey="projects.remove.description"
            ns="workspace"
            values={{ path: activeProject?.filesystem_path || "" }}
            components={{ path: <span className="break-all font-mono text-xs" /> }}
          />
        </DialogDescription>
      </DialogHeader>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={removing} onClick={() => changeOpen(false)}>{t("common.cancel")}</Button>
        <Button type="button" variant="destructive" loading={removing} onClick={() => void remove()}>{t("projects.remove.removeButton")}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
