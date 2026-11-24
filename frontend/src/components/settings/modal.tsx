import type { ReactNode } from "react";
import type { IconType } from "react-icons";
import { useTranslation } from "react-i18next";
import { LuSettings, LuX } from "react-icons/lu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface SettingsTabItem<T extends string> {
  id: T;
  label: string;
  icon: IconType;
  section?: string;
}

interface SettingsModalProps<T extends string> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  tabs: readonly SettingsTabItem<T>[];
  activeTab: T;
  onTabChange: (tab: T) => void;
  workspaceSelector?: ReactNode;
  children: ReactNode;
}

export default function SettingsModal<T extends string>({
  open,
  onOpenChange,
  title,
  description,
  tabs,
  activeTab,
  onTabChange,
  workspaceSelector,
  children,
}: SettingsModalProps<T>) {
  const { t } = useTranslation("settings");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose
        className="w-[calc(100vw-2rem)] max-w-[1000px] h-[min(720px,calc(100dvh-2rem))] overflow-hidden p-0 gap-0 flex flex-col bg-card dark:bg-[#0c0c14]/90 backdrop-blur-2xl border border-border dark:border-white/10 shadow-2xl rounded-2xl"
      >
        <DialogHeader className="px-5 py-3 border-b border-border dark:border-white/10 bg-muted/40 dark:bg-white/[0.02] flex items-center justify-between flex-row shrink-0 space-y-0 m-0">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-muted dark:bg-zinc-500/15 text-foreground dark:text-zinc-300 border border-border dark:border-zinc-500/25">
              <LuSettings size={15} />
            </div>
            <div className="min-w-0 text-left">
              <DialogTitle className="text-sm font-semibold tracking-tight">
                {title}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {description}
              </DialogDescription>
              <span className="text-xs text-muted-foreground">
                {tabs.find((tab) => tab.id === activeTab)?.label}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label={t("modal.closeAriaLabel")}
            className="h-7 w-7 shrink-0 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted dark:hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <LuX size={15} />
          </button>
        </DialogHeader>
        <div className="flex flex-col md:flex-row flex-1 w-full min-h-0 overflow-hidden">
          <div className="w-full md:w-[244px] shrink-0 border-b md:border-b-0 md:border-r border-border dark:border-white/10 bg-muted/30 dark:bg-black/30 p-3">
            {workspaceSelector}
            <nav
              aria-label={title}
              className="flex flex-row md:flex-col gap-1.5 overflow-x-auto"
            >
              {tabs.map((tab, idx) => {
                const isActive = activeTab === tab.id;
                const Icon = tab.icon;
                const prevTab = tabs[idx - 1];
                const showSection = tab.section && (!prevTab || prevTab.section !== tab.section);
                return (
                  <div key={tab.id} className="contents md:block">
                    {showSection && (
                      <p
                        className={cn(
                          "px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 hidden md:block",
                          idx > 0 ? "mt-3.5 mb-1.5" : "mb-1.5",
                        )}
                      >
                        {tab.section}
                      </p>
                    )}
                    <button
                      type="button"
                      aria-current={isActive ? "page" : undefined}
                      onClick={() => onTabChange(tab.id)}
                      className={cn(
                        "flex shrink-0 items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition-all whitespace-nowrap text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:w-full",
                        isActive
                          ? "bg-primary/10 text-primary dark:bg-zinc-500/20 dark:text-zinc-200 font-semibold border border-primary/20 dark:border-zinc-500/30 shadow-sm"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted/60 dark:hover:bg-white/5",
                      )}
                    >
                      <Icon size={14} className="shrink-0" />
                      <span className="truncate">{tab.label}</span>
                    </button>
                  </div>
                );
              })}
            </nav>
          </div>
          <div className="flex-1 px-5 sm:px-6 pt-4 pb-6 overflow-y-auto min-h-0 bg-background/50 dark:bg-transparent">
            {children}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
