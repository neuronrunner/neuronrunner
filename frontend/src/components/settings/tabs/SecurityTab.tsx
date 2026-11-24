"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import useAuthStore from "@/stores/auth";
import useSettingsStore from "@/stores/settings";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { LuKey } from "react-icons/lu";

export default function SecurityTab() {
  const { t } = useTranslation("settings");
  const auth = useAuthStore();
  const [error, setError] = useState<string | null>(null);
  const {
    currentPassword,
    setCurrentPassword,
    newPassword,
    setNewPassword,
    confirmNewPassword,
    setConfirmNewPassword,
    passwordLoading,
    changePassword,
  } = useSettingsStore();

  const handleSubmit = () => {
    setError(null);
    if (!currentPassword || !newPassword) {
      setError(t("security.errors.fillAllFields"));
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setError(t("security.errors.mismatch"));
      return;
    }
    const token = auth.token || "";
    if (!token) return;
    changePassword(token);
  };

  return (
    <div className="max-w-2xl w-full space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-base font-semibold text-foreground tracking-tight">{t("security.title")}</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          {t("security.subtitle")}
        </p>
      </div>

      {/* Password Change Card */}
      <div className="p-5 rounded-2xl border border-border dark:border-white/10 bg-card dark:bg-white/[0.02] space-y-4 shadow-sm dark:shadow-none">
        <div className="flex items-center gap-2 pb-1 border-b border-border dark:border-white/5">
          <LuKey className="text-muted-foreground dark:text-zinc-300 h-4 w-4" />
          <h3 className="text-sm font-medium text-foreground">{t("security.changePasswordTitle")}</h3>
        </div>

        {/* Current Password */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("security.currentPassword")}
          </label>
          <Input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="••••••••••••"
            autoComplete="current-password"
            className="h-10 rounded-xl bg-muted/40 dark:bg-black/30 border-input dark:border-white/10 text-sm focus:border-ring focus:ring-1 focus:ring-ring"
          />
        </div>

        {/* New Password */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("security.newPassword")}
          </label>
          <Input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="••••••••••••"
            autoComplete="new-password"
            className="h-10 rounded-xl bg-muted/40 dark:bg-black/30 border-input dark:border-white/10 text-sm focus:border-ring focus:ring-1 focus:ring-ring"
          />
          <p className="text-[11px] text-muted-foreground/80">{t("security.passwordHint")}</p>
        </div>

        {/* Confirm Password */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("security.confirmPassword")}
          </label>
          <Input
            type="password"
            value={confirmNewPassword}
            onChange={(e) => setConfirmNewPassword(e.target.value)}
            placeholder="••••••••••••"
            autoComplete="new-password"
            className="h-10 rounded-xl bg-muted/40 dark:bg-black/30 border-input dark:border-white/10 text-sm focus:border-ring focus:ring-1 focus:ring-ring"
          />
        </div>

        <div className="pt-2 flex items-center justify-between">
          {error ? <p className="text-xs text-destructive">{error}</p> : <span />}
          <Button
            onClick={handleSubmit}
            loading={passwordLoading}
            className="bg-foreground hover:bg-foreground/90 text-background rounded-xl text-xs font-medium h-9 px-5 shadow-sm transition-all"
          >
            {t("security.updatePassword")}
          </Button>
        </div>
      </div>
    </div>
  );
}