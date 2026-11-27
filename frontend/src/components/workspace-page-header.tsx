import type { ComponentProps, ReactNode } from "react";
import type { IconType } from "react-icons";
import { LuPanelLeftOpen } from "react-icons/lu";
import useSidebarStore from "@/stores/sidebar";
import { cn } from "@/lib/utils";

export function WorkspacePageHeader({
  className,
  children,
  actions,
  ...props
}: ComponentProps<"header"> & { actions?: ReactNode }) {
  return (
    <header className={cn("flex h-11 shrink-0 items-center justify-between gap-2.5 border-b border-border/40 bg-background/75 px-3 backdrop-blur-xl sm:px-4", className)} {...props}>
      {children}
      {actions}
    </header>
  );
}

export function WorkspacePageTitle({ icon: Icon, children }: { icon: IconType; children: ReactNode }) {
  return (
    <div className="flex min-w-0 max-w-[620px] items-center gap-2.5 rounded-xl px-1 py-1 sm:px-2">
      <div aria-hidden="true" className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-gradient-to-br from-indigo-500/15 via-violet-500/10 to-transparent text-indigo-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] sm:flex">
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1 text-sm font-semibold leading-none tracking-[-0.01em] text-foreground/80">
        {children}
      </div>
    </div>
  );
}

/** Pages without a top bar still need a way to reopen the sidebar; this floats in the corner only while it is closed. */
export function WorkspaceSidebarToggle({ label }: { label: string }) {
  const isOpen = useSidebarStore((state) => state.isOpen);
  if (isOpen) return null;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => useSidebarStore.getState().toggle()}
      className="absolute left-3 top-2.5 z-40 inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
    >
      <LuPanelLeftOpen className="h-5 w-5" />
    </button>
  );
}
