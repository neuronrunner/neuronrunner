"use client";

import { env } from "@/lib/env";
import React, { useEffect, useState, useRef } from "react";
import { usePathname } from "@/lib/navigation";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/toaster";
import { GoogleLoginProvider } from "@/lib/google-login";
import axios from "axios";
import useAuthStore from "@/stores/auth";
import Background from "@/components/background";
import Navbar from "@/components/navbar";
import useSidebarStore from "@/stores/sidebar";
import SettingsDialog from "@/components/settings/dialog";
import AppShell, { type AppShellMode } from "@/components/app-shell";
import WorkspaceTabContainer from "@/components/workspace-tabs/WorkspaceTabContainer";
import { NeuronLogo } from "@/components/neuron-logo";

// Session checker component - refreshes access token on app mount
const SessionChecker = ({ children }: { children: React.ReactNode }) => {
  // If we already know the user is logged out (no refreshToken), or if we have
  // cached credentials (user/token) ready in localStorage, render optimistically immediately.
  const [ready, setReady] = useState(() => {
    if (typeof window === "undefined") return false;
    const refreshToken = localStorage.getItem("refreshToken");
    if (!refreshToken) return true;
    return !!(localStorage.getItem("user") && localStorage.getItem("token"));
  });
  const { setUser, setToken } = useAuthStore();
  const hasChecked = useRef(false);
  const { setOpen } = useSidebarStore();

  useEffect(() => {
    if (hasChecked.current) return;
    hasChecked.current = true;

    const refreshSession = async () => {
      const refreshToken = localStorage.getItem("refreshToken");
      if (!refreshToken) {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        setUser(null);
        setToken(null);
        return;
      }

      try {
        const response = await axios.post(
          `${env.API_URL}/auth/refresh/`,
          { refresh: refreshToken }
        );

        if (response.status === 200 && response.data.access) {
          const accessToken = response.data.access as string;
          localStorage.setItem("token", accessToken);
          setToken(accessToken);

          const storedUser = localStorage.getItem("user");
          if (storedUser) {
            try {
              setUser(JSON.parse(storedUser));
            } catch {
              localStorage.removeItem("user");
              localStorage.removeItem("token");
              setUser(null);
              setToken(null);
            }
          } else {
            localStorage.removeItem("token");
            setUser(null);
            setToken(null);
          }
        }
      } catch (err: any) {
        // Only logout if the backend explicitly rejected the refresh token (401/403).
        // Network errors / backend down should not auto-logout the user.
        const status = err?.response?.status;
        if (status === 400 || status === 401 || status === 403) {
          localStorage.removeItem("token");
          localStorage.removeItem("refreshToken");
          localStorage.removeItem("user");
          localStorage.removeItem("sandbox-projects-storage");
          localStorage.removeItem("team-workspaces-storage");
          try {
            Object.keys(localStorage).forEach((key) => {
              if (key.startsWith("nr_selected_vm:")) {
                localStorage.removeItem(key);
              }
            });
          } catch {}
          setUser(null);
          setToken(null);
          setOpen(false);
        } else {
          console.warn("Session refresh skipped (backend unreachable):", err?.message || err);
        }
      }
    };

    void refreshSession().finally(() => setReady(true));
  }, [setUser, setToken, setOpen]);

  if (!ready) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-background text-foreground">
        <div className="flex flex-col items-center gap-3">
          <NeuronLogo size={40} className="animate-pulse" />
        </div>
      </div>
    );
  }

  return <>{children}</>;
};

export const Provider = (props: { children: React.ReactNode }) => {
  const [mounted, setMounted] = useState(() => typeof window !== "undefined");
  const { user, token } = useAuthStore();
  const { isOpen } = useSidebarStore();
  const pathname = usePathname();

  const isLoggedIn = Boolean(user && token);
  const isRedirectingHome = isLoggedIn && pathname === "/";
  const isWorkspaceRoute =
    isLoggedIn && (
      pathname === "/new" ||
      pathname === "/chat" ||
      pathname?.startsWith("/chat/") ||
      pathname?.startsWith("/pull-requests") ||
      pathname?.startsWith("/issues") ||
      pathname?.startsWith("/integrations") ||
      pathname?.startsWith("/projects/")
    );
  const isProjectDetailRoute = pathname?.startsWith("/projects/");
  const showLeftSidebar = isLoggedIn && isOpen && isWorkspaceRoute;
  const shellMode: AppShellMode = isWorkspaceRoute
    ? "workspace"
    : isProjectDetailRoute || isRedirectingHome
      ? "page-no-header"
      : "page";

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-background text-foreground">
        <div className="flex flex-col items-center gap-3">
          <NeuronLogo size={40} className="animate-pulse" />
        </div>
      </div>
    );
  }

  const googleClientId = env.GOOGLE_CLIENT_ID;

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <GoogleLoginProvider clientId={googleClientId}>
        <SessionChecker>
          <AppShell
            mode={shellMode}
            sidebarOpen={showLeftSidebar}
            navigation={isRedirectingHome ? null : <Navbar />}
            background={!isLoggedIn && pathname === "/" ? <Background /> : undefined}
            overlays={
              <>
                <SettingsDialog />
              </>
            }
          >
            {isLoggedIn && isWorkspaceRoute ? (
              <WorkspaceTabContainer>{props.children}</WorkspaceTabContainer>
            ) : (
              props.children
            )}
          </AppShell>
          <Toaster />
        </SessionChecker>
      </GoogleLoginProvider>
    </ThemeProvider>
  );
};
