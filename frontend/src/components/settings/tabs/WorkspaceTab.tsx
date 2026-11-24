"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import useWorkspacesStore from "@/stores/workspaces";
import ProfilePicture from "@/components/profile-picture";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toaster } from "@/components/ui/toaster";
import { WorkspaceRoleBadge } from "@/components/workspace/workspace-identity";

export default function WorkspaceTab() {
  const { t } = useTranslation("settings");
  const { currentWorkspace: workspace, updateWorkspace, fetchWorkspaces, isLoading } = useWorkspacesStore();
  const [name, setName] = useState(workspace?.name || "");
  const [busy, setBusy] = useState(false);
  const [isUpdatingPhoto, setIsUpdatingPhoto] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (workspace) {
      setName(workspace.name);
      setError("");
    }
  }, [workspace?.uuid, workspace?.name]);

  if (!workspace) {
    if (isLoading) {
      return (
        <div className="space-y-6" role="status" aria-label={t("workspaceTab.loadingAriaLabel")}>
          <div className="space-y-2">
            <Skeleton className="h-5 w-40 rounded" />
            <Skeleton className="h-3.5 w-72 rounded" />
          </div>
          <div className="p-5 rounded-2xl border border-border dark:border-white/10 space-y-4">
            <div className="flex items-center gap-4">
              <Skeleton className="h-16 w-16 rounded-xl shrink-0" />
              <div className="space-y-2 flex-1">
                <Skeleton className="h-4 w-32 rounded" />
                <Skeleton className="h-3 w-56 rounded" />
              </div>
            </div>
            <div className="space-y-2">
              <Skeleton className="h-3 w-28 rounded" />
              <Skeleton className="h-10 w-full rounded-xl" />
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="py-6 text-sm text-muted-foreground">
        {t("workspaceTab.selectWorkspace")}
      </div>
    );
  }

  const canManage = ["owner", "admin"].includes(workspace.user_role);

  const handlePhotoUpload = async (file: File) => {
    if (!workspace || !canManage) return;
    setIsUpdatingPhoto(true);
    setError("");
    try {
      await updateWorkspace(workspace.uuid, { profile_picture: file });
      toaster.create({
        title: t("workspaceTab.toast.pictureUpdatedTitle"),
        description: t("workspaceTab.toast.pictureUpdatedDescription"),
        type: "success",
      });
    } catch (err: any) {
      const msg = err?.response?.data?.error || t("workspaceTab.errors.uploadFailed");
      setError(msg);
      toaster.create({
        title: t("workspaceTab.toast.uploadFailedTitle"),
        description: msg,
        type: "error",
      });
    } finally {
      setIsUpdatingPhoto(false);
    }
  };

  const handlePhotoRemove = async () => {
    if (!workspace || !canManage) return;
    setIsUpdatingPhoto(true);
    setError("");
    try {
      await updateWorkspace(workspace.uuid, { profile_picture: "" });
      toaster.create({
        title: t("workspaceTab.toast.pictureRemovedTitle"),
        description: t("workspaceTab.toast.pictureRemovedDescription"),
        type: "success",
      });
    } catch (err: any) {
      const msg = err?.response?.data?.error || t("workspaceTab.errors.removeFailed");
      setError(msg);
      toaster.create({
        title: t("workspaceTab.toast.removalFailedTitle"),
        description: msg,
        type: "error",
      });
    } finally {
      setIsUpdatingPhoto(false);
    }
  };

  const handleSaveName = async (event?: React.FormEvent) => {
    if (event) event.preventDefault();
    if (!workspace || !canManage || busy || !name.trim() || name.trim() === workspace.name) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await updateWorkspace(workspace.uuid, { name: name.trim() });
      toaster.create({
        title: t("workspaceTab.toast.updatedTitle"),
        description: t("workspaceTab.toast.updatedDescription"),
        type: "success",
      });
    } catch (err: any) {
      const msg = err?.response?.data?.error || t("workspaceTab.errors.updateFailed");
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl w-full space-y-6">
      {/* Header text */}
      <div>
        <h2 className="text-base font-semibold text-foreground tracking-tight">{t("workspaceTab.title")}</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          {t("workspaceTab.subtitle")}
        </p>
      </div>

      {/* Avatar Card */}
      <div className="p-5 rounded-2xl border border-border dark:border-white/10 bg-card dark:bg-white/[0.02] flex items-center justify-between gap-4 shadow-sm dark:shadow-none">
        <div className="flex items-center gap-4">
          <ProfilePicture
            id="workspace-picture-input"
            size="80px"
            image={workspace.profile_picture || undefined}
            disabled={!canManage || isUpdatingPhoto}
            onUpload={handlePhotoUpload}
            onRemove={handlePhotoRemove}
          />
          <div>
            <h3 className="text-sm font-medium text-foreground">{t("workspaceTab.picture.title")}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("workspaceTab.picture.hint")}
            </p>
            {!canManage && (
              <p className="text-[11px] text-muted-foreground/80 mt-1">
                {t("workspaceTab.picture.permissionHint")}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Workspace Info Card */}
      <div className="p-5 rounded-2xl border border-border dark:border-white/10 bg-card dark:bg-white/[0.02] space-y-4 shadow-sm dark:shadow-none">
        <form onSubmit={handleSaveName} className="space-y-4">
          {/* Workspace Name */}
          <div className="space-y-1.5">
            <label
              htmlFor="workspace-name"
              className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
              {t("workspaceTab.fields.name.label")}
            </label>
            <Input
              id="workspace-name"
              value={name}
              maxLength={120}
              required
              disabled={!canManage || busy}
              onChange={(event) => {
                setName(event.target.value);
                if (error) setError("");
              }}
              className="h-10 rounded-xl bg-muted/40 dark:bg-black/30 border-input dark:border-white/10 text-sm focus:border-ring focus:ring-1 focus:ring-ring"
              placeholder={t("workspaceTab.fields.name.placeholder")}
            />
          </div>

          {/* Workspace Slug */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t("workspaceTab.fields.slug.label")}
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground translate-y-0.5 pointer-events-none select-none">
                /
              </span>
              <Input
                value={workspace.slug}
                readOnly
                disabled
                className="pl-7 h-10 rounded-xl bg-muted/20 dark:bg-black/20 border-input dark:border-white/10 text-sm opacity-70 cursor-not-allowed"
              />
            </div>
            <p className="text-[11px] text-muted-foreground/80">
              {t("workspaceTab.fields.slug.hint")}
            </p>
          </div>

          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}

          <div className="pt-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{t("workspaceTab.yourRole")}</span>
              <WorkspaceRoleBadge role={workspace.user_role} />
            </div>

            {canManage && (
              <Button
                type="submit"
                disabled={busy || !name.trim() || name.trim() === workspace.name}
                loading={busy}
                className="rounded-xl"
              >
                {t("workspaceTab.saveChanges")}
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
