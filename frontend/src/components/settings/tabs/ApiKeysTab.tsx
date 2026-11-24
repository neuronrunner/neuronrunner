"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import useSettingsStore from "@/stores/settings";
import useAuthStore from "@/stores/auth";
import { LuCopy, LuKey, LuPlus, LuTrash2, LuCalendarClock, LuShieldAlert, LuPause, LuPlay } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export default function ApiKeysTab() {
  const { t, i18n } = useTranslation("settings");
  const { token } = useAuthStore();
  const {
    apiKeys,
    apiKeysLoading,
    apiKeyCreating,
    newlyCreatedKey,
    setNewlyCreatedKey,
    fetchApiKeys,
    createApiKey,
    deleteApiKey,
    toggleApiKeyStatus,
  } = useSettingsStore();

  const [newKeyName, setNewKeyName] = useState("");
  const hasLoaded = useRef(false);

  useEffect(() => {
    if (hasLoaded.current) return;
    if (token) {
      hasLoaded.current = true;
      fetchApiKeys(token);
    }
  }, [fetchApiKeys, token]);

  const handleCreate = () => {
    if (!newKeyName.trim()) {
      return;
    }
    if (!token) return;
    createApiKey(token, newKeyName.trim());
    setNewKeyName("");
  };

  const handleDelete = (keyId: string) => {
    if (!token) return;
    deleteApiKey(token, keyId);
  };

  const handleToggleStatus = (keyId: string, currentStatus: boolean) => {
    if (!token) return;
    toggleApiKeyStatus(token, keyId, !currentStatus);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="max-w-3xl w-full space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-base font-semibold text-foreground tracking-tight">{t("apiKeys.title")}</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          {t("apiKeys.subtitle")}
        </p>
      </div>

      {/* Create New Key card */}
      <div className="p-5 rounded-2xl border border-border dark:border-white/10 bg-card dark:bg-white/[0.02] space-y-3 shadow-sm dark:shadow-none">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("apiKeys.generateTitle")}
        </h3>
        <div className="flex flex-col sm:flex-row gap-3">
          <Input
            placeholder={t("apiKeys.namePlaceholder")}
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            className="flex-1 h-10 rounded-xl bg-muted/40 dark:bg-black/30 border-input dark:border-white/10 text-sm focus:border-ring focus:ring-1 focus:ring-ring"
          />
          <Button
            onClick={handleCreate}
            loading={apiKeyCreating}
            className="bg-foreground hover:bg-foreground/90 text-background rounded-xl px-5 h-10 text-xs font-medium gap-1.5 shadow-sm shrink-0"
          >
            <LuPlus className="h-4 w-4" />
            <span>{t("apiKeys.createButton")}</span>
          </Button>
        </div>
      </div>

      {/* Newly Created Secret Key Alert */}
      {newlyCreatedKey && (
        <div className="p-5 rounded-2xl border border-amber-500/30 bg-amber-500/10 dark:border-zinc-500/30 dark:bg-zinc-500/15 text-foreground animate-in fade-in duration-300 space-y-3">
          <div className="flex items-center gap-2 text-amber-600 dark:text-zinc-300">
            <LuShieldAlert className="h-5 w-5" />
            <h4 className="text-sm font-semibold">{t("apiKeys.secretAlert.title")}</h4>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t("apiKeys.secretAlert.description")}
          </p>

          <div className="flex items-center bg-card dark:bg-black/40 border border-border dark:border-white/10 rounded-xl overflow-hidden">
            <div className="flex-1 overflow-x-auto p-3 font-mono text-xs font-bold text-foreground">
              {newlyCreatedKey}
            </div>
            <div className="h-8 w-px bg-border dark:bg-white/10" />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => copyToClipboard(newlyCreatedKey)}
              className="mx-2 text-xs gap-1.5 text-foreground hover:bg-muted dark:text-zinc-300 dark:hover:text-zinc-200 dark:hover:bg-zinc-300/20 rounded-lg"
            >
              <LuCopy className="h-3.5 w-3.5" />
              <span>{t("apiKeys.secretAlert.copy")}</span>
            </Button>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setNewlyCreatedKey(null)}
            className="w-full rounded-xl text-xs border-border dark:border-white/10 hover:bg-muted dark:hover:bg-white/5 h-9"
          >
            {t("apiKeys.secretAlert.confirmSaved")}
          </Button>
        </div>
      )}

      {/* Active Keys List */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("apiKeys.activeKeysTitle")}
          </h3>
          {apiKeys.length > 0 && (
            <Badge className="bg-muted dark:bg-white/5 text-muted-foreground border border-border dark:border-white/10 text-[10px] px-2 py-0.5 rounded-full">
              {apiKeys.length === 1
                ? t("apiKeys.keyCountSingle", { count: apiKeys.length })
                : t("apiKeys.keyCountPlural", { count: apiKeys.length })}
            </Badge>
          )}
        </div>

        {apiKeysLoading ? (
          <div className="flex flex-col gap-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 rounded-xl w-full" />
            ))}
          </div>
        ) : apiKeys.length === 0 ? (
          <div className="py-10 bg-muted/10 dark:bg-white/[0.01] rounded-2xl border border-dashed border-border dark:border-white/10 flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <div className="p-3 bg-muted dark:bg-white/5 rounded-full border border-border dark:border-white/10">
              <LuKey className="h-5 w-5 text-muted-foreground dark:text-zinc-300" />
            </div>
            <p className="font-medium text-sm text-foreground">{t("apiKeys.emptyTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("apiKeys.emptyDescription")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {apiKeys.map((key) => (
              <div
                key={key.id}
                className="p-4 rounded-xl border border-border dark:border-white/10 bg-card dark:bg-white/[0.02] hover:bg-muted/40 dark:hover:bg-white/[0.04] transition-all flex items-center justify-between gap-3 flex-wrap shadow-sm dark:shadow-none"
              >
                <div className="flex flex-col gap-1.5 flex-1 min-w-[150px]">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-xs text-foreground">{key.name}</span>
                    <Badge
                      className={cn(
                        "text-[10px] px-2 py-0.5 rounded-md font-medium border",
                        key.is_active
                          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                          : "bg-muted dark:bg-white/5 text-muted-foreground border border-border dark:border-white/10"
                      )}
                    >
                      {key.is_active ? t("apiKeys.statusActive") : t("apiKeys.statusInactive")}
                    </Badge>
                  </div>
                  <code className="text-xs font-mono text-foreground dark:text-zinc-200 bg-muted dark:bg-black/30 border border-border dark:border-white/5 px-2 py-0.5 rounded-md w-fit">
                    {key.prefix}...
                  </code>
                </div>

                <div className="flex items-center gap-5 text-xs text-muted-foreground flex-wrap">
                  <div className="flex flex-col min-w-[70px]">
                    <span className="text-[10px] uppercase font-semibold text-muted-foreground/60 tracking-wider">{t("apiKeys.createdLabel")}</span>
                    <span className="text-xs text-foreground/80">{new Date(key.created_at).toLocaleDateString(i18n.resolvedLanguage || "en")}</span>
                  </div>

                  <div className="flex flex-col min-w-[90px]">
                    <span className="text-[10px] uppercase font-semibold text-muted-foreground/60 tracking-wider">{t("apiKeys.lastUsedLabel")}</span>
                    <div className="flex items-center gap-1 text-xs text-foreground/80">
                      <LuCalendarClock className="h-3 w-3 text-muted-foreground" />
                      <span>
                        {key.last_used_at
                          ? new Date(key.last_used_at).toLocaleDateString(i18n.resolvedLanguage || "en")
                          : t("apiKeys.neverUsed")}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleToggleStatus(key.id, key.is_active)}
                      className={cn(
                        "p-1.5 rounded-lg hover:bg-muted dark:hover:bg-white/10 transition-colors",
                        key.is_active ? "text-amber-500 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"
                      )}
                      title={key.is_active ? t("apiKeys.pauseAccess") : t("apiKeys.resumeAccess")}
                    >
                      {key.is_active ? <LuPause size={14} /> : <LuPlay size={14} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(key.id)}
                      className="p-1.5 rounded-lg hover:bg-muted dark:hover:bg-white/10 text-muted-foreground hover:text-destructive transition-colors"
                      title={t("apiKeys.deleteKey")}
                    >
                      <LuTrash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
