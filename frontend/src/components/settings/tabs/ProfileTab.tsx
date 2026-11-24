"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import useAuthStore from "@/stores/auth";
import useSettingsStore from "@/stores/settings";
import ProfilePicture from "@/components/profile-picture";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toaster } from "@/components/ui/toaster";
import { LuCheck } from "react-icons/lu";

export default function ProfileTab() {
  const { t } = useTranslation(["settings", "common"]);
  const auth = useAuthStore();
  const hasHydrated = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedSuccess, setSavedSuccess] = useState(false);

  const {
    firstName,
    setFirstName,
    lastName,
    setLastName,
    profilePhoto,
    setProfilePhoto,
    username,
    setUsername,
    hydrating,
    setHydrating,
    hydrateProfile,
    bio,
    setBio,
    saveProfile,
  } = useSettingsStore();

  useEffect(() => {
    if (hasHydrated.current) return;
    if (auth.token) {
      hasHydrated.current = true;
      hydrateProfile(auth.token);
    } else {
      setHydrating(false);
    }
  }, [auth.token, hydrateProfile, setHydrating]);

  const imageSrc = useMemo(() => {
    if (typeof profilePhoto === "string") return profilePhoto;
    if (profilePhoto instanceof File) {
      try {
        return URL.createObjectURL(profilePhoto);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }, [profilePhoto]);

  const handleSave = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    setError(null);
    setSavedSuccess(false);

    const token = auth.token || "";
    if (!token) {
      setError(t("profile.errors.notSignedIn"));
      return;
    }

    const cleanUsername = username.trim();
    if (!cleanUsername) {
      setError(t("profile.errors.emptyUsername"));
      return;
    }

    setSaving(true);
    try {
      await saveProfile(token, cleanUsername, auth.setUser);
      setSavedSuccess(true);
      toaster.create({
        title: t("profile.toast.updatedTitle"),
        description: t("profile.toast.updatedDescription"),
        type: "success",
      });
      setTimeout(() => {
        setSavedSuccess(false);
      }, 3000);
    } catch (err: any) {
      let errorMsg = t("profile.errors.updateFailed");
      if (err?.response?.data) {
        const data = err.response.data;
        if (typeof data === "string") {
          errorMsg = data;
        } else if (data.error && typeof data.error === "string") {
          errorMsg = data.error;
        } else if (data.detail && typeof data.detail === "string") {
          errorMsg = data.detail;
        } else {
          const firstKey = Object.keys(data)[0];
          if (firstKey) {
            const val = data[firstKey];
            if (Array.isArray(val) && val.length > 0) {
              errorMsg = `${firstKey}: ${val[0]}`;
            } else if (typeof val === "string") {
              errorMsg = `${firstKey}: ${val}`;
            }
          }
        }
      }
      setError(errorMsg);
      toaster.create({
        title: t("profile.toast.errorTitle"),
        description: errorMsg,
        type: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  if (hydrating) {
    return (
      <div className="max-w-2xl w-full space-y-3" role="status" aria-label={t("profile.loadingAriaLabel")}>
        <div>
          <Skeleton className="h-5 w-32 rounded-md" />
          <Skeleton className="h-3.5 w-64 rounded-md mt-1" />
        </div>

        <div className="p-4 sm:p-4.5 rounded-2xl border border-border dark:border-white/10 bg-card dark:bg-white/[0.02] space-y-3">
          <div className="flex items-center gap-4.5 pb-4 border-b border-border dark:border-white/5">
            <Skeleton className="h-[80px] w-[80px] rounded-full shrink-0" />
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-28 rounded" />
              <Skeleton className="h-3 w-56 rounded" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Skeleton className="h-3 w-20 rounded" />
            <Skeleton className="h-9 w-full rounded-xl" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Skeleton className="h-3 w-20 rounded" />
              <Skeleton className="h-9 w-full rounded-xl" />
            </div>
            <div className="space-y-1.5">
              <Skeleton className="h-3 w-20 rounded" />
              <Skeleton className="h-9 w-full rounded-xl" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Skeleton className="h-3 w-20 rounded" />
            <Skeleton className="h-16 w-full rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl w-full">
      <form onSubmit={handleSave} className="space-y-3">
        {/* Header text */}
        <div>
          <h2 className="text-base font-semibold text-foreground tracking-tight">{t("profile.title")}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("profile.subtitle")}
          </p>
        </div>

        {/* Unified Profile Card */}
        <div className="p-4 sm:p-4.5 rounded-2xl border border-border dark:border-white/10 bg-card dark:bg-white/[0.02] space-y-3 shadow-sm dark:shadow-none">
          {/* Avatar Row */}
          <div className="flex items-center gap-4.5 pb-4 border-b border-border dark:border-white/5">
            <ProfilePicture
              size="80px"
              image={imageSrc}
              onUpload={(file) => {
                setProfilePhoto(file);
                setError(null);
                setSavedSuccess(false);
              }}
              onRemove={() => {
                setProfilePhoto(null);
                setError(null);
                setSavedSuccess(false);
              }}
            />
            <div className="min-w-0 space-y-1">
              <h3 className="text-sm font-medium text-foreground">{t("profile.avatar.title")}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("profile.avatar.hint")}
              </p>
            </div>
          </div>

          {/* Username */}
          <div className="space-y-1">
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t("profile.fields.username.label")}
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-3 flex items-center text-xs text-muted-foreground pointer-events-none select-none">
                @
              </span>
              <Input
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  setError(null);
                  setSavedSuccess(false);
                }}
                name="username"
                autoComplete="username"
                disabled={hydrating}
                className="pl-7 h-9 rounded-xl bg-muted/40 dark:bg-black/30 border-input dark:border-white/10 text-xs sm:text-sm focus:border-ring focus:ring-1 focus:ring-ring"
                placeholder={t("profile.fields.username.placeholder")}
              />
            </div>
          </div>

          {/* First & Last Name row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t("profile.fields.firstName.label")}
              </label>
              <Input
                value={firstName}
                onChange={(e) => {
                  setFirstName(e.target.value);
                  setError(null);
                  setSavedSuccess(false);
                }}
                name="firstName"
                autoComplete="given-name"
                disabled={hydrating}
                className="h-9 rounded-xl bg-muted/40 dark:bg-black/30 border-input dark:border-white/10 text-xs sm:text-sm focus:border-ring focus:ring-1 focus:ring-ring"
                placeholder={t("profile.fields.firstName.placeholder")}
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t("profile.fields.lastName.label")}
              </label>
              <Input
                value={lastName}
                onChange={(e) => {
                  setLastName(e.target.value);
                  setError(null);
                  setSavedSuccess(false);
                }}
                name="lastName"
                autoComplete="family-name"
                disabled={hydrating}
                className="h-9 rounded-xl bg-muted/40 dark:bg-black/30 border-input dark:border-white/10 text-xs sm:text-sm focus:border-ring focus:ring-1 focus:ring-ring"
                placeholder={t("profile.fields.lastName.placeholder")}
              />
            </div>
          </div>

          {/* Biography */}
          <div className="space-y-1">
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t("profile.fields.bio.label")}
            </label>
            <textarea
              value={bio}
              onChange={(e) => {
                setBio(e.target.value);
                setError(null);
                setSavedSuccess(false);
              }}
              name="biography"
              disabled={hydrating}
              rows={2}
              className="w-full min-h-[52px] max-h-[80px] rounded-xl bg-muted/40 dark:bg-black/30 border border-input dark:border-white/10 px-3 py-1.5 text-xs sm:text-sm text-foreground focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring disabled:opacity-50 resize-y placeholder:text-muted-foreground"
              placeholder={t("profile.fields.bio.placeholder")}
            />
          </div>

          {/* Action Footer */}
          <div className="pt-2 flex items-center justify-between border-t border-border dark:border-white/5 gap-3">
            <div className="min-w-0 text-xs">
              {error && <p className="text-destructive font-medium truncate">{error}</p>}
              {savedSuccess && !error && (
                <p className="text-emerald-600 dark:text-emerald-400 font-medium inline-flex items-center gap-1.5">
                  <LuCheck className="h-3.5 w-3.5 shrink-0" />
                  <span>{t("common:common.saved")}</span>
                </p>
              )}
            </div>
            <Button
              type="submit"
              disabled={hydrating || saving}
              loading={saving}
              className="bg-foreground hover:bg-foreground/90 text-background rounded-xl text-xs font-medium h-8.5 px-5 shadow-sm transition-all shrink-0"
            >
              {t("common:common.save")}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
