import { API_BASE, authedAxios } from "@/lib/axios";

export interface GitlabAccount {
  id: string;
  login?: string | null;
}

export interface GitlabAccountStatus {
  accounts: GitlabAccount[];
  configured: boolean;
}

export const GITLAB_ACCOUNTS_EVENT = "gitlab-accounts-changed";

export function notifyGitlabAccountsChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(GITLAB_ACCOUNTS_EVENT));
}

export async function getGitlabAccountStatus(signal?: AbortSignal): Promise<GitlabAccountStatus> {
  const { data } = await authedAxios.get<GitlabAccountStatus>(`${API_BASE}/auth/gitlab/accounts/`, { signal });
  return {
    accounts: Array.isArray(data.accounts) ? data.accounts : [],
    configured: Boolean(data.configured),
  };
}

export async function listGitlabAccounts(signal?: AbortSignal) {
  const status = await getGitlabAccountStatus(signal);
  return status.accounts;
}

export async function disconnectGitlabAccount(id: string, signal?: AbortSignal) {
  const { data } = await authedAxios.delete<{ deleted: boolean }>(
    `${API_BASE}/auth/gitlab/accounts/${encodeURIComponent(id)}/`,
    { signal },
  );
  return data.deleted;
}

export async function connectGitlabAccount(signal?: AbortSignal): Promise<void> {
  const popup = window.open("about:blank", "neuronrunner_gitlab_connection", "width=560,height=700");
  if (!popup) throw new Error("Allow pop-ups to connect your GitLab account.");
  try {
    const { data } = await authedAxios.post<{ authorization_url: string }>(
      `${API_BASE}/auth/gitlab/connect/`,
      {},
      { signal },
    );
    const url = new URL(data.authorization_url);
    if (!url.pathname.endsWith("/oauth/authorize")) {
      throw new Error("GitLab authorization could not be started.");
    }
    const backendOrigin = new URL(API_BASE || window.location.origin, window.location.origin).origin;
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setInterval>;
      const finish = (error?: Error) => {
        window.removeEventListener("message", onMessage);
        signal?.removeEventListener("abort", onAbort);
        clearInterval(timer);
        popup.close();
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(new DOMException("GitLab connection cancelled", "AbortError"));
      const onMessage = (event: MessageEvent) => {
        if (event.origin !== backendOrigin || event.data?.source !== "gitlab-connection") return;
        if (event.source && event.source !== popup) return;
        finish(
          event.data.connected === true
            ? undefined
            : new Error(event.data.error || "GitLab connection failed. Try again."),
        );
      };
      window.addEventListener("message", onMessage);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      popup.location.href = data.authorization_url;
      const started = Date.now();
      timer = setInterval(() => {
        if (popup.closed) {
          clearInterval(timer);
          listGitlabAccounts(signal)
            .then((accounts) => {
              if (accounts.length > 0) finish();
              else finish(new Error("GitLab authorization was cancelled. Connect again to link your account."));
            })
            .catch((error) => finish(error));
        } else if (Date.now() - started > 600000) {
          finish(new Error("GitLab connection expired. Connect again."));
        }
      }, 500);
    });
  } catch (error) {
    popup.close();
    throw error;
  }
}
