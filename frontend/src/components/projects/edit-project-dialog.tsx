"use client";

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toaster } from "@/components/ui/toaster";
import useSandboxProjectsStore from "@/stores/sandbox-projects";
import useWorkspacesStore from "@/stores/workspaces";
import type { IProject } from "@/stores/sandbox-projects";

interface Props {
  project: IProject | null;
  onOpenChange: (open: boolean) => void;
}

export default function EditProjectDialog({ project, onOpenChange }: Props) {
  const workspaceUuid = useWorkspacesStore(state => state.currentWorkspace?.uuid || state.currentWorkspaceUuid);
  const activeProject = project?.workspace_uuid === workspaceUuid ? project : null;

  return (
    <Dialog open={Boolean(activeProject)} onOpenChange={onOpenChange}>
      {activeProject && <EditProjectForm key={activeProject.uuid} project={activeProject} onClose={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function EditProjectForm({ project, onClose }: { project: IProject; onClose: () => void }) {
  const { t } = useTranslation("workspace");
  const [name, setName] = useState(project.display_name);
  const [description, setDescription] = useState(project.description || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending.current || !name.trim()) return;
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      const updated = await useSandboxProjectsStore.getState().updateSandbox(project.uuid, {
        display_name: name.trim(),
        description: description.trim(),
      });
      if (!updated) {
        setError(useSandboxProjectsStore.getState().errorMessage || t("projects.edit.updateFailed"));
        return;
      }
      onClose();
      toaster.create({ title: t("projects.edit.toastUpdated"), type: "success" });
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  return (
    <DialogContent hideClose={saving} className="w-[calc(100%-2rem)] rounded-xl" onEscapeKeyDown={event => { if (saving) event.preventDefault(); }} onInteractOutside={event => { if (saving) event.preventDefault(); }}>
      <DialogHeader>
        <DialogTitle>{t("projects.edit.title")}</DialogTitle>
        <DialogDescription>{t("projects.edit.description")}</DialogDescription>
      </DialogHeader>
      <form onSubmit={save} className="space-y-4">
        <div>
          <label htmlFor="edit-project-name" className="mb-2 block text-xs font-medium">{t("projects.edit.nameLabel")}</label>
          <Input id="edit-project-name" value={name} onChange={event => setName(event.target.value)} disabled={saving} autoFocus />
        </div>
        <div>
          <label htmlFor="edit-project-description" className="mb-2 block text-xs font-medium">{t("projects.edit.descriptionLabel")}</label>
          <Textarea id="edit-project-description" value={description} onChange={event => setDescription(event.target.value)} disabled={saving} rows={3} />
        </div>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" disabled={!name.trim() || saving} loading={saving}>{t("common.saveChanges")}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
