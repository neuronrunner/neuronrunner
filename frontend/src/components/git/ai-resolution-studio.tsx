"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  LuArrowUpRight,
  LuCheck,
  LuChevronDown,
  LuChevronRight,
  LuCircleAlert,
  LuCircleCheck,
  LuExternalLink,
  LuFileCode,
  LuGitBranch,
  LuGitCommitHorizontal,
  LuGitPullRequest,
  LuLoaderCircle,
  LuMessageSquare,
  LuPlay,
  LuRefreshCw,
  LuSend,
  LuSparkles,
  LuSquare,
  LuTerminal,
  LuWrench,
  LuX,
} from "react-icons/lu";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { toaster } from "@/components/ui/toaster";
import { FileDiff } from "@/components/git/file-diff";
import {
  repositoryError,
  repositoryMutation,
  repositoryRequest,
  repositoryUnavailable,
  type PullRequest,
  type RepositoryChange,
  type RepositoryStatus,
} from "@/lib/repository-api";
import { useRouter } from "@/lib/navigation";
import { env } from "@/lib/env";
import useChatStore, { type Message, type ToolCallInfo } from "@/stores/chat";
import useGitAISessionsStore, {
  cancelGitAISession,
  isGitAISessionActiveStatus,
  isGitAISessionRunnerActive,
  sendGitAISessionFollowUp,
  type AIStudioMode,
} from "@/stores/git-ai-sessions";
import useWorkspaceTabsStore from "@/stores/workspace-tabs";
import { formatToolName } from "@/components/chat/tool-status";
import { mergeRequestUpdateMessage } from "@/components/chat/normalize-tool-calls";
import { cn } from "@/lib/utils";

export type { AIStudioMode };

export interface AIResolutionStudioProps {
  sessionKey: string;
  mode: AIStudioMode;
  vmUuid: string;
  repoPath: string;
  repoName: string;
  initialPrompt: string;
  targetBranch?: string;
  createBranchIfMissing?: boolean;
  baseBranch?: string;
  defaultCommitMessage: string;
  defaultPrTitle?: string;
  defaultPrBodyPrefix?: string;
  issueNumber?: number;
  pullNumber?: number;
  onClose: () => void;
  onRerun?: () => void;
  onSuccessRefresh?: () => void;
}

const statusBadgeStyles: Record<RepositoryChange["status"], string> = {
  modified: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  added: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  deleted: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
  renamed: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  untracked: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  conflict: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
};

const statusShortCode: Record<RepositoryChange["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflict: "!",
};

function summarizeToolArg(args: string | Record<string, unknown>): string {
  try {
    const parsed = typeof args === "string" ? JSON.parse(args) : args;
    if (!parsed || typeof parsed !== "object") return "";
    const obj = parsed as Record<string, unknown>;
    const target =
      obj.path ||
      obj.file_path ||
      obj.filepath ||
      obj.filename ||
      obj.command ||
      obj.cmd ||
      obj.query ||
      obj.pattern;
    if (typeof target === "string" && target.trim()) {
      const clean = target.trim();
      return clean.length > 72 ? `${clean.slice(0, 69)}…` : clean;
    }
  } catch {
    // ignore parse errors
  }
  return "";
}

