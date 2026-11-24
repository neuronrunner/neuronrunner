import React, { createContext, useCallback, useContext, useRef } from "react";
import { GoogleOAuthProvider, useGoogleLogin, useGoogleOAuth } from "@react-oauth/google";

export type GoogleLoginErrorType =
  | "unavailable"
  | "failed"
  | "popup_failed_to_open"
  | "popup_closed";

export class GoogleLoginError extends Error {
  constructor(public type: GoogleLoginErrorType) {
    super(`Google login error: ${type}`);
  }
}

/** Opens the Google popup and resolves with an access token. */
type RequestGoogleToken = () => Promise<string>;

const GoogleLoginContext = createContext<RequestGoogleToken | null>(null);

interface PendingRequest {
  resolve: (token: string) => void;
  reject: (error: GoogleLoginError) => void;
}

const GoogleLoginBridge = ({ children }: { children: React.ReactNode }) => {
  const { scriptLoadedSuccessfully } = useGoogleOAuth();
  const pendingRef = useRef<PendingRequest | null>(null);

  const settle = useCallback((result: { token: string } | { error: GoogleLoginErrorType }) => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending) return;
    if ("token" in result) pending.resolve(result.token);
    else pending.reject(new GoogleLoginError(result.error));
  }, []);

  const googleLogin = useGoogleLogin({
    flow: "implicit",
    scope: "openid email profile",
    onSuccess: (tokenResponse) => {
      if (tokenResponse?.access_token) settle({ token: tokenResponse.access_token });
      else settle({ error: "failed" });
    },
    onError: () => settle({ error: "failed" }),
    onNonOAuthError: (nonOAuthError) => {
      const type = nonOAuthError?.type;
      settle({
        error: type === "popup_failed_to_open" || type === "popup_closed" ? type : "failed",
      });
    },
  });

  const requestToken = useCallback<RequestGoogleToken>(() => {
    const googleAccounts = (
      window as Window & { google?: { accounts?: { oauth2?: unknown } } }
    ).google?.accounts?.oauth2;
    if (!scriptLoadedSuccessfully || !googleAccounts) {
      return Promise.reject(new GoogleLoginError("unavailable"));
    }

    // A new request supersedes any popup still waiting for a response.
    settle({ error: "popup_closed" });
    return new Promise<string>((resolve, reject) => {
      pendingRef.current = { resolve, reject };
      try {
        googleLogin();
      } catch {
        settle({ error: "failed" });
      }
    });
  }, [googleLogin, scriptLoadedSuccessfully, settle]);

  return (
    <GoogleLoginContext.Provider value={requestToken}>{children}</GoogleLoginContext.Provider>
  );
};

/**
 * Sets up Google sign-in only when a client ID is configured. Without one, the
 * Google script is never initialized and `useGoogleTokenRequest` returns null.
 */
export const GoogleLoginProvider = ({
  clientId,
  children,
}: {
  clientId: string;
  children: React.ReactNode;
}) => {
  if (!clientId) return <>{children}</>;
  return (
    <GoogleOAuthProvider clientId={clientId}>
      <GoogleLoginBridge>{children}</GoogleLoginBridge>
    </GoogleOAuthProvider>
  );
};

export const useGoogleTokenRequest = () => useContext(GoogleLoginContext);
