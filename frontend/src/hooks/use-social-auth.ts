import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { env } from "@/lib/env";
import { GoogleLoginError, useGoogleTokenRequest } from "@/lib/google-login";
import { toaster } from "@/components/ui/toaster";
import useAuthStore from "@/stores/auth";
import type { IUser } from "@/types/user";

export type SocialProvider = "google" | "github";

interface UseSocialAuthOptions {
  onSuccess?: () => void;
}

export function useSocialAuth({ onSuccess }: UseSocialAuthOptions = {}) {
  const { t } = useTranslation("auth");
  const auth = useAuthStore();
  const requestGoogleToken = useGoogleTokenRequest();
  const [socialLoading, setSocialLoading] = useState<null | SocialProvider>(null);
  const githubCleanupRef = useRef<(() => void) | null>(null);
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const cleanupGithubListener = useCallback(() => {
    githubCleanupRef.current?.();
    githubCleanupRef.current = null;
  }, []);

  const resetSocialAuth = useCallback(() => {
    cleanupGithubListener();
    setSocialLoading(null);
  }, [cleanupGithubListener]);

  useEffect(() => cleanupGithubListener, [cleanupGithubListener]);

  const handleGoogleLogin = useCallback(async () => {
    if (!requestGoogleToken) {
      toaster.create({ title: t("socialAuth.google.unavailable"), type: "error" });
      return;
    }

    setSocialLoading("google");
    try {
      const accessToken = await requestGoogleToken();
      await auth.socialLogin("google-oauth2", accessToken);
      toaster.create({ title: t("socialAuth.google.success"), type: "success" });
      onSuccessRef.current?.();
    } catch (error) {
      const type = error instanceof GoogleLoginError ? error.type : "failed";
      if (type === "popup_failed_to_open") {
        toaster.create({ title: t("socialAuth.google.popupBlocked"), type: "error" });
      } else if (type === "unavailable") {
        toaster.create({ title: t("socialAuth.google.unavailable"), type: "error" });
      } else if (type !== "popup_closed") {
        toaster.create({ title: t("socialAuth.google.failed"), type: "error" });
      }
    } finally {
      setSocialLoading(null);
    }
  }, [auth, requestGoogleToken, t]);

  const createOAuthNonce = () => {
    if (typeof window !== "undefined" && window.crypto?.getRandomValues) {
      const bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
  };

  const handleGithubLogin = useCallback(() => {
    cleanupGithubListener();

    const apiBase = env.API_URL;
    if (!apiBase) {
      toaster.create({ title: t("socialAuth.github.unavailable"), type: "error" });
      setSocialLoading(null);
      return;
    }

    const nonce = createOAuthNonce();
    const loginUrl = new URL(`${apiBase}/auth/github/login/`, window.location.origin);
    loginUrl.searchParams.set("origin", window.location.origin);
    loginUrl.searchParams.set("nonce", nonce);
    const popup = window.open(
      loginUrl.toString(),
      "github_oauth",
      "width=520,height=640"
    );
    if (!popup || popup.closed) {
      toaster.create({ title: t("socialAuth.github.popupBlocked"), type: "error" });
      setSocialLoading(null);
      return;
    }

    const backendOrigin = (() => {
      try {
        return new URL(apiBase, window.location.origin).origin;
      } catch {
        return window.location.origin;
      }
    })();

    let finished = false;
    let pollTimer = 0;

    const finish = () => {
      if (finished) return;
      finished = true;
      window.removeEventListener("message", onMessage);
      window.clearInterval(pollTimer);
      if (githubCleanupRef.current === finish) {
        githubCleanupRef.current = null;
      }
    };

    const completeGithubAuth = (data: {
      source?: string;
      token?: string;
      refresh?: string;
      user?: IUser;
      error?: string;
    } | null) => {
      if (!data || data.source !== "github-oauth") {
        setSocialLoading(null);
        return;
      }
      if (data.error || !data.token || !data.user) {
        toaster.create({ title: t("socialAuth.github.failed"), type: "error" });
        setSocialLoading(null);
        return;
      }

      if (data.refresh) {
        try {
          localStorage.setItem("refreshToken", data.refresh);
        } catch {}
      }
      auth.setToken(data.token);
      auth.setUser(data.user);
      toaster.create({ title: t("socialAuth.github.success"), type: "success" });
      onSuccessRef.current?.();
      setSocialLoading(null);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== backendOrigin) return;
      if (popup && event.source !== popup) return;
      const data = event.data as {
        source?: string;
        token?: string;
        refresh?: string;
        user?: IUser;
        error?: string;
      } | null;
      if (!data || data.source !== "github-oauth") return;

      finish();
      try {
        popup.close();
      } catch {
        // Ignore cross-origin close restrictions
      }
      completeGithubAuth(data);
    };

    pollTimer = window.setInterval(() => {
      if (popup.closed) {
        finish();
        // Fallback when window.opener is dropped by COOP or origin mismatch.
        void fetch(`${apiBase}/auth/github/result/?nonce=${encodeURIComponent(nonce)}`)
          .then(async (res) => (res.ok ? res.json() : null))
          .then((data) => completeGithubAuth(data))
          .catch(() => {
            setSocialLoading(null);
          });
      }
    }, 400);

    githubCleanupRef.current = finish;
    setSocialLoading("github");
    window.addEventListener("message", onMessage);
  }, [auth, cleanupGithubListener, t]);

  return {
    socialLoading,
    handleGoogleLogin,
    handleGithubLogin,
    resetSocialAuth,
  };
}