export function AIResolutionStudio({
  sessionKey,
  mode,
  vmUuid,
  repoPath,
  repoName,
  initialPrompt,
  targetBranch,
  createBranchIfMissing = false,
  baseBranch,
  defaultCommitMessage,
  defaultPrTitle,
  defaultPrBodyPrefix,
  issueNumber,
  pullNumber,
  onClose,
  onRerun,
  onSuccessRefresh,
}: AIResolutionStudioProps) {
  const { t } = useTranslation("git");
  const router = useRouter();
  const session = useGitAISessionsStore((state) => state.sessions[sessionKey]);
  const targetConversationId = session?.conversationId || null;

  const chatConversationId = useChatStore((state) => state.conversationId);
  const storeMessages = useChatStore((state) => state.messages);
  const storeCurrentMessage = useChatStore((state) => state.currentMessage);
  const storeIsStreaming = useChatStore((state) => state.isStreaming);
  const storeChatError = useChatStore((state) => state.error);
  const storeActiveRequestId = useChatStore((state) => state.activeRequestId);
  const isActivelyGenerating = useChatStore((state) => state.isActivelyGenerating);
  const abortController = useChatStore((state) => state.abortController);
  const conversationCache = useChatStore((state) => state.conversationCache);
  const fetchConversation = useChatStore((state) => state.fetchConversation);

  const [loadingSession, setLoadingSession] = useState(false);
  const [repoStatus, setRepoStatus] = useState<RepositoryStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [diffRevision, setDiffRevision] = useState(0);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [toolsExpanded, setToolsExpanded] = useState(true);
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState("");
  const [commitMessage, setCommitMessage] = useState(defaultCommitMessage);
  const [prTitle, setPrTitle] = useState(defaultPrTitle || defaultCommitMessage);
  const [gitBusy, setGitBusy] = useState<"branch" | "commit" | "push" | "pr" | null>(null);
  const [gitError, setGitError] = useState<string | null>(null);
  const [localBranchNotice, setLocalBranchNotice] = useState<string | null>(null);
  const [localCreatedPr, setLocalCreatedPr] = useState<PullRequest | null>(null);
  const [localPushedSuccess, setLocalPushedSuccess] = useState(false);

  const createdPr = session?.createdPr ?? localCreatedPr;
  const pushedSuccess = Boolean(session?.pushedSuccess || localPushedSuccess);
  const branchNotice = localBranchNotice || session?.branchNotice || null;

  const runnerActive = isGitAISessionRunnerActive(sessionKey);
  const isMatchingChat = Boolean(
    (targetConversationId && chatConversationId === targetConversationId) ||
      (!targetConversationId && runnerActive && !chatConversationId)
  );
  const cachedEntry = targetConversationId ? conversationCache?.[targetConversationId] : undefined;
  const isSessionActive = isGitAISessionActiveStatus(session?.status);
  const preparingBranch = session?.status === "preparing";

  const messages = useMemo(
    () => (isMatchingChat ? storeMessages : cachedEntry?.messages || []),
    [isMatchingChat, storeMessages, cachedEntry?.messages]
  );
  const currentMessage = isMatchingChat ? storeCurrentMessage : cachedEntry?.currentMessage || null;
  const isStreaming = isMatchingChat ? storeIsStreaming : Boolean(cachedEntry?.isStreaming || isSessionActive);
  const chatError = (isMatchingChat ? storeChatError : null) || session?.errorMessage || null;
  const effectiveConversationId = targetConversationId || (isMatchingChat ? chatConversationId : null);
  const effectiveActiveRequestId =
    (isMatchingChat ? storeActiveRequestId : cachedEntry?.activeRequestId) || session?.activeRequestId || null;

  const prevStreamingRef = useRef(isStreaming);
  const rootRef = useRef<HTMLElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const isReviewMode = mode === "issue-review" || mode === "pr-review";
  const [hydratedConvId, setHydratedConvId] = useState<string | null>(null);

  // Bring the studio into view when it opens
  useEffect(() => {
    rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [sessionKey]);

  useEffect(() => {
    setCommitMessage(defaultCommitMessage);
  }, [defaultCommitMessage]);

  useEffect(() => {
    setPrTitle(defaultPrTitle || defaultCommitMessage);
  }, [defaultPrTitle, defaultCommitMessage]);

  useEffect(() => {
    setLocalBranchNotice(null);
    setLocalCreatedPr(null);
    setLocalPushedSuccess(false);
    setGitError(null);
  }, [sessionKey]);

  const refreshRepoStatus = useCallback(async () => {
    if (!vmUuid || !repoPath) return;
    setStatusLoading(true);
    try {
      const status = await repositoryRequest<RepositoryStatus>(vmUuid, "git/repository", { path: repoPath });
      setRepoStatus(status);
      setDiffRevision((v) => v + 1);
    } catch (err) {
      if (!repositoryUnavailable(err)) {
        // non-fatal during streaming
      }
    } finally {
      setStatusLoading(false);
    }
  }, [vmUuid, repoPath]);

  // Hydrate conversation from backend when reopening an existing/reloaded session
  useEffect(() => {
    if (!targetConversationId) {
      void refreshRepoStatus();
      return;
    }

    const chatStore = useChatStore.getState();
    const alreadyCached = Boolean(chatStore.conversationCache?.[targetConversationId]?.messages?.length);
    const alreadyLive =
      chatStore.conversationId === targetConversationId &&
      (chatStore.messages.length > 0 || isGitAISessionRunnerActive(sessionKey));

    if (!alreadyLive) {
      if (chatStore.conversationId !== targetConversationId) {
        chatStore.switchConversation(targetConversationId);
      }
      setLoadingSession(!alreadyCached);
      void fetchConversation(targetConversationId, { silent: alreadyCached }).finally(() => {
        setLoadingSession(false);
        setHydratedConvId(targetConversationId);
      });
    } else {
      setHydratedConvId(targetConversationId);
    }
    void refreshRepoStatus();
  }, [sessionKey, targetConversationId, fetchConversation, refreshRepoStatus]);

  // Reconnect WebSocket + 2s polling when viewing an active backend request (e.g. after browser reload)
  useEffect(() => {
    if (!targetConversationId || !isStreaming) return;
    if (isGitAISessionRunnerActive(sessionKey) && isMatchingChat && isActivelyGenerating) return;
    if (isMatchingChat && abortController) return;

    const authToken = typeof window !== "undefined" ? localStorage.getItem("token") : null;
    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const handleTerminalStatus = (nextStatus: "completed" | "error" | "canceled", errMsg?: string | null) => {
      if (stopped) return;
      stopped = true;
      useChatStore.getState().setConversationGenerating(targetConversationId, false);
      useGitAISessionsStore.getState().updateSession(sessionKey, {
        status: nextStatus,
        activeRequestId: null,
        errorMessage: errMsg || null,
      });
      void fetchConversation(targetConversationId, { silent: true });
      void refreshRepoStatus();
    };

    if (effectiveActiveRequestId && authToken) {
      const API_BASE = env.API_URL || (typeof window !== "undefined" ? window.location.origin : "");
      const wsBase = API_BASE.replace(/^https/, "wss").replace(/^http/, "ws");
      const wsUrl = `${wsBase}/ws/chat/request/${effectiveActiveRequestId}/`;

      const connect = () => {
        if (stopped) return;
        ws = new WebSocket(wsUrl);
        const socket = ws;
        socket.onopen = () => socket.send(JSON.stringify({ type: "auth", token: authToken }));

        socket.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type !== "request_update" || !msg.request) return;
            const requestData = msg.request;
            const status = requestData.status;
            const partialContent = requestData.partial_content ?? "";
            const partialThinking = requestData.partial_thinking ?? "";
            const parentId = requestData.parent_uuid ?? null;
            const modelType = requestData.model_type === "image" ? "image" : "text";

            if ((status === "processing" || status === "pending") && modelType === "text") {
              useChatStore.getState().setConversationGenerating(targetConversationId, true);
              const store = useChatStore.getState();
              if (store.conversationId === targetConversationId && !store.isActivelyGenerating && !store.abortController) {
                const phases = requestData.phases || [];
                const toolCalls = requestData.tool_calls || [];
                if (partialContent || partialThinking || phases.length || toolCalls.length) {
                  useChatStore.setState((state) => ({
                    isStreaming: true,
                    useModelStartingLoading: false,
                    currentMessage: mergeRequestUpdateMessage(state.currentMessage, requestData),
                  }));
                }
              }
            } else if (status === "completed") {
              handleTerminalStatus("completed");
              socket.close();
            } else if (status === "failed") {
              handleTerminalStatus("error", requestData.error || t("aiStudio.agentError"));
              socket.close();
            } else if (status === "canceled") {
              handleTerminalStatus("canceled");
              socket.close();
            }
          } catch {
            // ignore malformed frames
          }
        };

        socket.onclose = (event) => {
          if (!stopped && event.code !== 1000 && event.code !== 1001) {
            reconnectTimeout = setTimeout(connect, 3000);
          }
        };
      };

      connect();
    }

    const pollInterval = setInterval(() => {
      const store = useChatStore.getState();
      if (store.conversationId === targetConversationId && !store.isActivelyGenerating && !store.abortController) {
        void fetchConversation(targetConversationId, { silent: true });
      }
    }, 2000);

    return () => {
      stopped = true;
      clearInterval(pollInterval);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) ws.close();
    };
  }, [
    targetConversationId,
    effectiveActiveRequestId,
    isStreaming,
    isMatchingChat,
    isActivelyGenerating,
    abortController,
    sessionKey,
    fetchConversation,
    refreshRepoStatus,
    t,
  ]);

  // Keep persisted session status aligned with hydrated chat store once background request finishes
  useEffect(() => {
    if (!targetConversationId || hydratedConvId !== targetConversationId) return;
    if (!isMatchingChat || isGitAISessionRunnerActive(sessionKey)) return;
    if (storeIsStreaming || loadingSession || useChatStore.getState().isLoading) return;
    if (!isSessionActive) return;

    const lastAssistant = [...storeMessages].reverse().find((m) => m.role === "assistant");
    if (storeChatError || lastAssistant?.error) {
      useGitAISessionsStore.getState().updateSession(sessionKey, {
        status: "error",
        activeRequestId: null,
        errorMessage: storeChatError || lastAssistant?.error || t("aiStudio.agentError"),
      });
    } else if (lastAssistant) {
      useGitAISessionsStore.getState().updateSession(sessionKey, {
        status: "completed",
        activeRequestId: null,
        errorMessage: null,
      });
    } else {
      useGitAISessionsStore.getState().updateSession(sessionKey, {
        status: "canceled",
        activeRequestId: null,
      });
    }
  }, [
    sessionKey,
    targetConversationId,
    isMatchingChat,
    storeIsStreaming,
    storeMessages,
    storeChatError,
    isSessionActive,
    loadingSession,
    hydratedConvId,
    t,
  ]);

  // Periodically refresh git status when tool calls complete or streaming ends
  const activeToolCallsCount = useMemo(() => {
    const currentCalls = currentMessage?.tool_calls?.filter((t) => t.status === "done").length || 0;
    const msgCalls = messages.reduce(
      (acc, m) => acc + (m.tool_calls?.filter((t) => t.status === "done").length || 0),
      0
    );
    return currentCalls + msgCalls;
  }, [currentMessage?.tool_calls, messages]);

  useEffect(() => {
    if (activeToolCallsCount === 0 && prevStreamingRef.current === isStreaming) return;
    prevStreamingRef.current = isStreaming;
    void refreshRepoStatus();
  }, [activeToolCallsCount, isStreaming, refreshRepoStatus]);

  const assistantMessages = useMemo(
    () => messages.filter((m) => m.role === "assistant"),
    [messages]
  );

  const allToolCalls = useMemo(() => {
    const list: ToolCallInfo[] = [];
    for (const msg of messages) {
      if (msg.tool_calls) list.push(...msg.tool_calls);
    }
    if (currentMessage?.tool_calls) {
      for (const tc of currentMessage.tool_calls) {
        if (!list.some((existing) => existing.id === tc.id)) {
          list.push(tc);
        }
      }
    }
    return list;
  }, [messages, currentMessage?.tool_calls]);

  const activePhaseLabel = useMemo(() => {
    if (preparingBranch) return t("aiStudio.preparingBranch", { branch: targetBranch || "" });
    if (!isStreaming) return null;
    const callingTool = currentMessage?.tool_calls?.find((tc) => tc.status === "calling");
    if (callingTool) {
      const argPreview = summarizeToolArg(callingTool.arguments);
      return `${callingTool.title || formatToolName(callingTool.name)}${argPreview ? `: ${argPreview}` : ""}`;
    }
    const phases = currentMessage?.phases || [];
    for (let i = phases.length - 1; i >= 0; i--) {
      if (phases[i].streaming || phases[i].type === "thinking") {
        return phases[i].label || t("aiStudio.analyzingCodebase");
      }
    }
    if (mode === "pr-review" || mode === "issue-review") {
      return t("aiStudio.generatingReview");
    }
    return t("aiStudio.workingOnSolution");
  }, [preparingBranch, isStreaming, targetBranch, currentMessage, mode, t]);

  const handleSendFollowUp = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = followUp.trim();
    if (!text || isStreaming) return;
    setFollowUp("");
    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    await sendGitAISessionFollowUp(
      sessionKey,
      effectiveConversationId || "",
      text,
      lastAssistant?.uuid
    );
    await refreshRepoStatus();
  };

  const handleStop = () => {
    void cancelGitAISession(sessionKey);
  };

  const handleOpenInChat = () => {
    if (effectiveConversationId) {
      useWorkspaceTabsStore
        .getState()
        .openChatTab(effectiveConversationId, issueNumber ? t("aiStudio.chatTabIssue", { number: issueNumber }) : t("aiStudio.chatTabPr", { number: pullNumber }), "left");
      router.push(`/chat/${effectiveConversationId}`);
    } else {
      router.push("/new");
    }
  };

  const handleSwitchTargetBranch = async () => {
    if (!targetBranch || !vmUuid || !repoPath) return;
    setGitBusy("branch");
    setGitError(null);
    try {
      const status = await repositoryMutation<RepositoryStatus>(vmUuid, "git/switch", {
        path: repoPath,
        branch: targetBranch,
        create: createBranchIfMissing,
        fetch: !createBranchIfMissing,
      });
      setRepoStatus(status);
      const msg = t("aiStudio.switchedToBranch", { branch: status.branch });
      setLocalBranchNotice(msg);
      useGitAISessionsStore.getState().updateSession(sessionKey, { branchNotice: msg });
    } catch (err) {
      setGitError(repositoryError(err));
    } finally {
      setGitBusy(null);
    }
  };

  const handleCommitOnly = async () => {
    if (!vmUuid || !repoPath || !commitMessage.trim()) return;
    setGitBusy("commit");
    setGitError(null);
    try {
      const status = await repositoryMutation<RepositoryStatus>(vmUuid, "git/commit", {
        path: repoPath,
        message: commitMessage.trim(),
      });
      setRepoStatus(status);
      toaster.create({
        title: t("aiStudio.commitSuccessTitle"),
        description: t("aiStudio.commitSuccessDesc", { sha: status.head_commit.slice(0, 7), branch: status.branch }),
        type: "success",
      });
    } catch (err) {
      setGitError(repositoryError(err));
    } finally {
      setGitBusy(null);
    }
  };

  const handleCommitAndPush = async () => {
    if (!vmUuid || !repoPath) return;
    setGitBusy("push");
    setGitError(null);
    setLocalPushedSuccess(false);
    try {
      let currentStatus = repoStatus;
      if (currentStatus && currentStatus.files.length > 0) {
        if (!commitMessage.trim()) {
          setGitError(t("aiStudio.commitMessageRequired"));
          setGitBusy(null);
          return;
        }
        currentStatus = await repositoryMutation<RepositoryStatus>(vmUuid, "git/commit", {
          path: repoPath,
          message: commitMessage.trim(),
        });
        setRepoStatus(currentStatus);
      }
      const pushedStatus = await repositoryMutation<RepositoryStatus>(vmUuid, "git/push", {
        path: repoPath,
        branch: currentStatus?.branch || targetBranch,
      });
      setRepoStatus(pushedStatus);
      setLocalPushedSuccess(true);
      useGitAISessionsStore.getState().updateSession(sessionKey, { pushedSuccess: true });
      toaster.create({
        title: t("aiStudio.pushSuccessTitle"),
        description: t("aiStudio.pushSuccessDesc", { branch: pushedStatus.branch }),
        type: "success",
      });
      onSuccessRefresh?.();
    } catch (err) {
      setGitError(repositoryError(err));
    } finally {
      setGitBusy(null);
    }
  };

  const handleCommitPushAndCreatePR = async () => {
    if (!vmUuid || !repoPath) return;
    setGitBusy("pr");
    setGitError(null);
    try {
      let currentStatus = repoStatus;
      // 1. Ensure we're on a feature/fix branch if currently on main/master
      const activeBranch = currentStatus?.branch || "";
      if (targetBranch && (activeBranch === "main" || activeBranch === "master" || activeBranch === baseBranch)) {
        currentStatus = await repositoryMutation<RepositoryStatus>(vmUuid, "git/switch", {
          path: repoPath,
          branch: targetBranch,
          create: true,
        });
        setRepoStatus(currentStatus);
      }

      // 2. Commit if there are uncommitted changes
      if (currentStatus && currentStatus.files.length > 0) {
        const msg = commitMessage.trim() || defaultCommitMessage;
        currentStatus = await repositoryMutation<RepositoryStatus>(vmUuid, "git/commit", {
          path: repoPath,
          message: msg,
        });
        setRepoStatus(currentStatus);
      }

      const branchToPush = currentStatus?.branch || targetBranch || "fix/ai-resolution";

      // 3. Push branch to origin
      const pushedStatus = await repositoryMutation<RepositoryStatus>(vmUuid, "git/push", {
        path: repoPath,
        branch: branchToPush,
      });
      setRepoStatus(pushedStatus);

      // 4. Create Pull Request on GitHub
      const lastSummary =
        assistantMessages[assistantMessages.length - 1]?.content?.trim() ||
        "Automated resolution generated by Neuron Runner AI.";
      const bodyParts = [
        defaultPrBodyPrefix || (issueNumber ? `Closes #${issueNumber}` : ""),
        "### AI Resolution Summary",
        lastSummary.slice(0, 4000),
      ].filter(Boolean);

      const prResponse = await repositoryMutation<{ repository: string; pull_request: PullRequest }>(
        vmUuid,
        "github/pull-requests",
        {
          path: repoPath,
          title: prTitle.trim() || defaultPrTitle || commitMessage.trim() || defaultCommitMessage,
          body: bodyParts.join("\n\n"),
          head: branchToPush,
          base: baseBranch || "",
        }
      );

      setLocalCreatedPr(prResponse.pull_request);
      useGitAISessionsStore.getState().updateSession(sessionKey, { createdPr: prResponse.pull_request });
      toaster.create({
        title: t("aiStudio.prCreatedTitle", { number: prResponse.pull_request.number }),
        description: prResponse.pull_request.title,
        type: "success",
      });
      onSuccessRefresh?.();
    } catch (err) {
      setGitError(repositoryError(err));
    } finally {
      setGitBusy(null);
    }
  };

  const changedFiles = repoStatus?.files || [];
  const hasUncommittedChanges = changedFiles.length > 0;
  const hasUnpushedCommits = (repoStatus?.ahead ?? 0) > 0;
  const latestStreamingContent = currentMessage?.content || "";

  // Follow the agent output while streaming, unless the user scrolled up
  useEffect(() => {
    const el = outputRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [latestStreamingContent, assistantMessages.length, allToolCalls.length]);

  const studioTitle =
    mode === "issue-solve"
      ? t("aiStudio.title.issueSolve", { number: issueNumber })
      : mode === "issue-review"
        ? t("aiStudio.title.issueReview", { number: issueNumber })
        : mode === "pr-review"
          ? t("aiStudio.title.prReview", { number: pullNumber })
          : mode === "pr-fix-ci"
            ? t("aiStudio.title.prFixCi", { number: pullNumber })
            : t("aiStudio.title.prAssistant", { number: pullNumber });

  return (
    <section
      ref={rootRef}
      aria-label={studioTitle}
      className="scroll-mt-4 overflow-hidden rounded-2xl border border-indigo-500/25 bg-card shadow-lg shadow-indigo-500/5 ring-1 ring-indigo-500/10"
    >
      {/* Top Studio Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-gradient-to-r from-indigo-500/10 via-purple-500/5 to-transparent px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-xs">
            {isStreaming || preparingBranch ? (
              <LuLoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <LuSparkles className="h-4 w-4" />
            )}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-foreground">{studioTitle}</h3>
              {repoStatus?.branch && (
                <span className="inline-flex items-center gap-1 rounded-md border border-border bg-background/80 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                  <LuGitBranch className="h-3 w-3 text-indigo-500" />
                  {repoStatus.branch}
                </span>
              )}
              {targetBranch && repoStatus?.branch && repoStatus.branch !== targetBranch && !isStreaming && (
                <button
                  type="button"
                  disabled={!!gitBusy}
                  onClick={handleSwitchTargetBranch}
                  className="inline-flex items-center gap-1 rounded-md bg-indigo-500/10 px-2 py-0.5 text-[11px] font-medium text-indigo-600 transition-colors hover:bg-indigo-500/20 dark:text-indigo-400"
                >
                  {t("aiStudio.switchToBranch", { branch: targetBranch })}
                </button>
              )}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {activePhaseLabel ? (
                <span className="text-indigo-600 dark:text-indigo-400 font-medium">{activePhaseLabel}</span>
              ) : hasUncommittedChanges ? (
                changedFiles.length === 1
                  ? t("aiStudio.filesModifiedReadyOne", { count: changedFiles.length, repo: repoName })
                  : t("aiStudio.filesModifiedReadyOther", { count: changedFiles.length, repo: repoName })
              ) : branchNotice ? (
                branchNotice
              ) : (
                t("aiStudio.connectedToRepo", { repo: repoName })
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {isStreaming || preparingBranch ? (
            <Button
              variant="outline"
              size="sm"
              onClick={handleStop}
              className="h-7 gap-1.5 border-rose-500/30 bg-rose-500/10 px-2.5 text-xs text-rose-600 hover:bg-rose-500/20 dark:text-rose-400"
            >
              <LuSquare className="h-3 w-3 fill-current" />
              <span>{t("aiStudio.stop")}</span>
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void refreshRepoStatus()}
                disabled={statusLoading}
                title={t("aiStudio.refreshStatusTitle")}
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              >
                <LuRefreshCw className={cn("h-3.5 w-3.5", statusLoading && "animate-spin")} />
              </Button>
              {onRerun && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onRerun}
                  title={t("aiStudio.rerunTitle")}
                  className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                >
                  <LuPlay className="h-3 w-3" />
                  <span className="hidden sm:inline">{t("aiStudio.rerun")}</span>
                </Button>
              )}
            </>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={handleOpenInChat}
            title={t("aiStudio.openFullChatTitle")}
            className="h-7 gap-1 px-2.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <LuMessageSquare className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t("aiStudio.fullChat")}</span>
            <LuArrowUpRight className="h-3 w-3" />
          </Button>

          <button
            type="button"
            onClick={onClose}
            aria-label={t("aiStudio.closeAriaLabel")}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <LuX className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Live Tool Execution Timeline */}
      {allToolCalls.length > 0 && (
        <div className="border-b border-border bg-muted/15 px-4 py-2.5 sm:px-5">
          <button
            type="button"
            onClick={() => setToolsExpanded((v) => !v)}
            className="flex w-full items-center justify-between gap-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <span className="flex items-center gap-2">
              {toolsExpanded ? <LuChevronDown className="h-3.5 w-3.5" /> : <LuChevronRight className="h-3.5 w-3.5" />}
              <LuWrench className="h-3.5 w-3.5 text-indigo-500" />
              <span>
                {t("aiStudio.agentActions", {
                  done: allToolCalls.filter((t) => t.status === "done").length,
                  total: allToolCalls.length,
                })}
              </span>
            </span>
            {allToolCalls.some((t) => t.status === "calling") && (
              <span className="inline-flex items-center gap-1 text-[11px] text-indigo-600 dark:text-indigo-400">
                <LuLoaderCircle className="h-3 w-3 animate-spin" />
                {t("aiStudio.executing")}
              </span>
            )}
          </button>

          {toolsExpanded && (
            <div className="mt-2 max-h-48 space-y-1 overflow-y-auto pr-1">
              {allToolCalls.map((tc) => {
                const argSummary = summarizeToolArg(tc.arguments);
                const isExpanded = expandedToolId === tc.id;
                const outputPreview = tc.output || tc.result;
                return (
                  <div key={tc.id} className="rounded-lg border border-border/60 bg-background/80 text-xs">
                    <button
                      type="button"
                      onClick={() => setExpandedToolId(isExpanded ? null : tc.id)}
                      className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        {tc.status === "calling" ? (
                          <LuLoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-indigo-500" />
                        ) : tc.status === "error" ? (
                          <LuCircleAlert className="h-3.5 w-3.5 shrink-0 text-rose-500" />
                        ) : (
                          <LuCircleCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                        )}
                        <span className="font-medium text-foreground">
                          {tc.title || formatToolName(tc.name)}
                        </span>
                        {argSummary && (
                          <span className="truncate font-mono text-[11px] text-muted-foreground">
                            {argSummary}
                          </span>
                        )}
                      </div>
                      {outputPreview && (
                        <LuChevronRight
                          className={cn(
                            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                            isExpanded && "rotate-90"
                          )}
                        />
                      )}
                    </button>
                    {isExpanded && outputPreview && (
                      <pre className="max-h-40 overflow-auto border-t border-border/50 bg-muted/30 p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                        {typeof outputPreview === "string"
                          ? outputPreview.slice(0, 2000)
                          : JSON.stringify(outputPreview, null, 2)}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Main Agent Output / Conversation Turns */}
      <div
        ref={outputRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="max-h-[min(460px,60vh)] min-h-[96px] space-y-4 overflow-y-auto overscroll-contain p-4 sm:p-5"
      >
        {chatError && (
          <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
            <LuCircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">{t("aiStudio.agentError")}</p>
              <p className="mt-0.5 opacity-90">{chatError}</p>
            </div>
          </div>
        )}

        {assistantMessages.map((msg, idx) => (
          <div key={msg.uuid || idx} className="space-y-2">
            {idx > 0 && (
              <div className="flex items-center gap-2 pt-2 text-[11px] font-medium text-muted-foreground">
                <LuSparkles className="h-3 w-3 text-indigo-500" />
                <span>{t("aiStudio.followUpResponse", { number: idx + 1 })}</span>
              </div>
            )}
            {msg.content ? (
              <div className="markdown-body prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
              </div>
            ) : null}
          </div>
        ))}

        {isStreaming && latestStreamingContent && !assistantMessages.some((m) => m.content === latestStreamingContent) && (
          <div className="markdown-body prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{latestStreamingContent}</ReactMarkdown>
          </div>
        )}

        {(isStreaming || loadingSession || preparingBranch) &&
          !latestStreamingContent &&
          assistantMessages.length === 0 &&
          allToolCalls.length === 0 && (
            <div className="flex items-center gap-3 py-6 text-xs text-muted-foreground">
              <LuLoaderCircle className="h-4 w-4 animate-spin text-indigo-500" />
              <span>
                {loadingSession
                  ? t("aiStudio.loadingSession")
                  : mode === "pr-review" || mode === "issue-review"
                    ? t("aiStudio.generatingReview")
                    : t("aiStudio.inspectingFiles")}
              </span>
            </div>
          )}
      </div>

      {/* Live Workspace File Changes & Inline Diff Inspector */}
      {hasUncommittedChanges && !isReviewMode && (
        <div className="border-t border-border bg-muted/10 px-4 py-3.5 sm:px-5">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <LuFileCode className="h-4 w-4 text-indigo-500" />
              <h4 className="text-xs font-semibold text-foreground">
                {t("aiStudio.modifiedFiles", { count: changedFiles.length })}
              </h4>
            </div>
            <span className="text-[11px] text-muted-foreground">{t("aiStudio.clickToInspectDiff")}</span>
          </div>

          <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border bg-card">
            {changedFiles.map((file) => {
              const isOpen = expandedFile === file.path;
              return (
                <li key={file.path}>
                  <div className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-muted/40">
                    <button
                      type="button"
                      onClick={() => setExpandedFile(isOpen ? null : file.path)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs"
                    >
                      <LuChevronRight
                        className={cn(
                          "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                          isOpen && "rotate-90"
                        )}
                      />
                      <span
                        className={cn(
                          "flex h-4 w-4 shrink-0 items-center justify-center rounded font-mono text-[10px] font-semibold",
                          statusBadgeStyles[file.status]
                        )}
                      >
                        {statusShortCode[file.status]}
                      </span>
                      <span className="truncate font-mono text-xs font-medium text-foreground">
                        {file.path}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        useWorkspaceTabsStore.getState().openFileTab({
                          uuid: `${repoPath}/${file.path}`,
                          path: `${repoPath}/${file.path}`,
                        })
                      }
                      title={t("aiStudio.openInEditorTitle")}
                      className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <span>{t("aiStudio.editor")}</span>
                      <LuExternalLink className="h-3 w-3" />
                    </button>
                  </div>
                  {isOpen && (
                    <FileDiff
                      uuid={vmUuid}
                      path={repoPath}
                      file={file.path}
                      revision={diffRevision}
                      mode="all"
                      onRepositoryUnavailable={() => {}}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Created Pull Request Banner */}
      {createdPr && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-emerald-500/30 bg-emerald-500/10 px-4 py-3 sm:px-5">
          <div className="flex items-center gap-2.5">
            <LuGitPullRequest className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <div className="text-xs">
              <p className="font-semibold text-emerald-700 dark:text-emerald-300">
                {t("aiStudio.prOpenedBanner", { number: createdPr.number })}
              </p>
              <p className="text-emerald-600/90 dark:text-emerald-400/90">{createdPr.title}</p>
            </div>
          </div>
          <a
            href={createdPr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-xs transition-colors hover:bg-emerald-700"
          >
            <span>{t("aiStudio.viewPr", { number: createdPr.number })}</span>
            <LuExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      )}

      {/* Pushed Banner for PR Mode */}
      {pushedSuccess && !createdPr && (
        <div className="flex items-center justify-between gap-3 border-t border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-xs text-emerald-700 dark:text-emerald-300 sm:px-5">
          <span className="flex items-center gap-2 font-medium">
            <LuCheck className="h-4 w-4" />
            <span>
              <Trans
                i18nKey="aiStudio.pushedBanner"
                ns="git"
                values={{ branch: repoStatus?.branch || "" }}
                components={{ code: <code className="font-mono" /> }}
              />
            </span>
          </span>
        </div>
      )}

      {/* One-Click Git Commit / Push / Create PR Action Bar */}
      {!isStreaming && !isReviewMode && (hasUncommittedChanges || hasUnpushedCommits) && !createdPr && (
        <div className="space-y-3 border-t border-border bg-muted/25 px-4 py-3.5 sm:px-5">
          {gitError && (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <LuCircleAlert className="h-3.5 w-3.5 shrink-0" />
              <span>{gitError}</span>
            </div>
          )}

          <div className="grid gap-2.5 sm:grid-cols-2">
            {hasUncommittedChanges && (
              <div>
                <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                  {t("aiStudio.commitMessageLabel")}
                </label>
                <input
                  type="text"
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  placeholder={t("aiStudio.commitMessagePlaceholder")}
                  className="h-8 w-full rounded-lg border border-border bg-background px-2.5 text-xs outline-none focus:border-indigo-500"
                />
              </div>
            )}

            {mode === "issue-solve" && (
              <div>
                <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                  {t("aiStudio.prTitleLabel")}
                </label>
                <input
                  type="text"
                  value={prTitle}
                  onChange={(e) => setPrTitle(e.target.value)}
                  placeholder={t("aiStudio.prTitlePlaceholder")}
                  className="h-8 w-full rounded-lg border border-border bg-background px-2.5 text-xs outline-none focus:border-indigo-500"
                />
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            {hasUncommittedChanges && (
              <Button
                variant="outline"
                size="sm"
                disabled={!!gitBusy || !commitMessage.trim()}
                onClick={handleCommitOnly}
                className="h-8 gap-1.5 text-xs"
              >
                {gitBusy === "commit" ? (
                  <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <LuGitCommitHorizontal className="h-3.5 w-3.5" />
                )}
                <span>{t("aiStudio.commitLocally")}</span>
              </Button>
            )}

            {mode === "issue-solve" ? (
              <Button
                size="sm"
                disabled={!!gitBusy}
                onClick={handleCommitPushAndCreatePR}
                className="h-8 gap-1.5 bg-gradient-to-r from-indigo-500 to-purple-600 text-xs text-white hover:from-indigo-600 hover:to-purple-700"
              >
                {gitBusy === "pr" ? (
                  <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <LuGitPullRequest className="h-3.5 w-3.5" />
                )}
                <span>{hasUncommittedChanges ? t("aiStudio.commitPushOpenPr") : t("aiStudio.pushOpenPr")}</span>
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={!!gitBusy}
                onClick={handleCommitAndPush}
                className="h-8 gap-1.5 bg-gradient-to-r from-indigo-500 to-purple-600 text-xs text-white hover:from-indigo-600 hover:to-purple-700"
              >
                {gitBusy === "push" ? (
                  <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <LuGitBranch className="h-3.5 w-3.5" />
                )}
                <span>
                  {hasUncommittedChanges
                    ? t("aiStudio.commitAndPushPr", { number: pullNumber })
                    : t("aiStudio.pushPr", { number: pullNumber })}
                </span>
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Inline Follow-Up Input Bar */}
      <form
        onSubmit={handleSendFollowUp}
        className="flex items-center gap-2 border-t border-border bg-muted/15 px-4 py-2.5 sm:px-5"
      >
        <input
          type="text"
          value={followUp}
          onChange={(e) => setFollowUp(e.target.value)}
          disabled={isStreaming}
          placeholder={
            isStreaming
              ? t("aiStudio.followUpPlaceholderBusy")
              : t("aiStudio.followUpPlaceholder")
          }
          className="h-8 flex-1 rounded-lg border border-border bg-background px-3 text-xs outline-none transition-colors focus:border-indigo-500 disabled:opacity-50"
        />
        <Button
          type="submit"
          size="sm"
          disabled={isStreaming || !followUp.trim()}
          className="h-8 gap-1.5 px-3 text-xs"
        >
          <LuSend className="h-3.5 w-3.5" />
          <span>{t("aiStudio.send")}</span>
        </Button>
      </form>
    </section>
  );
}
