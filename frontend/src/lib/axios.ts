"use client";

import { env } from "@/lib/env";
import axios from "axios";
import useAuthStore from "@/stores/auth";
import useWorkspacesStore from "@/stores/workspaces";
import useSidebarStore from "@/stores/sidebar";
import frontendExtension from "@cloud";

export const notifyInsufficientBalanceIfNeeded = (
  err: unknown,
  message?: string | null,
) => {
  frontendExtension.quotaBridge.notifyQuotaIfNeeded(err, message);
};

/**
 * Shared axios instance that authenticates every request with
 * the user's JWT (stored in localStorage or sessionStorage at login
 * time). This keeps us off the CORS preflight path for simple GETs
 * and removes the cookie/credential round-trip.
 *
 * `withCredentials: true` is intentionally NOT used: the backend
 * authenticates on the `Authorization: Bearer <token>` header and a
 * credentials send lives behind a CORS preflight (the browser aborts
 * the real request). Stick to the Bearer header.
 */
const tokenHeader = (): Record<string, string> => {
  if (typeof window === "undefined") return {};
  const token =
    localStorage.getItem("token") || sessionStorage.getItem("token") || "";
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export const workspaceHeaders = (): Record<string, string> => {
  const store = useWorkspacesStore.getState();
  const uuid = store.currentWorkspaceUuid;
  const headers: Record<string, string> = {};
  if (uuid) {
    if (store.workspaces.length > 0 && !store.workspaces.some((ws) => ws.uuid === uuid)) {
      return headers;
    }
    headers["X-Workspace-ID"] = uuid;
    Object.assign(headers, frontendExtension.runtimeBridge.getRequestHeaders(uuid));
  }
  return headers;
};

const attachWorkspaceHeader = (config: import("axios").InternalAxiosRequestConfig) => {
  const apiBase = env.API_URL || "";
  if (typeof window === "undefined") return config;
  const url = new URL(config.url || "", config.baseURL || window.location.origin);
  const base = new URL(apiBase || "/", window.location.origin);
  if (url.origin === base.origin && url.pathname.startsWith(base.pathname.replace(/\/$/, "") + "/") && !config.headers.has("X-Workspace-ID")) {
    const headers = workspaceHeaders();
    for (const [k, v] of Object.entries(headers)) {
      if (v && !config.headers.has(k)) config.headers.set(k, v);
    }
  }
  return config;
};

export const authedAxios = axios.create();
axios.interceptors.request.use(attachWorkspaceHeader);
authedAxios.interceptors.request.use(attachWorkspaceHeader);

authedAxios.interceptors.request.use((config) => {
  const headers = tokenHeader();
  if (headers.Authorization) {
    config.headers.set("Authorization", headers.Authorization);
  }
  return config;
});

export const API_BASE = env.API_URL || "";

export const clearAuthSession = () => {
  if (typeof window === "undefined") return;
  localStorage.removeItem("token");
  localStorage.removeItem("refreshToken");
  localStorage.removeItem("user");
  localStorage.removeItem("sandbox-projects-storage");
  localStorage.removeItem("team-workspaces-storage");
  localStorage.removeItem("git-ai-sessions-storage");
  try {
    Object.keys(localStorage).forEach((key) => {
      if (key.startsWith("nr_selected_vm:")) {
        localStorage.removeItem(key);
      }
    });
  } catch {}
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem("nr_workspace_tabs");
    }
  } catch {}
  try {
    useAuthStore.getState().setUser(null);
    useAuthStore.getState().setToken(null);
    useAuthStore.setState({ refreshToken: null });
    useWorkspacesStore.getState().resetWorkspaces?.();
    useSidebarStore.setState({
      isOpen: false,
      conversations: [],
      projectConversations: {},
      generalConversations: [],
      generalHistoryProjectId: null,
      historyHasMore: false,
      offset: 0,
      historyOffset: 0,
    });
  } catch {}
};

let isRefreshing = false;
let failedQueue: Array<{
  resolve: (token: string) => void;
  reject: (err: any) => void;
}> = [];

const processQueue = (error: any, token: string | null = null) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token!);
    }
  });
  failedQueue = [];
};

const handle401Response = async (error: any, axiosInstance: any) => {
  const originalRequest = error.config;
  const status = error.response ? error.response.status : null;

  if (status === 401) {
    if (originalRequest?._retry) {
      clearAuthSession();
      return Promise.reject(error);
    }

    const isAuthEndpoint = originalRequest?.url?.includes("/auth/");
    if (isAuthEndpoint) {
      clearAuthSession();
      return Promise.reject(error);
    }

    if (typeof window !== "undefined") {
      const refreshToken = localStorage.getItem("refreshToken");
      if (!refreshToken) {
        clearAuthSession();
        return Promise.reject(error);
      }

      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then((token) => {
            if (originalRequest?.headers) {
              if (typeof originalRequest.headers.set === "function") {
                originalRequest.headers.set("Authorization", `Bearer ${token}`);
              } else {
                originalRequest.headers["Authorization"] = `Bearer ${token}`;
              }
            }
            return axiosInstance(originalRequest);
          })
          .catch((err) => Promise.reject(err));
      }

      if (originalRequest) {
        originalRequest._retry = true;
      }
      isRefreshing = true;

      try {
        const res = await axios.post(`${API_BASE}/auth/refresh/`, {
          refresh: refreshToken,
        });

        if (res.status === 200 && res.data.access) {
          const newAccessToken = res.data.access as string;
          localStorage.setItem("token", newAccessToken);
          try {
            useAuthStore.getState().setToken(newAccessToken);
          } catch {}

          processQueue(null, newAccessToken);
          if (originalRequest?.headers) {
            if (typeof originalRequest.headers.set === "function") {
              originalRequest.headers.set("Authorization", `Bearer ${newAccessToken}`);
            } else {
              originalRequest.headers["Authorization"] = `Bearer ${newAccessToken}`;
            }
          }
          return axiosInstance(originalRequest);
        } else {
          clearAuthSession();
          processQueue(new Error("Token refresh failed"));
          return Promise.reject(error);
        }
      } catch (refreshErr: any) {
        clearAuthSession();
        processQueue(refreshErr, null);
        return Promise.reject(refreshErr);
      } finally {
        isRefreshing = false;
      }
    }
  }

  frontendExtension.quotaBridge.handleApiError(status, error, originalRequest);

  if (status === 403 && (error?.response?.data?.detail === "Workspace access denied." || error?.response?.data?.error === "Workspace access denied.")) {
    try {
      useWorkspacesStore.getState().resetWorkspaces?.();
      void useWorkspacesStore.getState().fetchWorkspaces?.();
    } catch {}
  }

  return Promise.reject(error);
};

authedAxios.interceptors.response.use(
  (response) => response,
  (error) => handle401Response(error, authedAxios)
);

axios.interceptors.response.use(
  (response) => response,
  (error) => handle401Response(error, axios)
);

