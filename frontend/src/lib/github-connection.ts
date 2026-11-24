import { API_BASE, authedAxios } from "@/lib/axios";

export interface GithubRepository {
  name: string;
  full_name: string;
  clone_url: string;
  private: boolean;
  description?: string | null;
}
export interface GithubAccess {
  connected: boolean;
  username?: string;
  reason?: "not_connected" | "expired";
  can_access_private?: boolean | null;
  repos: GithubRepository[];
  has_next?: boolean;
  error?: string | null;
}

export interface GithubAccount { id: string; login?: string | null }

export const GITHUB_ACCOUNTS_EVENT = "github-accounts-changed";

export function notifyGithubAccountsChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(GITHUB_ACCOUNTS_EVENT));
}

export async function listGithubAccounts(signal?: AbortSignal) {
  const { data } = await authedAxios.get<{ accounts: GithubAccount[] }>(`${API_BASE}/auth/github/accounts/`, { signal });
  return data.accounts;
}

export async function disconnectGithubAccount(id: string, signal?: AbortSignal) {
  const { data } = await authedAxios.delete<{ deleted: boolean }>(`${API_BASE}/auth/github/accounts/${encodeURIComponent(id)}/`, { signal });
  return data.deleted;
}

export async function githubRepositories(uuid?: string, page: number = 1, signal?: AbortSignal) {
  const url = uuid ? `${API_BASE}/sandbox/sandboxes/${uuid}/github/repos/` : `${API_BASE}/sandbox/github/repos/`;
  const { data } = await authedAxios.get<GithubAccess>(url, { params: { page }, signal });
  return data;
}

export async function connectGithubAccount(signal?: AbortSignal, uuid?: string): Promise<void> {
  const popup = window.open("about:blank", "neuronrunner_github_connection", "width=560,height=700");
  if (!popup) throw new Error("Allow pop-ups to connect your GitHub account.");
  try {
    const { data } = await authedAxios.post<{ authorization_url: string }>(`${API_BASE}/auth/github/connect/`, {}, { signal });
    const url = new URL(data.authorization_url);
    if (url.origin !== "https://github.com" || url.pathname !== "/login/oauth/authorize") throw new Error("GitHub authorization could not be started.");
    const backendOrigin = new URL(API_BASE || window.location.origin, window.location.origin).origin;
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setInterval>;
      const finish = (error?: Error) => {
        window.removeEventListener("message", onMessage);
        signal?.removeEventListener("abort", onAbort);
        clearInterval(timer);
        popup.close();
        if (error) reject(error); else resolve();
      };
      const onAbort = () => finish(new DOMException("GitHub connection cancelled", "AbortError"));
      const onMessage = (event: MessageEvent) => {
        if (event.origin !== backendOrigin || event.data?.source !== "github-connection") return;
        if (event.source && event.source !== popup) return;
        finish(event.data.connected === true ? undefined : new Error(event.data.error || "GitHub connection failed. Try again."));
      };
      window.addEventListener("message", onMessage);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      popup.location.href = data.authorization_url;
      const started = Date.now();
      timer = setInterval(() => {
        if (popup.closed) {
          clearInterval(timer);
          // Some OAuth browsers drop window.opener. Verify the saved connection.
          githubRepositories(uuid, 1, signal).then(access => {
            if (access.connected && access.can_access_private !== false) {
              finish();
            } else {
              const msg = access.error || (access.can_access_private === false
                ? "GitHub did not grant private repository access. Reconnect and allow repository access."
                : access.reason === "expired"
                ? "Your GitHub connection has expired. Connect again."
                : "GitHub authorization was cancelled. Connect again to enable private repositories.");
              finish(new Error(msg));
            }
          }).catch(error => finish(error));
        }
        else if (Date.now() - started > 600000) finish(new Error("GitHub connection expired. Connect again."));
      }, 500);
    });
  } catch (error) { popup.close(); throw error; }
}
