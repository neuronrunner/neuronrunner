import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type AppShellMode = "page" | "workspace" | "page-no-header";

interface AppShellProps {
  children: ReactNode;
  navigation: ReactNode;
  background?: ReactNode;
  overlays?: ReactNode;
  mode?: AppShellMode;
  sidebarOpen?: boolean;
}

/**
 * Owns the application's global geometry.
 *
 * Page routes reserve the shared header inset while workspace routes consume
 * the full viewport. Keeping those rules here prevents individual pages from
 * compensating for the fixed navigation with hard-coded margins.
 */
export default function AppShell({
  children,
  navigation,
  background,
  overlays,
  mode = "page",
  sidebarOpen = false,
}: AppShellProps) {
  return (
    <div className={cn("app-shell", `app-shell--${mode}`)}>
      {navigation}
      {background}
      {overlays}

      <main
        className={cn(
          "app-shell__viewport",
          sidebarOpen && "app-shell__viewport--sidebar"
        )}
      >
        {children}
      </main>
    </div>
  );
}
