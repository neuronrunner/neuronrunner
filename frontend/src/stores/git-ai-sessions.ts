"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { env } from "@/lib/env";
import { authedAxios, workspaceHeaders } from "@/lib/axios";
import {
  repositoryError,
  repositoryMutation,
  type PullRequest,
  type RepositoryStatus,
} from "@/lib/repository-api";
import useChatStore from "@/stores/chat";
import i18n from "@/i18n";

export type AIStudioMode =
  | "issue-solve"
  | "issue-review"
  | "pr-fix"
  | "pr-review"
  | "pr-fix-ci";

export type AISessionStatus =
  | "preparing"
  | "generating"
  | "completed"
  | "error"
  | "canceled";

export interface GitAISession {
  key: string;
  kind: "pr" | "issue";
  repoKey: string;
  number: number;
  title?: string;
  mode: AIStudioMode;
  studioOpen: boolean;
  conversationId: string | null;
  activeRequestId: string | null;
  status: AISessionStatus;
  initialPrompt: string;
  targetBranch?: string;
  createBranchIfMissing?: boolean;
  baseBranch?: string;
  defaultCommitMessage: string;
  defaultPrTitle?: string;
  defaultPrBodyPrefix?: string;
  branchNotice?: string | null;
  errorMessage?: string | null;
  createdPr?: PullRequest | null;
  pushedSuccess?: boolean;
  startedAt: number;
  updatedAt: number;
}

export interface LaunchGitAISessionParams {
  kind: "pr" | "issue";
  repoKey: string;
  number: number;
  title?: string;
  mode: AIStudioMode;
  vmUuid: string;
  repoPath: string;
  initialPrompt: string;
  targetBranch?: string;
  createBranchIfMissing?: boolean;
  baseBranch?: string;
  defaultCommitMessage: string;
  defaultPrTitle?: string;
  defaultPrBodyPrefix?: string;
}

export function buildGitAISessionKey(
  kind: "pr" | "issue",
  repoKey: string,
  number: number
): string {
  return `${kind}:${repoKey}:${number}`;
}

export function isGitAISessionActiveStatus(status?: AISessionStatus | null): boolean {
  return status === "preparing" || status === "generating";
}

// Track runners started in the current JS runtime so a page reload can detect
// orphaned "preparing"/"generating" sessions and reconcile them with the backend.
const activeRunners = new Map<string, number>();
let runnerNonceSeq = 0;
let activeChatOwnerNonce = 0;

export function isGitAISessionRunnerActive(key: string): boolean {
  return activeRunners.has(key);
}

interface GitAISessionsState {
  sessions: Record<string, GitAISession>;
  setSession: (session: GitAISession) => void;
  updateSession: (key: string, patch: Partial<GitAISession>) => void;
  setStudioOpen: (key: string, open: boolean) => void;
  removeSession: (key: string) => void;
}

const useGitAISessionsStore = create<GitAISessionsState>()(
  persist(
    (set) => ({
      sessions: {},
      setSession: (session) =>
        set((state) => ({
          sessions: {
            ...state.sessions,
            [session.key]: session,
          },
        })),
      updateSession: (key, patch) =>
        set((state) => {
          const existing = state.sessions[key];
          if (!existing) return state;
          return {
            sessions: {
              ...state.sessions,
              [key]: {
                ...existing,
                ...patch,
                updatedAt: Date.now(),
              },
            },
          };
        }),
      setStudioOpen: (key, open) =>
        set((state) => {
          const existing = state.sessions[key];
          if (!existing || existing.studioOpen === open) return state;
          return {
            sessions: {
              ...state.sessions,
              [key]: {
                ...existing,
                studioOpen: open,
                updatedAt: Date.now(),
              },
            },
          };
        }),
      removeSession: (key) =>
        set((state) => {
          if (!state.sessions[key]) return state;
          const next = { ...state.sessions };
          delete next[key];
          return { sessions: next };
        }),
    }),
    {
      name: "git-ai-sessions-storage",
      storage: createJSONStorage(() =>
        typeof window !== "undefined"
          ? window.localStorage
          : {
              getItem: () => null,
              setItem: () => {},
              removeItem: () => {},
            }
      ),
      partialize: (state) => {
        // Keep at most the 50 most recent sessions in localStorage.
        const entries = Object.entries(state.sessions || {});
        if (entries.length <= 50) return { sessions: state.sessions };
        entries.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
        return { sessions: Object.fromEntries(entries.slice(0, 50)) };
      },
    }
  )
);

