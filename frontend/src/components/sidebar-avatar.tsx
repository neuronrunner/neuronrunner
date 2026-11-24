"use client";

import React from "react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { IoMoon, IoSunny, IoDesktop, IoSettings, IoLogOut, IoGlobeOutline } from "react-icons/io5";
import { LuChevronsUpDown, LuLoaderCircle, LuCheck } from "react-icons/lu";
import { useTheme } from 'next-themes';
import { useRouter } from '@/lib/navigation';
import useAuthStore from "@/stores/auth";
import useSettingsStore from "@/stores/settings";
import type { IUser } from "@/types/user";
import useSidebarStore from "@/stores/sidebar";
import useNavbarStore from "@/stores/navbar";
import ProgressiveAvatar from "@/components/progressive-avatar";
import { useWorkspaceSwitcher, WorkspaceMenuItems } from "@/components/workspace/workspace-switcher";
import { WorkspaceAvatar } from "@/components/workspace/workspace-identity";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } from "@/i18n/languages";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

interface SidebarAvatarProps {
  user: IUser;
  expanded?: boolean;
  onToggle?: () => void;
}

const SidebarAvatar = ({ user }: SidebarAvatarProps) => {
  const { t, i18n } = useTranslation(["auth", "common"]);
  const [open, setOpen] = React.useState(false);
  const [languageDialogOpen, setLanguageDialogOpen] = React.useState(false);
  const currentLang = i18n.resolvedLanguage || DEFAULT_LANGUAGE;
  const currentLanguage = SUPPORTED_LANGUAGES.find((language) => language.code === currentLang);
  const { theme, setTheme } = useTheme();
  const auth = useAuthStore();
  const router = useRouter();
  const navbar = useNavbarStore();
  const { setSettingsDialogOpen } = useSettingsStore();
  const { workspaces, currentWorkspace, isSwitching, switchWorkspace, isLoading: isWorkspacesLoading, hasLoaded } = useWorkspaceSwitcher();

  const isWorkspaceLoading = isSwitching || (Boolean(auth.token) && (!currentWorkspace || isWorkspacesLoading || !hasLoaded));

  const displayName = user.first_name && user.last_name 
    ? `${user.first_name} ${user.last_name}`
    : user.first_name || user.username;

  const openSettings = () => {
    setSettingsDialogOpen(true);
  };

  return (
    <div className="w-full shrink-0 border-t border-border/60 p-3">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("sidebarAvatar.menuAriaLabel")}
            disabled={isSwitching}
            className="flex w-full cursor-pointer items-center justify-between rounded-lg border border-border/60 bg-background p-2 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
          >
            <div className="flex items-center gap-2.5 flex-1 min-w-0">
              <div className="relative shrink-0">
                <ProgressiveAvatar
                  name={displayName}
                  src={user.profile_picture}
                  blurDataUrl={user.profile_picture_blur_data_url}
                />
                <span className="absolute -bottom-1 -right-1 rounded bg-background ring-2 ring-background">
                  {isWorkspaceLoading && !currentWorkspace ? (
                    <Skeleton className="h-4 w-4 rounded" />
                  ) : (
                    <WorkspaceAvatar
                      name={currentWorkspace?.name || t("sidebarAvatar.workspaceFallback")}
                      image={currentWorkspace?.profile_picture}
                      blurDataUrl={currentWorkspace?.profile_picture_blur_data_url}
                      className="h-4 w-4 rounded text-[8px]"
                    />
                  )}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm text-foreground truncate">
                  {displayName}
                </div>
                {isWorkspaceLoading ? (
                  <div className="mt-1 flex items-center gap-1.5" aria-label={t("sidebarAvatar.loadingAriaLabel")}>
                    <Skeleton className="h-3 w-20 rounded" />
                  </div>
                ) : (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {currentWorkspace?.name || t("sidebarAvatar.selectWorkspace")}
                  </div>
                )}
              </div>
            </div>
            {isWorkspaceLoading ? (
              <LuLoaderCircle className="h-4 w-4 animate-spin text-muted-foreground ml-2 shrink-0" />
            ) : (
              <LuChevronsUpDown className="h-4 w-4 text-muted-foreground ml-2 shrink-0" />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent 
          align="start"
          side="top"
          sideOffset={8}
          className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[260px] max-w-[calc(100vw-1rem)] p-2 bg-popover border border-border shadow-2xl rounded-xl mb-2 z-[1100]"
        >
          {/* User Profile Header */}
          <div className="flex items-center gap-3 px-3 py-2.5 border-b border-border/50 mb-1.5">
            <ProgressiveAvatar
              name={displayName}
              src={user.profile_picture}
              blurDataUrl={user.profile_picture_blur_data_url}
            />
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-sm text-foreground truncate">
                {displayName}
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {user.email || user.username}
              </div>
            </div>
          </div>

          {/* Workspaces */}
          <WorkspaceMenuItems
            workspaces={workspaces}
            currentWorkspace={currentWorkspace}
            switchWorkspace={switchWorkspace}
            isLoading={isWorkspaceLoading}
          />

          {/* Menu items */}
          <DropdownMenuSeparator />
          <DropdownMenuItem 
            onClick={() => {
              const sidebarStore = useSidebarStore.getState();
              if (window.innerWidth < 768 && sidebarStore.isOpen) {
                sidebarStore.toggle();
              }
              openSettings();
            }}
            className="cursor-pointer gap-2 py-2 px-3 text-sm rounded-lg hover:bg-muted"
          >
            <IoSettings className="h-4 w-4" />
            {t("sidebarAvatar.settings")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              setOpen(false);
              setLanguageDialogOpen(true);
            }}
            className="cursor-pointer gap-2 py-2 px-3 text-sm rounded-lg hover:bg-muted"
          >
            <IoGlobeOutline className="h-4 w-4" />
            <span>{t("common:language.label")}</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {currentLanguage?.nativeName ?? currentLang}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem 
            onClick={() => {
              auth.signOut();
              navbar.setIsOpen(false);
              router.push('/');
            }} 
            className="cursor-pointer gap-2 py-2 px-3 text-sm rounded-lg text-red-500 focus:text-red-500 hover:bg-red-500/10"
          >
            <IoLogOut className="h-4 w-4" />
            {t("sidebarAvatar.signOut")}
          </DropdownMenuItem>

          {/* Theme Switcher Row */}
          <DropdownMenuSeparator />
          <div className="px-3 py-2">
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-2">
              {t("sidebarAvatar.theme.label")}
            </div>
            <div className="flex items-center p-0.5 rounded-lg border border-border bg-muted">
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  setTheme("light");
                }}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 py-1 rounded text-xs transition-colors",
                  theme === "light" ? "bg-background text-foreground shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"
                )}
              >
                <IoSunny className="h-3 w-3" />
                {t("sidebarAvatar.theme.light")}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  setTheme("dark");
                }}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 py-1 rounded text-xs transition-colors",
                  theme === "dark" ? "bg-background text-foreground shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"
                )}
              >
                <IoMoon className="h-3 w-3" />
                {t("sidebarAvatar.theme.dark")}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  setTheme("system");
                }}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 py-1 rounded text-xs transition-colors",
                  theme === "system" ? "bg-background text-foreground shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"
                )}
              >
                <IoDesktop className="h-3 w-3" />
                {t("sidebarAvatar.theme.system")}
              </button>
            </div>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={languageDialogOpen} onOpenChange={setLanguageDialogOpen}>
        <DialogContent className="w-[calc(100%-2rem)] max-w-md rounded-xl">
          <DialogHeader>
            <DialogTitle>{t("common:language.label")}</DialogTitle>
            <DialogDescription>
              {t("common:language.description")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1 max-h-[60vh] overflow-y-auto">
            {SUPPORTED_LANGUAGES.map((lang) => {
              const isSelected = lang.code === currentLang;
              return (
                <button
                  key={lang.code}
                  type="button"
                  onClick={() => {
                    void i18n.changeLanguage(lang.code);
                    setLanguageDialogOpen(false);
                  }}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors cursor-pointer",
                    isSelected
                      ? "border-primary/60 bg-primary/10 text-foreground font-medium"
                      : "border-border/70 bg-background hover:bg-muted/60 text-foreground"
                  )}
                >
                  <div className="min-w-0">
                    <div className="truncate">{lang.nativeName}</div>
                    {lang.nativeName !== lang.englishName && (
                      <div className="text-xs text-muted-foreground truncate">
                        {lang.englishName}
                      </div>
                    )}
                  </div>
                  {isSelected && (
                    <LuCheck className="h-4 w-4 shrink-0 text-primary" />
                  )}
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default SidebarAvatar;
