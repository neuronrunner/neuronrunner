"use client";

import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { LuCpu } from "react-icons/lu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toaster } from "@/components/ui/toaster";
import { COMPUTE_TIERS, coresToVcpu, getComputeTier, isValidTierId, matchTierByResources, vcpuToCores, type VMTierId } from "@/lib/compute";
import { cn } from "@/lib/utils";
import useSandboxProjectsStore from "@/stores/sandbox-projects";
import useWorkspacesStore, { type IWorkspace } from "@/stores/workspaces";

export default function WorkspaceSandboxSettingsDialog() {
  const { currentWorkspace, isSandboxSettingsDialogOpen, setSandboxSettingsDialogOpen } = useWorkspacesStore();

  return (
    <Dialog open={isSandboxSettingsDialogOpen && !!currentWorkspace} onOpenChange={setSandboxSettingsDialogOpen}>
      {isSandboxSettingsDialogOpen && currentWorkspace && (
        <SandboxSettings key={currentWorkspace.uuid} workspace={currentWorkspace} onClose={() => setSandboxSettingsDialogOpen(false)} />
      )}
    </Dialog>
  );
}

function SandboxSettings({ workspace, onClose }: { workspace: IWorkspace; onClose: () => void }) {
  const { t } = useTranslation("workspace");
  const fetchSandboxes = useSandboxProjectsStore((state) => state.fetchSandboxes);
  const updateSandbox = useSandboxProjectsStore((state) => state.updateSandbox);
  const [sandboxUuid, setSandboxUuid] = useState<string | null>(null);
  const [selectedTier, setSelectedTier] = useState<VMTierId>("tier_2");
  const [initialTier, setInitialTier] = useState<VMTierId | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setSandboxUuid(null);
    void fetchSandboxes(workspace.uuid).then(() => {
      if (cancelled) return;
      const state = useSandboxProjectsStore.getState();
      const sandbox = state.workspaceSandbox;
      if (sandbox?.workspace_uuid === workspace.uuid) {
        const matched = matchTierByResources(coresToVcpu(sandbox.sandbox_cpu, 1), sandbox.sandbox_memory || 4096);
        setSandboxUuid(sandbox.uuid);
        setSelectedTier(matched.id);
        setInitialTier(matched.id);
      } else {
        setError(state.errorMessage || t("sandboxSettings.loadError"));
      }
      setIsLoading(false);
    });
    return () => { cancelled = true; };
  }, [workspace.uuid, fetchSandboxes, revision, t]);

  const hasChanges = initialTier !== null && selectedTier !== initialTier;

  const handleSave = async () => {
    if (!sandboxUuid || !hasChanges || isLoading || isSaving) return;
    if (!isValidTierId(selectedTier)) {
      setError(t("sandboxSettings.invalidTierError"));
      return;
    }
    const tier = getComputeTier(selectedTier);
    setIsSaving(true);
    setError(null);
    try {
      const updated = await updateSandbox(sandboxUuid, { sandbox_cpu: vcpuToCores(tier.cpu), sandbox_memory: tier.memory_mb });
      if (!updated) {
        setError(useSandboxProjectsStore.getState().errorMessage || t("sandboxSettings.saveError"));
        return;
      }
      await fetchSandboxes(workspace.uuid);
      toaster.create({
        title: t("sandboxSettings.savedTitle"),
        description: t("sandboxSettings.savedDescription", {
          label: tier.label,
          cpu: tier.cpu,
          memory: tier.memory_gb,
          disk: tier.disk_gb,
          workspace: workspace.name,
        }),
        type: "success",
      });
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <DialogContent className="max-h-[calc(100dvh_-_2rem)] w-[calc(100vw_-_2rem)] max-w-[480px] grid-cols-[minmax(0,1fr)] gap-6 overflow-y-auto rounded-2xl p-6" hideClose={isSaving} onEscapeKeyDown={(event) => { if (isSaving) event.preventDefault(); }} onPointerDownOutside={(event) => { if (isSaving) event.preventDefault(); }}>
      <DialogHeader className="space-y-3 text-left">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><LuCpu className="h-5 w-5" /></span>
        <DialogTitle className="text-xl">{t("sandboxSettings.title")}</DialogTitle>
        <DialogDescription className="text-xs leading-relaxed">
          <Trans
            i18nKey="sandboxSettings.description"
            ns="workspace"
            values={{ name: workspace.name }}
            components={{ workspace: <span className="font-medium text-foreground" /> }}
          />
        </DialogDescription>
      </DialogHeader>

      {isLoading ? (
        <div role="status" aria-label={t("sandboxSettings.loadingAria")} className="space-y-5">
          <div className="space-y-2">
            <Skeleton className="h-4 w-32 rounded" />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="rounded-xl border border-border/60 p-3 space-y-2">
                  <Skeleton className="h-4 w-16 rounded" />
                  <Skeleton className="h-3 w-24 rounded" />
                </div>
              ))}
            </div>
          </div>
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      ) : (
        <form id="workspace-sandbox-settings-form" onSubmit={(event) => { event.preventDefault(); void handleSave(); }} className="space-y-5">
          {sandboxUuid && <>
            <fieldset disabled={isSaving} className="space-y-2">
              <legend className="mb-2 flex items-center gap-2 text-xs font-semibold">{t("sandboxSettings.computeTier")} <Badge variant="outline" className="rounded-full px-1.5 py-0 text-[10px] font-medium text-muted-foreground">{t("sandboxSettings.coupledCpuRam")}</Badge></legend>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {COMPUTE_TIERS.map((tier) => (
                  <label key={tier.id} className="relative cursor-pointer">
                    <input type="radio" name="workspace-sandbox-tier" value={tier.id} checked={selectedTier === tier.id} onChange={() => setSelectedTier(tier.id)} className="peer sr-only" />
                    <span className={cn("block rounded-xl border px-3 py-3 text-left text-xs transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:cursor-not-allowed peer-disabled:opacity-60", selectedTier === tier.id ? "border-primary bg-primary/10 text-primary" : "border-border/60 hover:bg-muted/40")}>
                      <span className="block font-semibold">{tier.label}</span>
                      <span className="mt-1 block text-[11px] text-muted-foreground">{t("sandboxSettings.tierSpecs", { memory: tier.memory_gb, disk: tier.disk_gb })}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <p className="rounded-xl border border-border/60 bg-muted/20 p-3.5 text-xs leading-relaxed text-muted-foreground">{t("sandboxSettings.notice")}</p>
          </>}
          {error && <div role="alert" className="space-y-2 text-xs text-destructive"><p>{error}</p>{!sandboxUuid && <Button type="button" variant="outline" size="sm" onClick={() => setRevision((value) => value + 1)}>{t("common.tryAgain")}</Button>}</div>}
        </form>
      )}

      <DialogFooter className="gap-2 border-t border-border/60 pt-4 sm:space-x-0">
        <Button variant="ghost" disabled={isSaving} onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" form="workspace-sandbox-settings-form" loading={isSaving} disabled={isLoading || isSaving || !sandboxUuid || !hasChanges}>{isSaving ? t("common.saving") : t("sandboxSettings.saveButton")}</Button>
      </DialogFooter>
    </DialogContent>
  );
}