export async function launchGitAISession(params: LaunchGitAISessionParams): Promise<void> {
  const key = buildGitAISessionKey(params.kind, params.repoKey, params.number);
  const myNonce = ++runnerNonceSeq;
  activeRunners.set(key, myNonce);

  const shouldSwitch =
    params.mode === "issue-solve" ||
    params.mode === "pr-fix" ||
    params.mode === "pr-fix-ci";

  const now = Date.now();
  const initialSession: GitAISession = {
    key,
    kind: params.kind,
    repoKey: params.repoKey,
    number: params.number,
    title: params.title,
    mode: params.mode,
    studioOpen: true,
    conversationId: null,
    activeRequestId: null,
    status: shouldSwitch ? "preparing" : "generating",
    initialPrompt: params.initialPrompt,
    targetBranch: params.targetBranch,
    createBranchIfMissing: params.createBranchIfMissing,
    baseBranch: params.baseBranch,
    defaultCommitMessage: params.defaultCommitMessage,
    defaultPrTitle: params.defaultPrTitle,
    defaultPrBodyPrefix: params.defaultPrBodyPrefix,
    branchNotice: null,
    errorMessage: null,
    createdPr: null,
    pushedSuccess: false,
    startedAt: now,
    updatedAt: now,
  };

  const store = useGitAISessionsStore.getState();
  store.setSession(initialSession);

  let branchNotice: string | null = null;
  if (shouldSwitch && params.targetBranch && params.vmUuid && params.repoPath) {
    try {
      const status = await repositoryMutation<RepositoryStatus>(params.vmUuid, "git/switch", {
        path: params.repoPath,
        branch: params.targetBranch,
        create: Boolean(params.createBranchIfMissing),
        fetch: !params.createBranchIfMissing,
      });
      branchNotice = i18n.t("git:aiStudio.checkedOutBranch", { branch: status.branch });
    } catch (err) {
      branchNotice = i18n.t("git:aiStudio.runningOnCurrentBranch", {
        error: repositoryError(err),
      });
    }
  }

  if (activeRunners.get(key) !== myNonce) {
    return;
  }

  const currentAfterPrep = useGitAISessionsStore.getState().sessions[key];
  if (currentAfterPrep?.status === "canceled") {
    activeRunners.delete(key);
    return;
  }

  useGitAISessionsStore.getState().updateSession(key, {
    status: "generating",
    branchNotice,
  });

  const chatStore = useChatStore.getState();
  chatStore.setChatMode("code");
  chatStore.reset();

  await runSessionChatTurn(key, myNonce, () => chatStore.sendMessage(params.initialPrompt));
}

async function runSessionChatTurn(
  key: string,
  myNonce: number,
  runSend: () => Promise<string | null | undefined>
): Promise<void> {
  activeChatOwnerNonce = myNonce;
  let trackedConvId: string | null = null;
  let trackedReqId: string | null = null;

  const unsubscribe = useChatStore.subscribe((chatState) => {
    if (activeChatOwnerNonce !== myNonce) return;
    const patch: Partial<GitAISession> = {};
    let changed = false;
    if (chatState.conversationId && chatState.conversationId !== trackedConvId) {
      trackedConvId = chatState.conversationId;
      patch.conversationId = chatState.conversationId;
      changed = true;
    }
    if (chatState.activeRequestId && chatState.activeRequestId !== trackedReqId) {
      trackedReqId = chatState.activeRequestId;
      patch.activeRequestId = chatState.activeRequestId;
      changed = true;
    }
    if (changed) {
      useGitAISessionsStore.getState().updateSession(key, patch);
    }
  });

  try {
    const resolvedConvId = await runSend();
    if (activeRunners.get(key) !== myNonce) return;

    const latestSession = useGitAISessionsStore.getState().sessions[key];
    if (latestSession?.status === "canceled") return;

    // If another chat/session took over useChatStore mid-stream, the backend continues
    // running the original request; keep status as "generating" so reconciliation tracks it.
    if (activeChatOwnerNonce !== myNonce) {
      if (resolvedConvId || trackedConvId) {
        useGitAISessionsStore.getState().updateSession(key, {
          conversationId: resolvedConvId || trackedConvId,
          status: "generating",
        });
      }
      return;
    }

    const chatState = useChatStore.getState();
    const finalConvId = resolvedConvId || trackedConvId || chatState.conversationId;
    if (chatState.error) {
      useGitAISessionsStore.getState().updateSession(key, {
        conversationId: finalConvId,
        activeRequestId: null,
        status: "error",
        errorMessage: chatState.error,
      });
    } else if (finalConvId) {
      useGitAISessionsStore.getState().updateSession(key, {
        conversationId: finalConvId,
        activeRequestId: null,
        status: "completed",
        errorMessage: null,
      });
    } else {
      useGitAISessionsStore.getState().updateSession(key, {
        activeRequestId: null,
        status: "error",
        errorMessage: i18n.t("git:aiStudio.agentError"),
      });
    }
  } catch (err: any) {
    if (activeRunners.get(key) !== myNonce) return;
    const latestSession = useGitAISessionsStore.getState().sessions[key];
    if (latestSession?.status === "canceled") return;
    if (activeChatOwnerNonce !== myNonce) return;
    useGitAISessionsStore.getState().updateSession(key, {
      activeRequestId: null,
      status: "error",
      errorMessage: err?.message || i18n.t("git:aiStudio.agentError"),
    });
  } finally {
    unsubscribe();
    if (activeRunners.get(key) === myNonce) {
      activeRunners.delete(key);
    }
  }
}

