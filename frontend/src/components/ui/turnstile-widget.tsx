"use client";

import { useEffect, useRef } from "react";
import { env } from "@/lib/env";

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          action?: string;
          theme?: "auto" | "light" | "dark";
          callback?: (token: string) => void;
          "expired-callback"?: () => void;
          "error-callback"?: () => void;
        }
      ) => string;
      remove: (widgetId: string) => void;
    };
  }
}

const SCRIPT_ID = "cf-turnstile-script";
let scriptPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Turnstile script failed")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Turnstile script failed"));
    document.head.appendChild(script);
  });

  return scriptPromise;
}

interface TurnstileWidgetProps {
  action: string;
  resetKey?: number | string;
  onToken: (token: string) => void;
}

export function TurnstileWidget({ action, resetKey = 0, onToken }: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    const sitekey = env.TURNSTILE_SITE_KEY;
    if (!sitekey) return;

    let cancelled = false;
    let widgetId: string | null = null;
    onTokenRef.current("");

    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        widgetId = window.turnstile.render(containerRef.current, {
          sitekey,
          action,
          theme: "auto",
          callback: (token: string) => {
            if (!cancelled) onTokenRef.current(token);
          },
          "expired-callback": () => {
            if (!cancelled) onTokenRef.current("");
          },
          "error-callback": () => {
            if (!cancelled) onTokenRef.current("");
          },
        });
      })
      .catch(() => {
        if (!cancelled) onTokenRef.current("");
      });

    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) {
        try {
          window.turnstile.remove(widgetId);
        } catch {
          // ignore cleanup errors
        }
      }
    };
  }, [action, resetKey]);

  if (!env.TURNSTILE_SITE_KEY) return null;

  return <div ref={containerRef} className="flex justify-center my-1 min-h-[65px]" />;
}
