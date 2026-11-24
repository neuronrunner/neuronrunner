"use client";

import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import SigninDialog from "./signin-dialog";
import SignupDialog from "./signup-dialog";
import NeuronLogo from "@/components/neuron-logo";
import { LuMenu, LuX } from "react-icons/lu";
import { usePathname, isKnownRoute } from "@/lib/navigation";
import useAuthStore from "@/stores/auth";
import useNavbarStore from "@/stores/navbar";
import useSigninStore from "@/stores/signin";
import useSignupStore from "@/stores/signup";
import useWorkspacesStore from "@/stores/workspaces";
import Sidebar from "@/components/sidebar";
import { LanguageSwitcher } from "@/components/language-switcher";
import { env } from "@/lib/env";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import frontendExtension from "@cloud";

export interface NavbarProps {
  current_page?: "home" | "pricing";
}

const Navbar = (_props?: NavbarProps) => {
  const { t } = useTranslation("auth");
  const auth = useAuthStore();
  const pathname = usePathname();
  const openSignin = useSigninStore((s) => s.setOpen);
  const openSignup = useSignupStore((s) => s.setOpen);

  const [isAtTop, setIsAtTop] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const checkScroll = () => {
      const windowScroll = window.scrollY || document.documentElement?.scrollTop || 0;
      const scrollContainer = document.querySelector(".landing-scroll");
      const containerScroll = scrollContainer ? scrollContainer.scrollTop : 0;
      const atTop = windowScroll <= 15 && containerScroll <= 15;
      setIsAtTop(atTop);
    };

    checkScroll();
    window.addEventListener("scroll", checkScroll, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", checkScroll, { capture: true });
  }, []);

  useEffect(() => {
    setIsAtTop(true);
  }, [pathname]);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [mobileOpen]);

  const isLoggedIn = Boolean(auth.user && auth.token);
  const isChatPage = pathname === "/new" || pathname.startsWith("/chat");
  const isIntegrationsPage = pathname.startsWith("/integrations");
  const isNotFound = useNavbarStore((state) => state.isNotFound);
  const is404 = isNotFound || !isKnownRoute(pathname);

  const isWorkspaceRoute =
    isLoggedIn && (
      isIntegrationsPage ||
      isChatPage ||
      pathname.startsWith("/projects/") ||
      pathname.startsWith("/pull-requests") ||
      pathname.startsWith("/issues")
    );

  const hasPricingRoute = frontendExtension.routes.some((r) => r.path === "/pricing");
  const navLinks = [
    ...(hasPricingRoute ? [{ to: "/pricing", label: t("navbar.links.pricing") }] : []),
    { to: "/integrations", label: t("navbar.links.integrations") },
    ...(env.ENABLE_DOCS ? [{ to: "/docs", label: t("navbar.links.docs") }] : []),
  ];
  const isActive = (to: string) => pathname === to || (to !== "/" && pathname.startsWith(`${to}/`));

  // On workspace routes (Chat, PRs, Issues, Connectors, Projects),
  // render Sidebar only for authenticated users.
  if (isWorkspaceRoute) {
    return (
      <div className="pointer-events-auto">
        <Sidebar offsetTop={0} />
      </div>
    );
  }

  // Standalone / Marketing pages (Pricing, Docs, Legal, 404, Admin, or logged-out home):
  return (
    <header
      className={cn(
        "fixed top-0 inset-x-0 z-50 transition-colors duration-200 pointer-events-auto",
        isAtTop
          ? "bg-transparent border-b border-transparent shadow-none"
          : "bg-background/80 backdrop-blur-md border-b border-border/50 shadow-xs"
      )}
    >
      <div className="relative mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-8">
        {/* Logo */}
        <Link
          to="/"
          onClick={(e) => {
            if (pathname === "/") {
              e.preventDefault();
              const scrollEl = document.querySelector(".landing-scroll");
              if (scrollEl && scrollEl.scrollTop > 0) {
                scrollEl.scrollTo({ top: 0, behavior: "smooth" });
              } else {
                window.scrollTo({ top: 0, behavior: "smooth" });
              }
            }
          }}
          className="group flex min-w-0 items-center gap-2.5 justify-self-start transition-opacity hover:opacity-90"
        >
          <NeuronLogo size={32} className="text-foreground transition-transform duration-200 group-hover:scale-105 sm:h-9 sm:w-9" />
          <div className="hidden items-baseline gap-[1ch] font-mono text-base tracking-tight text-foreground min-[380px]:flex sm:text-lg">
            <span className="font-bold">Neuron</span>{" "}
            <span className="font-light text-muted-foreground">Runner</span>
          </div>
        </Link>

        {/* Desktop section links, exactly centered between logo and actions */}
        <nav
          aria-label={t("navbar.menu.label")}
          className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-1 whitespace-nowrap text-sm text-muted-foreground xl:flex"
        >
          {navLinks.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              aria-current={isActive(link.to) ? "page" : undefined}
              className={cn(
                "rounded-lg px-3 py-1.5 transition-colors hover:bg-muted/60 hover:text-foreground",
                isActive(link.to) && "bg-muted/60 font-medium text-foreground"
              )}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2.5">
          <LanguageSwitcher className="hidden h-8 w-[130px] shrink-0 rounded-lg border-border/80 bg-background/80 px-2.5 text-xs sm:flex sm:w-[130px]" />
          {isLoggedIn ? (
            <>
              <Link
                to="/new"
                className="shrink-0 whitespace-nowrap rounded-lg bg-foreground px-3 py-1.5 text-xs font-semibold text-background shadow-xs transition-transform hover:-translate-y-0.5 sm:px-3.5 sm:text-sm"
              >
                {t("navbar.actions.goToChat")}
              </Link>
              {auth.user && (
                <button
                  type="button"
                  onClick={() => useWorkspacesStore.getState().setWorkspaceSettingsDialogOpen(true, "workspace")}
                  className="hidden shrink-0 whitespace-nowrap rounded-lg border border-border/80 bg-background/80 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/70 sm:inline-flex sm:text-sm"
                >
                  {t("navbar.actions.settings", { defaultValue: "Settings" })}
                </button>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => openSignin(true)}
                className="hidden shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/70 sm:inline-flex sm:text-sm"
              >
                {t("navbar.actions.signIn")}
              </button>
              <button
                type="button"
                onClick={() => openSignup(true)}
                className="shrink-0 whitespace-nowrap rounded-lg bg-foreground px-3 py-1.5 text-xs font-semibold text-background shadow-sm transition-transform hover:-translate-y-0.5 sm:px-3.5 sm:text-sm"
              >
                {t("navbar.actions.startBuilding")}
              </button>
            </>
          )}
          <SigninDialog hideTrigger />
          <SignupDialog hideTrigger />

          <div className="relative xl:hidden">
            <button
              type="button"
              onClick={() => setMobileOpen((open) => !open)}
              aria-expanded={mobileOpen}
              aria-controls="mobile-nav"
              aria-label={mobileOpen ? t("navbar.menu.close") : t("navbar.menu.open")}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background/70 text-foreground transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {mobileOpen ? <LuX className="h-4 w-4" /> : <LuMenu className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>

      {mobileOpen && (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => setMobileOpen(false)}
            className="fixed inset-x-0 bottom-0 top-16 z-40 cursor-default bg-background/20 backdrop-blur-[1px] xl:hidden"
          />
          <div
            id="mobile-nav"
            className="fixed inset-x-3 top-[4.5rem] z-50 rounded-2xl border border-border/70 bg-background/95 p-2 shadow-xl backdrop-blur-md motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2 motion-safe:duration-150 xl:hidden"
          >
            <nav aria-label={t("navbar.menu.label")} className="flex flex-col">
              {navLinks.map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  onClick={() => setMobileOpen(false)}
                  aria-current={isActive(link.to) ? "page" : undefined}
                  className={cn(
                    "rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
                    isActive(link.to) && "bg-muted/60 text-foreground"
                  )}
                >
                  {link.label}
                </Link>
              ))}
            </nav>
            <div className="mt-2 space-y-2 border-t border-border/60 pt-2">
              <LanguageSwitcher className="h-9 w-full rounded-lg sm:hidden" />
              {!isLoggedIn && (
                <button
                  type="button"
                  onClick={() => {
                    setMobileOpen(false);
                    openSignin(true);
                  }}
                  className="inline-flex h-10 w-full items-center justify-center rounded-lg border border-border/80 bg-background/80 text-sm font-medium text-foreground transition-colors hover:bg-muted/70 sm:hidden"
                >
                  {t("navbar.actions.signIn")}
                </button>
              )}
              {isLoggedIn && auth.user && (
                <button
                  type="button"
                  onClick={() => {
                    setMobileOpen(false);
                    useWorkspacesStore.getState().setWorkspaceSettingsDialogOpen(true, "workspace");
                  }}
                  className="inline-flex h-10 w-full items-center justify-center rounded-lg border border-border/80 bg-background/80 text-sm font-medium text-foreground transition-colors hover:bg-muted/70 sm:hidden"
                >
                  {t("navbar.actions.settings", { defaultValue: "Settings" })}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </header>
  );
};

export default Navbar;