export async function sendGitAISessionFollowUp(
  key: string,
  conversationId: string,
  text: string,
  parentId?: string
): Promise<void> {
  const myNonce = ++runnerNonceSeq;
  activeRunners.set(key, myNonce);

  const chatStore = useChatStore.getState();
  chatStore.setChatMode("code");
  if (conversationId && chatStore.conversationId !== conversationId) {
    chatStore.switchConversation(conversationId);
  }

  useGitAISessionsStore.getState().updateSession(key, {
    status: "generating",
    errorMessage: null,
  });

  await runSessionChatTurn(key, myNonce, () =>
    chatStore.sendMessage(text, parentId, undefined, conversationId || undefined)
  );
}

export async function cancelGitAISession(key: string): Promise<void> {
  const session = useGitAISessionsStore.getState().sessions[key];
  if (!session) return;

  activeRunners.delete(key);
  useGitAISessionsStore.getState().updateSession(key, {
    status: "canceled",
    activeRequestId: null,
  });

  const chatState = useChatStore.getState();
  if (
    (session.conversationId && chatState.conversationId === session.conversationId) ||
    (!session.conversationId && chatState.isStreaming)
  ) {
    await chatState.cancelGeneration();
    return;
  }

  if (session.conversationId && typeof window !== "undefined") {
    const token = localStorage.getItem("token");
    if (token) {
      try {
        await fetch(`${env.API_URL || ""}/conversations/${session.conversationId}/cancel/`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            ...workspaceHeaders(),
          },
          body: JSON.stringify({}),
        });
      } catch {
        // non-fatal
      }
    }
  }
}

const reconcilingConvIds = new Set<string>();

export async function reconcileGitAISessions(repoKey?: string): Promise<void> {
  const { sessions, updateSession } = useGitAISessionsStore.getState();
  const candidates = Object.values(sessions).filter((s) => {
    if (repoKey && s.repoKey !== repoKey) return false;
    if (!isGitAISessionActiveStatus(s.status)) return false;
    if (activeRunners.has(s.key)) return false;
    return true;
  });

  await Promise.all(
    candidates.map(async (session) => {
      if (!session.conversationId) {
        // Interrupted before backend created a conversation
        updateSession(session.key, { status: "canceled", activeRequestId: null });
        return;
      }
      if (reconcilingConvIds.has(session.conversationId)) return;
      reconcilingConvIds.add(session.conversationId);
      try {
        const { data } = await authedAxios.get<{
          conversation?: {
            active_request?: {
              uuid?: string;
              status?: string;
            } | null;
            messages?: Array<{
              role?: string;
              error?: string | null;
            }>;
          };
        }>(`${env.API_URL || ""}/conversations/${session.conversationId}/`);
        const conv = data?.conversation;
        if (!conv) {
          updateSession(session.key, {
            status: "error",
            activeRequestId: null,
            errorMessage: i18n.t("git:aiStudio.agentError"),
          });
          return;
        }

        const latestSession = useGitAISessionsStore.getState().sessions[session.key];
        if (!latestSession || !isGitAISessionActiveStatus(latestSession.status)) return;

        const activeReq = conv.active_request;
        if (activeReq && (activeReq.status === "pending" || activeReq.status === "processing")) {
          updateSession(session.key, {
            status: "generating",
            activeRequestId: activeReq.uuid || latestSession.activeRequestId,
          });
          return;
        }

        const msgs = conv.messages || [];
        const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
        if (lastAssistant?.error) {
          updateSession(session.key, {
            status: "error",
            activeRequestId: null,
            errorMessage: lastAssistant.error,
          });
        } else if (lastAssistant) {
          updateSession(session.key, {
            status: "completed",
            activeRequestId: null,
            errorMessage: null,
          });
        } else {
          updateSession(session.key, {
            status: "canceled",
            activeRequestId: null,
          });
        }
      } catch (err: any) {
        if (err?.response?.status === 404) {
          updateSession(session.key, {
            status: "canceled",
            activeRequestId: null,
          });
        }
      } finally {
        reconcilingConvIds.delete(session.conversationId);
      }
    })
  );
}

export function useSyncGitAISessions(repoKey?: string) {
  const sessions = useGitAISessionsStore((state) => state.sessions);

  const hasRemoteActiveSessions = Object.values(sessions).some(
    (s) =>
      (!repoKey || s.repoKey === repoKey) &&
      isGitAISessionActiveStatus(s.status) &&
      !activeRunners.has(s.key)
  );

  useEffect(() => {
    if (!hasRemoteActiveSessions) return;
    void reconcileGitAISessions(repoKey);
    const id = window.setInterval(() => {
      void reconcileGitAISessions(repoKey);
    }, 3000);
    return () => window.clearInterval(id);
  }, [repoKey, hasRemoteActiveSessions]);
}

export default useGitAISessionsStore;
