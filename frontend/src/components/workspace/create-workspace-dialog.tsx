"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "@/lib/navigation";
import { LuArrowRight, LuUsers } from "react-icons/lu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toaster } from "@/components/ui/toaster";
import useChatStore from "@/stores/chat";
import useSandboxProjectsStore from "@/stores/sandbox-projects";
import useSettingsStore from "@/stores/settings";
import useSidebarStore from "@/stores/sidebar";
import useWorkspacesStore from "@/stores/workspaces";
import useWorkspaceTabsStore from "@/stores/workspace-tabs";
import ProfilePicture from "@/components/profile-picture";

export default function CreateWorkspaceDialog() {
  const { t } = useTranslation("workspace");
  const router = useRouter();
  const [name, setName] = useState("");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const {
    isCreateDialogOpen,
    setCreateDialogOpen,
    createWorkspace,
    setMembersDialogOpen,
    errorMessage,
    resetError,
  } = useWorkspacesStore();

  const handleOpenChange = (open: boolean) => {
    if (isCreating) return;
    setCreateDialogOpen(open);
    if (!open) {
      setName("");
      setPhotoFile(null);
    }
  };

  const handleCreate = async () => {
    if (!name.trim() || isCreating) return;
    setIsCreating(true);
    try {
      const workspace = await createWorkspace(name.trim(), photoFile);
      if (!workspace) return;

      await useSandboxProjectsStore.getState().fetchSandboxes(workspace.uuid);
      useChatStore.getState().reset();
      useWorkspaceTabsStore.getState().resetForWorkspace();
      useSidebarStore.setState({ conversations: [], conversationProjectId: null });
      setCreateDialogOpen(false);
      setName("");
      setPhotoFile(null);
      useSettingsStore.getState().setSettingsDialogOpen(false);
      useWorkspacesStore.getState().setWorkspaceSettingsDialogOpen(false);
      router.push("/new");
      setMembersDialogOpen(true);
      toaster.create({
        title: t("createWorkspace.toastTitle"),
        description: t("createWorkspace.toastDescription"),
        type: "success",
      });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Dialog open={isCreateDialogOpen} onOpenChange={handleOpenChange}>
      <DialogContent overlayClassName="z-[1400]" className="z-[1400] max-h-[calc(100dvh_-_2rem)] w-[calc(100vw_-_2rem)] max-w-[440px] grid-cols-[minmax(0,1fr)] gap-6 overflow-y-auto rounded-2xl p-6" hideClose={isCreating}>
        <DialogHeader className="space-y-3 text-left">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-300"><LuUsers className="h-5 w-5" /></span>
          <DialogTitle className="text-xl">{t("createWorkspace.title")}</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">{t("createWorkspace.description")}</DialogDescription>
        </DialogHeader>

        <form id="create-workspace-form" onSubmit={(event) => { event.preventDefault(); void handleCreate(); }} className="space-y-5">
          <div className="space-y-2">
            <label htmlFor="workspace-name" className="text-xs font-semibold text-foreground">
              {t("createWorkspace.nameLabel")}
            </label>
            <Input
              id="workspace-name"
              value={name}
              onChange={(event) => { setName(event.target.value); if (errorMessage) resetError(); }}
              placeholder={t("createWorkspace.namePlaceholder")}
              maxLength={120}
              disabled={isCreating}
              required
              className="h-10 rounded-lg"
              autoFocus
            />
            {errorMessage && <p role="alert" className="text-xs text-destructive">{errorMessage}</p>}
          </div>
          <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-muted/20 p-3.5">
            <ProfilePicture
              id="create-workspace-picture-input"
              size="48px"
              disabled={isCreating}
              onUpload={(file) => setPhotoFile(file)}
              onRemove={() => setPhotoFile(null)}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{name.trim() || t("createWorkspace.defaultName")}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{t("createWorkspace.pictureHint")}</p>
            </div>
          </div>
        </form>

        <DialogFooter className="gap-2 border-t border-border/60 pt-4 sm:space-x-0">
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={isCreating} className="w-full sm:w-auto">
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="create-workspace-form" loading={isCreating} disabled={!name.trim() || isCreating} className="w-full rounded-lg sm:w-auto">
            {isCreating ? t("createWorkspace.creating") : t("createWorkspace.createButton")}
            {!isCreating && <LuArrowRight />}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
