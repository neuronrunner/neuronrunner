"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuCircleAlert,
  LuCircleCheck,
  LuEye,
  LuEyeOff,
  LuFileCode,
  LuKeyRound,
  LuPencil,
  LuPlus,
  LuSearch,
  LuServer,
  LuShieldCheck,
  LuTrash2,
  LuX,
} from "react-icons/lu";
import { authedAxios, API_BASE } from "@/lib/axios";
import useWorkspacesStore from "@/stores/workspaces";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toaster } from "@/components/ui/toaster";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface VMSecretItem {
  uuid: string;
  key: string;
  masked_value: string;
  description: string;
  scope: "workspace" | "vm";
  vm_uuid: string | null;
  vm_name: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface VMOption {
  uuid: string;
  name: string;
  status: string;
}

const WORKSPACE_SCOPE_VALUE = "__workspace__";
const FILTER_ALL_VALUE = "__all__";

function extractApiError(err: any, fallback: string): string {
  const data = err?.response?.data;
  if (!data) return fallback;
  if (typeof data.error === "string") return data.error;
  if (typeof data.detail === "string") return data.detail;
  for (const field of ["key", "value", "vm_uuid", "content", "non_field_errors"]) {
    const val = data[field];
    if (Array.isArray(val) && val[0]) return String(val[0]);
    if (typeof val === "string") return val;
  }
  return fallback;
}

export default function VMSecretsTab() {
  const { t, i18n } = useTranslation("settings");
  const workspace = useWorkspacesStore((s) => s.currentWorkspace);
  const workspaceUuid = workspace?.uuid;

  const [secrets, setSecrets] = useState<VMSecretItem[]>([]);
  const [vms, setVms] = useState<VMOption[]>([]);
  const [canManageFromApi, setCanManageFromApi] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<string>(FILTER_ALL_VALUE);

  // Add / Edit form state
  const [mode, setMode] = useState<"none" | "add" | "edit" | "import">("none");
  const [editingSecret, setEditingSecret] = useState<VMSecretItem | null>(null);
  const [formKey, setFormKey] = useState("");
  const [formValue, setFormValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [formDescription, setFormDescription] = useState("");
  const [formScope, setFormScope] = useState<string>(WORKSPACE_SCOPE_VALUE);

  // Bulk .env import state
  const [dotenvContent, setDotenvContent] = useState("");
  const [importScope, setImportScope] = useState<string>(WORKSPACE_SCOPE_VALUE);

  // Delete confirmation state
  const [confirmDeleteUuid, setConfirmDeleteUuid] = useState<string | null>(null);

  const canManage =
    canManageFromApi ??
    (workspace?.user_role === "owner" || workspace?.user_role === "admin");

  const secretsEndpoint = workspaceUuid
    ? `${API_BASE}/sandbox/workspaces/${workspaceUuid}/vm-secrets/`
    : "";

  const loadData = useCallback(() => {
    if (!workspaceUuid) return;
    setLoading(true);
    setError("");
    Promise.allSettled([
      authedAxios.get(secretsEndpoint).then(({ data }) => {
        setSecrets(Array.isArray(data?.secrets) ? data.secrets : []);
        if (typeof data?.can_manage === "boolean") {
          setCanManageFromApi(data.can_manage);
        }
      }),
      authedAxios
        .get(`${API_BASE}/sandbox/vms/`, {
          headers: { "X-Workspace-ID": workspaceUuid },
        })
        .then(({ data }) => {
          const list = Array.isArray(data?.vms) ? data.vms : [];
          setVms(
            list.map((v: any) => ({
              uuid: v.uuid,
              name: v.name,
              status: v.status,
            })),
          );
        }),
    ])
      .then(([secretsRes]) => {
        if (secretsRes.status === "rejected") {
          setError(t("vmSecrets.errors.loadFailed"));
        }
      })
      .finally(() => {
        setLoading(false);
      });
  }, [workspaceUuid, secretsEndpoint, t]);

  useEffect(() => {
    setMode("none");
    setEditingSecret(null);
    setConfirmDeleteUuid(null);
    setSearchQuery("");
    setScopeFilter(FILTER_ALL_VALUE);
    loadData();
  }, [loadData]);

  const filteredSecrets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return secrets.filter((item) => {
      if (scopeFilter === WORKSPACE_SCOPE_VALUE && item.scope !== "workspace") {
        return false;
      }
      if (
        scopeFilter !== FILTER_ALL_VALUE &&
        scopeFilter !== WORKSPACE_SCOPE_VALUE &&
        item.vm_uuid !== scopeFilter
      ) {
        return false;
      }
      if (!q) return true;
      return (
        item.key.toLowerCase().includes(q) ||
        (item.description || "").toLowerCase().includes(q) ||
        (item.vm_name || "").toLowerCase().includes(q)
      );
    });
  }, [secrets, searchQuery, scopeFilter]);

  const resetForm = () => {
    setMode("none");
    setEditingSecret(null);
    setFormKey("");
    setFormValue("");
    setShowValue(false);
    setFormDescription("");
    setFormScope(WORKSPACE_SCOPE_VALUE);
    setDotenvContent("");
    setImportScope(WORKSPACE_SCOPE_VALUE);
    setError("");
  };

  const openAddForm = () => {
    resetForm();
    setMode("add");
  };

  const openEditForm = (item: VMSecretItem) => {
    setError("");
    setEditingSecret(item);
    setFormKey(item.key);
    setFormValue("");
    setShowValue(false);
    setFormDescription(item.description || "");
    setFormScope(item.vm_uuid || WORKSPACE_SCOPE_VALUE);
    setMode("edit");
  };

  const openImportForm = () => {
    resetForm();
    setMode("import");
  };

  const handleSaveSecret = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspaceUuid || !canManage || busy) return;

    const trimmedKey = formKey.trim();
    if (!trimmedKey) {
      setError(t("vmSecrets.errors.keyRequired"));
      return;
    }
    if (mode === "add" && !formValue) {
      setError(t("vmSecrets.errors.valueRequired"));
      return;
    }

    setBusy(true);
    setError("");
    try {
      const vm_uuid = formScope === WORKSPACE_SCOPE_VALUE ? null : formScope;
      if (mode === "add") {
        const { data } = await authedAxios.post(secretsEndpoint, {
          key: trimmedKey,
          value: formValue,
          description: formDescription.trim(),
          vm_uuid,
        });
        toaster.create({
          title: t("vmSecrets.toast.createdTitle"),
          description:
            data?.synced_vms > 0
              ? t("vmSecrets.toast.syncedDescription", {
                  key: data.key,
                  count: data.synced_vms,
                })
              : t("vmSecrets.toast.savedDescription", { key: data.key }),
          type: "success",
        });
      } else if (mode === "edit" && editingSecret) {
        const payload: Record<string, any> = {
          key: trimmedKey,
          description: formDescription.trim(),
          vm_uuid,
        };
        if (formValue !== "") {
          payload.value = formValue;
        }
        const { data } = await authedAxios.patch(
          `${secretsEndpoint}${editingSecret.uuid}/`,
          payload,
        );
        toaster.create({
          title: t("vmSecrets.toast.updatedTitle"),
          description:
            data?.synced_vms > 0
              ? t("vmSecrets.toast.syncedDescription", {
                  key: data.key,
                  count: data.synced_vms,
                })
              : t("vmSecrets.toast.savedDescription", { key: data.key }),
          type: "success",
        });
      }
      resetForm();
      loadData();
    } catch (err: any) {
      setError(extractApiError(err, t("vmSecrets.errors.saveFailed")));
    } finally {
      setBusy(false);
    }
  };

  const handleBulkImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspaceUuid || !canManage || busy || !dotenvContent.trim()) return;
    setBusy(true);
    setError("");
    try {
      const vm_uuid = importScope === WORKSPACE_SCOPE_VALUE ? null : importScope;
      const { data } = await authedAxios.post(`${secretsEndpoint}bulk-import/`, {
        content: dotenvContent,
        vm_uuid,
      });
      toaster.create({
        title: t("vmSecrets.toast.importedTitle"),
        description: t("vmSecrets.toast.importedDescription", {
          count: data?.imported || 0,
        }),
        type: "success",
      });
      resetForm();
      loadData();
    } catch (err: any) {
      setError(extractApiError(err, t("vmSecrets.errors.importFailed")));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (item: VMSecretItem) => {
    if (!workspaceUuid || !canManage || busy) return;
    setBusy(true);
    setError("");
    try {
      await authedAxios.delete(`${secretsEndpoint}${item.uuid}/`);
      setSecrets((prev) => prev.filter((s) => s.uuid !== item.uuid));
      setConfirmDeleteUuid(null);
      toaster.create({
        title: t("vmSecrets.toast.deletedTitle"),
        description: t("vmSecrets.toast.deletedDescription", { key: item.key }),
        type: "info",
      });
    } catch (err: any) {
      setError(extractApiError(err, t("vmSecrets.errors.deleteFailed")));
    } finally {
      setBusy(false);
    }
  };

  if (!workspace) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("vmSecrets.selectWorkspace")}
      </p>
    );
  }

  return (
    <div className="max-w-3xl w-full space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground tracking-tight">
            {t("vmSecrets.title")}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("vmSecrets.subtitle", { workspace: workspace.name })}
          </p>
        </div>

        {canManage && mode === "none" && (
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={openImportForm}
              className="h-8 rounded-xl text-xs gap-1.5"
            >
              <LuFileCode className="h-3.5 w-3.5" />
              <span>{t("vmSecrets.actions.importEnv")}</span>
            </Button>
            <Button
              size="sm"
              onClick={openAddForm}
              className="h-8 rounded-xl bg-foreground hover:bg-foreground/90 text-background text-xs font-medium gap-1.5"
            >
              <LuPlus className="h-3.5 w-3.5" />
              <span>{t("vmSecrets.actions.addSecret")}</span>
            </Button>
          </div>
        )}
      </div>

      {/* Read-only notice for non-admin members */}
      {!canManage && (
        <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
          <LuShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>{t("vmSecrets.readOnlyNotice")}</span>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-xl border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive"
        >
          <LuCircleAlert className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Add / Edit Secret Form */}
      {(mode === "add" || mode === "edit") && (
        <form
          onSubmit={handleSaveSecret}
          className="space-y-4 rounded-2xl border border-border dark:border-white/10 bg-muted/20 dark:bg-white/[0.02] p-4"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
              {mode === "add"
                ? t("vmSecrets.form.addTitle")
                : t("vmSecrets.form.editTitle", { key: editingSecret?.key })}
            </h3>
            <button
              type="button"
              onClick={resetForm}
              aria-label={t("vmSecrets.actions.cancel")}
              className="rounded-lg p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <LuX className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label
                htmlFor="vm-secret-key"
                className="block text-xs font-medium text-foreground"
              >
                {t("vmSecrets.form.keyLabel")}
              </label>
              <Input
                id="vm-secret-key"
                value={formKey}
                onChange={(e) => setFormKey(e.target.value.replace(/\s+/g, "_"))}
                placeholder="DATABASE_URL"
                spellCheck={false}
                autoComplete="off"
                disabled={busy}
                required
                className="h-9 rounded-xl font-mono text-xs bg-background"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="vm-secret-scope"
                className="block text-xs font-medium text-foreground"
              >
                {t("vmSecrets.form.scopeLabel")}
              </label>
              <Select
                value={formScope}
                onValueChange={setFormScope}
                disabled={busy}
              >
                <SelectTrigger
                  id="vm-secret-scope"
                  className="h-9 w-full rounded-xl bg-background text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[1300]">
                  <SelectItem value={WORKSPACE_SCOPE_VALUE} className="text-xs">
                    {t("vmSecrets.scope.allVms")}
                  </SelectItem>
                  {vms.map((vm) => (
                    <SelectItem key={vm.uuid} value={vm.uuid} className="text-xs">
                      {vm.name} ({vm.status})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="vm-secret-value"
              className="block text-xs font-medium text-foreground"
            >
              {t("vmSecrets.form.valueLabel")}
            </label>
            <div className="relative">
              <Input
                id="vm-secret-value"
                type={showValue ? "text" : "password"}
                value={formValue}
                onChange={(e) => setFormValue(e.target.value)}
                placeholder={
                  mode === "edit"
                    ? t("vmSecrets.form.valuePlaceholderEdit")
                    : t("vmSecrets.form.valuePlaceholderAdd")
                }
                autoComplete="new-password"
                spellCheck={false}
                disabled={busy}
                required={mode === "add"}
                className="h-9 pr-9 rounded-xl font-mono text-xs bg-background"
              />
              <button
                type="button"
                onClick={() => setShowValue((v) => !v)}
                aria-label={
                  showValue
                    ? t("vmSecrets.form.hideValue")
                    : t("vmSecrets.form.showValue")
                }
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showValue ? (
                  <LuEyeOff className="h-3.5 w-3.5" />
                ) : (
                  <LuEye className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="vm-secret-description"
              className="block text-xs font-medium text-foreground"
            >
              {t("vmSecrets.form.descriptionLabel")}
            </label>
            <Input
              id="vm-secret-description"
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              placeholder={t("vmSecrets.form.descriptionPlaceholder")}
              maxLength={255}
              disabled={busy}
              className="h-9 rounded-xl text-xs bg-background"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={resetForm}
              className="h-8 rounded-xl text-xs"
            >
              {t("vmSecrets.actions.cancel")}
            </Button>
            <Button
              type="submit"
              size="sm"
              loading={busy}
              disabled={busy || !formKey.trim() || (mode === "add" && !formValue)}
              className="h-8 rounded-xl bg-foreground hover:bg-foreground/90 text-background text-xs font-medium"
            >
              {busy ? t("vmSecrets.actions.saving") : t("vmSecrets.actions.save")}
            </Button>
          </div>
        </form>
      )}

      {/* Bulk .env Import Form */}
      {mode === "import" && (
        <form
          onSubmit={handleBulkImport}
          className="space-y-4 rounded-2xl border border-border dark:border-white/10 bg-muted/20 dark:bg-white/[0.02] p-4"
        >
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
                {t("vmSecrets.importForm.title")}
              </h3>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {t("vmSecrets.importForm.subtitle")}
              </p>
            </div>
            <button
              type="button"
              onClick={resetForm}
              aria-label={t("vmSecrets.actions.cancel")}
              className="rounded-lg p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <LuX className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="vm-secret-import-scope"
              className="block text-xs font-medium text-foreground"
            >
              {t("vmSecrets.form.scopeLabel")}
            </label>
            <Select
              value={importScope}
              onValueChange={setImportScope}
              disabled={busy}
            >
              <SelectTrigger
                id="vm-secret-import-scope"
                className="h-9 w-full rounded-xl bg-background text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[1300]">
                <SelectItem value={WORKSPACE_SCOPE_VALUE} className="text-xs">
                  {t("vmSecrets.scope.allVms")}
                </SelectItem>
                {vms.map((vm) => (
                  <SelectItem key={vm.uuid} value={vm.uuid} className="text-xs">
                    {vm.name} ({vm.status})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Textarea
            value={dotenvContent}
            onChange={(e) => setDotenvContent(e.target.value)}
            placeholder={"API_KEY=sk_...\nDATABASE_URL=postgres://..."}
            rows={6}
            spellCheck={false}
            disabled={busy}
            className="rounded-xl font-mono text-xs bg-background"
          />

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={resetForm}
              className="h-8 rounded-xl text-xs"
            >
              {t("vmSecrets.actions.cancel")}
            </Button>
            <Button
              type="submit"
              size="sm"
              loading={busy}
              disabled={busy || !dotenvContent.trim()}
              className="h-8 rounded-xl bg-foreground hover:bg-foreground/90 text-background text-xs font-medium"
            >
              {busy
                ? t("vmSecrets.importForm.importing")
                : t("vmSecrets.importForm.submit")}
            </Button>
          </div>
        </form>
      )}

      {/* Search & Scope Filter */}
      {secrets.length > 0 && (
        <div className="flex flex-col sm:flex-row gap-2.5">
          <div className="relative flex-1">
            <LuSearch className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("vmSecrets.searchPlaceholder")}
              className="h-9 pl-8 rounded-xl text-xs bg-muted/30 dark:bg-black/20"
            />
          </div>
          <Select value={scopeFilter} onValueChange={setScopeFilter}>
            <SelectTrigger className="h-9 w-full sm:w-48 rounded-xl text-xs bg-muted/30 dark:bg-black/20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[1300]">
              <SelectItem value={FILTER_ALL_VALUE} className="text-xs">
                {t("vmSecrets.filter.all")}
              </SelectItem>
              <SelectItem value={WORKSPACE_SCOPE_VALUE} className="text-xs">
                {t("vmSecrets.scope.allVms")}
              </SelectItem>
              {vms.map((vm) => (
                <SelectItem key={vm.uuid} value={vm.uuid} className="text-xs">
                  {vm.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Secrets List */}
      <div className="space-y-2.5">
        {loading ? (
          <div className="space-y-2" role="status" aria-label={t("vmSecrets.loadingAriaLabel")}>
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        ) : secrets.length === 0 ? (
          <div className="py-10 rounded-2xl border border-dashed border-border dark:border-white/10 bg-muted/10 dark:bg-white/[0.01] flex flex-col items-center justify-center gap-2.5 text-center px-4">
            <div className="p-3 rounded-full bg-muted dark:bg-white/5 border border-border dark:border-white/10">
              <LuKeyRound className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">
                {t("vmSecrets.empty.title")}
              </p>
              <p className="text-xs text-muted-foreground max-w-sm">
                {t("vmSecrets.empty.description")}
              </p>
            </div>
            {canManage && mode === "none" && (
              <Button
                size="sm"
                variant="outline"
                onClick={openAddForm}
                className="mt-1 h-8 rounded-xl text-xs gap-1.5"
              >
                <LuPlus className="h-3.5 w-3.5" />
                <span>{t("vmSecrets.actions.addSecret")}</span>
              </Button>
            )}
          </div>
        ) : filteredSecrets.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {t("vmSecrets.empty.filtered")}
          </p>
        ) : (
          filteredSecrets.map((item) => {
            const isConfirmingDelete = confirmDeleteUuid === item.uuid;
            return (
              <div
                key={item.uuid}
                className={cn(
                  "flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border p-3.5 transition-colors",
                  "border-border dark:border-white/10 bg-card dark:bg-white/[0.02]",
                )}
              >
                <div className="space-y-1 min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <code className="rounded-md bg-muted dark:bg-black/40 border border-border dark:border-white/10 px-2 py-0.5 font-mono text-xs font-semibold text-foreground">
                      {item.key}
                    </code>
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px] px-2 py-0.5 rounded-full gap-1 font-medium",
                        item.scope === "vm"
                          ? "border-indigo-500/30 bg-indigo-500/10 text-indigo-400"
                          : "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
                      )}
                    >
                      <LuServer className="h-2.5 w-2.5" />
                      <span>
                        {item.scope === "vm"
                          ? item.vm_name || t("vmSecrets.scope.specificVm")
                          : t("vmSecrets.scope.allVms")}
                      </span>
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                    <span className="font-mono">{item.masked_value}</span>
                    {item.description && (
                      <>
                        <span>•</span>
                        <span className="truncate">{item.description}</span>
                      </>
                    )}
                    <span>•</span>
                    <span className="text-[11px]">
                      {t("vmSecrets.updatedAt", {
                        date: new Date(item.updated_at).toLocaleDateString(
                          i18n.resolvedLanguage || "en",
                        ),
                      })}
                    </span>
                  </div>
                </div>

                {canManage && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    {isConfirmingDelete ? (
                      <>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={busy}
                          onClick={() => void handleDelete(item)}
                          className="h-7 rounded-lg text-xs"
                        >
                          {t("vmSecrets.actions.confirmDelete")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setConfirmDeleteUuid(null)}
                          className="h-7 rounded-lg text-xs"
                        >
                          {t("vmSecrets.actions.cancel")}
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => openEditForm(item)}
                          className="h-7 rounded-lg text-xs gap-1"
                        >
                          <LuPencil className="h-3 w-3" />
                          <span>{t("vmSecrets.actions.edit")}</span>
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => setConfirmDeleteUuid(item.uuid)}
                          className="h-7 rounded-lg text-xs text-destructive hover:bg-destructive/10 gap-1"
                        >
                          <LuTrash2 className="h-3 w-3" />
                          <span>{t("vmSecrets.actions.delete")}</span>
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Security & Injection Info Note */}
      <div className="flex items-start gap-2.5 rounded-xl border border-border/60 bg-muted/15 p-3.5 text-[11px] leading-relaxed text-muted-foreground">
        <LuCircleCheck className="h-4 w-4 shrink-0 text-emerald-500 mt-0.5" />
        <p>{t("vmSecrets.footerNote")}</p>
      </div>
    </div>
  );
}
