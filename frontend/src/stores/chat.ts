import { env } from "@/lib/env";
import { workspaceHeaders, notifyInsufficientBalanceIfNeeded } from "@/lib/axios";
import OpenAI from "openai";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import useSidebarStore from "./sidebar";
import useSandboxProjectsStore from "./sandbox-projects";
import useWorkspaceTabsStore from "./workspace-tabs";
import frontendExtension from "@cloud";
import { DEFAULT_PLATFORM_MODELS } from "@/lib/default-models";
import useModelStore from "./search-models";
import useRecentModelsStore from "./recent-models";
import {
  extractModelKey,
  getModelReasoningSpec,
  isReasoningTier,
  resolveModelReasoningTier,
  type ReasoningMode,
  type ReasoningTier,
} from "@/lib/reasoning";
import { toaster } from "@/components/ui/toaster";
import { terminalOutputText } from "@/components/chat/terminal-output";
import { hasToolResult, toolResultStatus, serializeToolResult, formatToolName } from "@/components/chat/tool-status";
import { normalizeToolCalls } from "@/components/chat/normalize-tool-calls";
import i18n from "@/i18n";

const fileToDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

const findKnownModelRecord = (modelIdentifier?: string) => {
  const key = extractModelKey(modelIdentifier).toLowerCase();
  if (!key) return undefined;
  const recentModels = useRecentModelsStore.getState?.().recentModels || [];
  const searchModels = useModelStore.getState?.().models || [];
  return (
    recentModels.find((m: any) => extractModelKey(m?.name).toLowerCase() === key) ||
    searchModels.find((m) => extractModelKey(m?.name).toLowerCase() === key) ||
    DEFAULT_PLATFORM_MODELS.find((m) => extractModelKey(m?.name).toLowerCase() === key)
  );
};

const INITIAL_DEFAULT_MODEL = "deepseek-v4.1-flash-1017";
const INITIAL_DEFAULT_REASONING_SPEC = getModelReasoningSpec(
  DEFAULT_PLATFORM_MODELS.find((m) => m.name === INITIAL_DEFAULT_MODEL) ?? {
    name: INITIAL_DEFAULT_MODEL,
    is_reasoning: true,
  },
  DEFAULT_PLATFORM_MODELS
);

const isModelVisionCapable = (modelIdentifier?: string): boolean => {
  if (!modelIdentifier) return false;
  const norm = extractModelKey(modelIdentifier).toLowerCase();
  const def = findKnownModelRecord(norm);
  if (def && typeof def.supports_vision === "boolean") return def.supports_vision;
  return /gpt-4|gpt-5|gpt-6|claude|gemini|grok|step-5|vision|vl|multimodal/i.test(norm);
};

const resolveModelDisplayName = (modelIdentifier?: string): string | undefined => {
  if (!modelIdentifier) return undefined;
  const norm = extractModelKey(modelIdentifier).toLowerCase();
  const storeMatch = useModelStore
    .getState()
    .models.find((m) => m.name === modelIdentifier || extractModelKey(m.name).toLowerCase() === norm);
  if (storeMatch?.display_name) {
    return storeMatch.display_name.replace(/\s*\(BYOS\)\s*$/i, "").trim();
  }
  const def = findKnownModelRecord(norm);
  return def?.display_name;
};

export type Role = "user" | "assistant" | "system";

export interface ImageData {
  uuid: string;
  image_uuid?: string;
  image_url: string;
  prompt: string;
  negative_prompt: string;
  width: number;
  height: number;
  seed: number | null;
  model?: string;
  tag?: string;
  created_at: string;
  shared?: boolean;
}

export interface AttachmentData {
  uuid?: string;
  original_name: string;
  content_type?: string | null;
  file_size: number;
  created_at?: string;
  download_url?: string;
  local_file?: File;
}

export interface Message {
  role: Role;
  content: string;
  thinking?: string;
  thinkingSummary?: string;
  thinkingTokens?: { input: number; output: number };
  totalDurationMs?: number;
  thinkingSegments?: string[];
  phases?: ThinkingPhase[];
  uuid?: string;
  /** Stable client-side render key preserved when a temporary UUID is replaced by a server UUID. */
  clientKey?: string;
  request_uuid?: string | null;
  parent?: string | null;
  created_at?: string;
  title?: string;
  type?: "text" | "image" | "error";
  model?: string;
  modelDisplayName?: string;
  tag?: string;
  images?: ImageData[];
  attachments?: AttachmentData[];
  tool_calls?: ToolCallInfo[];
  error?: string;
  file_diff?: FileDiffData;
  /**
   * Artifacts produced by the agent's `sandbox_generate` tool — image/video/
   * audio/code files stored in R2 and rendered inline below the message text.
   */
  content_blocks?: SandboxContentBlock[];
  /** Last streamed text chunk delta. */
  lastChunk?: string;
  /** Transient per-chunk deltas while streaming; cleared when the stream ends. */
  streamChunks?: string[];
}

export interface FileChangeItem {
  path: string;
  status: "modified" | "added" | "deleted";
  additions: number;
  deletions: number;
  diff?: string;
}

export interface FileDiffData {
  has_changes: boolean;
  files: FileChangeItem[];
  total_additions: number;
  total_deletions: number;
  raw_diff?: string;
  head_commit?: string;
  undone?: boolean;
}

export interface SandboxContentBlock {
  content_url: string;
  mime?: string;
  return_type?: "image" | "video" | "audio" | "code" | "text";
  size_bytes?: number;
  /** Optional execution_id (SandboxExecution.uuid) for cost telemetry surfacing. */
  execution_id?: string;
  /** Cost snapshot surfaced on the message (USD). */
  cost_usd?: string;
  /** Original tool call from where this content came. */
  title?: string;
}

export interface ThinkingPhase {
  type: "thinking" | "thinking_done" | "tool_call" | "tool_result" | "content";
  label: string;
  toolName?: string;
  toolCallId?: string;
  round?: number;
  chunk?: string;
  streaming?: boolean;
  durationMs?: number;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  title?: string;
  arguments: string | Record<string, unknown>;
  result?: string;
  output?: string;
  status: "calling" | "done" | "error";
  durationMs?: number;
}

interface ActiveRequestPayload {
  uuid: string;
  status?: string;
  parent_uuid?: string | null;
  model_type?: "text" | "image" | null;
  created_at?: string;
  partial_content?: string | null;
  partial_thinking?: string | null;
  phases?: ThinkingPhase[];
  tool_calls?: any[];
}

export interface ConversationCacheEntry {
  messages: Message[];
  currentMessage: Message | null;
  activeRequestId: string | null;
  activeRequestParentId: string | null;
  activeRequestModelType: "text" | "image" | null;
  isStreaming: boolean;
  selectedMessage: Message | null;
  updatedAt: number;
}

interface ChatState {
  conversationId: string | null;
  conversationCache: Record<string, ConversationCacheEntry>;
  generatingConversations: Record<string, boolean>;
  messages: Message[];
  selectedMessage: Message | null;
  currentMessage: Message | null;
  isLoading: boolean;
  isStreaming: boolean;
  isActivelyGenerating: boolean;
  error: string | null;
  selectedModel: string;
  selectedModelType: string;
  selectedModelIsReasoning: boolean;
  selectedModelReasoningMode: ReasoningMode;
  selectedModelReasoningTiers: ReasoningTier[];
  selectedModelDefaultReasoningEffort: ReasoningTier;
  useModelStartingLoading: boolean;
  abortController: AbortController | null;
  fetchAbortController: AbortController | null;
  requestId: number;
  activeRequestId: string | null;
  activeRequestParentId: string | null;
  activeRequestModelType: "text" | "image" | null;
  toolTimeouts: Record<string, NodeJS.Timeout>;
  newConversationResolver: ((id: string) => void) | null;
  skipFetchConversationId: string | null;

  // Chat mode
  chatMode: "chat" | "code";
  setChatMode: (mode: "chat" | "code") => void;
  draftPrompt: string | null;
  setDraftPrompt: (prompt: string | null) => void;

  // LLM Settings
  temperature: number;
  topP: number;
  systemPrompt: string;
  reasoningLevel: ReasoningTier;
  reasoningLevelByModel: Record<string, ReasoningTier>;
  setWebSearch: (value: boolean) => void;
  webSearch: boolean;

  setConversationId: (id: string | null) => void;
  setConversationGenerating: (uuid: string, isGenerating: boolean) => void;
  switchConversation: (uuid: string) => void;
  setMessages: (messages: Message[]) => void;
  setSelectedMessage: (message: Message | null) => void;
  setCurrentMessage: (m: Message | null) => void;
  clearError: () => void;
  setSelectedModel: (model: string) => void;
  setSelectedModelType: (modelType: string) => void;
  setSelectedModelIsReasoning: (isReasoning: boolean) => void;
  setTemperature: (value: number) => void;
  setTopP: (value: number) => void;
  setSystemPrompt: (value: string) => void;
  setReasoningLevel: (value: ReasoningTier) => void;
  fetchModelDetails: (modelName: string) => Promise<void>;
  undoSandboxChanges: (sandboxUuid: string, messageUuid?: string) => Promise<{ ok: boolean; error?: string }>;
  undoMessage: (messageUuid: string, conversationId?: string) => Promise<{ ok: boolean; error?: string }>;

  fetchConversation: (id: string, options?: { silent?: boolean }) => Promise<void>;
  sendMessage: (content: string, parentMessageId?: string, model?: string, conversationId?: string, files?: File[]) => Promise<string | null>;
  cancelGeneration: () => Promise<boolean>;
  stopStreaming: () => void;
  reset: () => void;
}

// ── Tool call helpers (archived - backend now handles tool execution) ──

const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      conversationId: null,
      conversationCache: {},
      generatingConversations: {},
      messages: [],
      selectedMessage: null,
      currentMessage: null,
      isLoading: false,
      isStreaming: false,
      isActivelyGenerating: false,
      error: null,
      selectedModel: INITIAL_DEFAULT_MODEL,
      selectedModelType: "text",
      selectedModelIsReasoning: INITIAL_DEFAULT_REASONING_SPEC.isReasoning,
      selectedModelReasoningMode: INITIAL_DEFAULT_REASONING_SPEC.mode,
      selectedModelReasoningTiers: INITIAL_DEFAULT_REASONING_SPEC.tiers,
      selectedModelDefaultReasoningEffort: INITIAL_DEFAULT_REASONING_SPEC.defaultTier,
      useModelStartingLoading: false,
      abortController: null,
      fetchAbortController: null,
      requestId: 0,
      activeRequestId: null,
      activeRequestParentId: null,
      activeRequestModelType: null,
      toolTimeouts: {},
      newConversationResolver: null,
      skipFetchConversationId: null,
      draftPrompt: null,
      setDraftPrompt: (prompt) => set({ draftPrompt: prompt }),

      setConversationGenerating: (uuid: string, isGenerating: boolean) => {
        if (!uuid) return;
        set((state) => {
          const prev = state.generatingConversations || {};
          if (prev[uuid] === isGenerating) return state;
          return {
            generatingConversations: {
              ...prev,
              [uuid]: isGenerating,
            },
            ...(!isGenerating && state.conversationCache[uuid] ? {
              conversationCache: {
                ...state.conversationCache,
                [uuid]: { ...state.conversationCache[uuid], isStreaming: false },
              },
            } : {}),
          };
        });
      },

      switchConversation: (targetUuid: string) => {
        const state = get();
        const currentId = state.conversationId;

        // 1. Save current conversation to cache if currentId exists
        let updatedCache = { ...(state.conversationCache || {}) };
        if (currentId) {
          updatedCache[currentId] = {
            messages: state.messages,
            currentMessage: state.currentMessage,
            activeRequestId: state.activeRequestId,
            activeRequestParentId: state.activeRequestParentId,
            activeRequestModelType: state.activeRequestModelType,
            isStreaming: state.isStreaming,
            selectedMessage: state.selectedMessage,
            updatedAt: Date.now(),
          };
        }

        // 2. Restore target conversation from cache if exists
        const cached = updatedCache[targetUuid];
        const isGenerating = Boolean(state.generatingConversations?.[targetUuid]);

        if (cached && cached.messages && cached.messages.length > 0) {
          set({
            conversationCache: updatedCache,
            conversationId: targetUuid,
            messages: cached.messages,
            currentMessage: cached.currentMessage,
            activeRequestId: cached.activeRequestId,
            activeRequestParentId: cached.activeRequestParentId,
            activeRequestModelType: cached.activeRequestModelType,
            isStreaming: isGenerating || cached.isStreaming,
            selectedMessage: cached.selectedMessage,
            error: null,
            isLoading: false,
          });
        } else {
          set({
            conversationCache: updatedCache,
            conversationId: targetUuid,
            messages: cached?.messages || [],
            currentMessage: cached?.currentMessage || null,
            activeRequestId: cached?.activeRequestId || null,
            activeRequestParentId: cached?.activeRequestParentId || null,
            activeRequestModelType: cached?.activeRequestModelType || null,
            isStreaming: isGenerating || Boolean(cached?.isStreaming),
            selectedMessage: cached?.selectedMessage || null,
            error: null,
            isLoading: !cached,
          });
        }
      },

      // LLM Settings defaults
      temperature: 0.7,
      topP: 0.9,
      systemPrompt: "",
      reasoningLevel: INITIAL_DEFAULT_REASONING_SPEC.defaultTier,
      reasoningLevelByModel: {
        [INITIAL_DEFAULT_MODEL]: INITIAL_DEFAULT_REASONING_SPEC.defaultTier,
      },
      webSearch: false,
      chatMode: "chat" as "chat" | "code",

      setConversationId: (id) => set({ conversationId: id }),
      setMessages: (messages) => set({ messages }),
      setSelectedMessage: (message) => set({ selectedMessage: message }),
      setCurrentMessage: (m) => set(state => {
        if (!m) return { currentMessage: null };
        return {
          currentMessage: {
            ...m,
            phases: m.phases !== undefined ? m.phases : state.currentMessage?.phases,
            thinkingSegments: m.thinkingSegments !== undefined ? m.thinkingSegments : state.currentMessage?.thinkingSegments,
            tool_calls: m.tool_calls !== undefined ? m.tool_calls : state.currentMessage?.tool_calls,
          }
        };
      }),
      clearError: () => set({ error: null }),
      setSelectedModel: (model) => {
        let cleanedModel = model;
        let explicitTier: string | undefined;
        if (typeof cleanedModel === "string" && cleanedModel.includes(":")) {
          const parts = cleanedModel.split(":");
          if (parts.length === 2 && parts[0] === parts[1]) {
            cleanedModel = parts[0];
          } else if (parts.length === 2) {
            cleanedModel = parts[0];
            if (isReasoningTier(parts[1])) {
              explicitTier = parts[1];
            }
          }
        }
        const modelKey = extractModelKey(cleanedModel);
        const knownModel = findKnownModelRecord(modelKey || cleanedModel);
        const spec = getModelReasoningSpec(
          knownModel ?? { name: modelKey || cleanedModel },
          DEFAULT_PLATFORM_MODELS
        );
        const savedPreferred = explicitTier ?? get().reasoningLevelByModel?.[modelKey];
        const nextTier = spec.isReasoning ? resolveModelReasoningTier(spec, savedPreferred) : "none";
        const nextSelected = modelKey || cleanedModel;

        set((state) => ({
          selectedModel: nextSelected,
          selectedModelType: knownModel?.model_type || state.selectedModelType || "text",
          selectedModelIsReasoning: spec.isReasoning,
          selectedModelReasoningMode: spec.mode,
          selectedModelReasoningTiers: spec.tiers,
          selectedModelDefaultReasoningEffort: spec.defaultTier,
          reasoningLevel: nextTier,
          ...(spec.isReasoning && modelKey
            ? {
                reasoningLevelByModel: {
                  ...(state.reasoningLevelByModel || {}),
                  [modelKey]: nextTier,
                },
              }
            : {}),
        }));
      },
      setSelectedModelType: (modelType) => set({ selectedModelType: modelType }),
      setSelectedModelIsReasoning: (isReasoning) => set({ selectedModelIsReasoning: isReasoning }),
      setTemperature: (value) => set({ temperature: value }),
      setTopP: (value) => set({ topP: value }),
      setSystemPrompt: (value) => set({ systemPrompt: value }),
      setReasoningLevel: (value) =>
        set((state) => {
          const modelKey = extractModelKey(state.selectedModel);
          const knownModel = findKnownModelRecord(modelKey);
          const spec = state.selectedModelIsReasoning
            ? getModelReasoningSpec(
                {
                  ...knownModel,
                  name: modelKey,
                  is_reasoning: state.selectedModelIsReasoning,
                  ...(state.selectedModelReasoningTiers.length > 0
                    ? {
                        reasoning_mode: state.selectedModelReasoningMode,
                        reasoning_tiers: state.selectedModelReasoningTiers,
                        default_reasoning_effort: state.selectedModelDefaultReasoningEffort,
                      }
                    : {}),
                },
                DEFAULT_PLATFORM_MODELS
              )
            : null;
          const resolved =
            spec && spec.isReasoning ? resolveModelReasoningTier(spec, value) : value;
          return {
            reasoningLevel: resolved,
            ...(modelKey && resolved
              ? {
                  reasoningLevelByModel: {
                    ...(state.reasoningLevelByModel || {}),
                    [modelKey]: resolved,
                  },
                }
              : {}),
          };
        }),
      setWebSearch: (value) => set({ webSearch: value }),
      setChatMode: (mode) => set({ chatMode: mode }),

      undoSandboxChanges: async (sandboxUuid: string, messageUuid?: string): Promise<{ ok: boolean; error?: string }> => {
        const token = localStorage.getItem("token");
        if (!token) return { ok: false, error: i18n.t("chat:store.unauthorized") };

        try {
          const res = await fetch(`${env.API_URL}/sandboxes/${sandboxUuid}/git/undo/`, {
            method: "POST",
            headers: {
              ...workspaceHeaders(),
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({}),
          });
          const data = await res.json();
          if (!res.ok) {
            return { ok: false, error: data?.error || i18n.t("chat:store.undoChangesFailed") };
          }

          set(state => {
            const updateMsg = (m: Message) => {
              if (messageUuid && m.uuid === messageUuid && m.file_diff) {
                return { ...m, file_diff: { ...m.file_diff, undone: true } };
              }
              if (!messageUuid && m.file_diff && !m.file_diff.undone) {
                return { ...m, file_diff: { ...m.file_diff, undone: true } };
              }
              return m;
            };

            const updatedMessages = state.messages.map(updateMsg);
            const currentConvId = state.conversationId;
            const updatedCache = { ...state.conversationCache };
            if (currentConvId && updatedCache[currentConvId]) {
              updatedCache[currentConvId] = {
                ...updatedCache[currentConvId],
                messages: updatedCache[currentConvId].messages.map(updateMsg),
              };
            }

            return {
              messages: updatedMessages,
              conversationCache: updatedCache,
            };
          });

          // Refresh files in sandbox projects store
          try {
            const sandboxStore = useSandboxProjectsStore.getState();
            sandboxStore.fetchFiles(sandboxUuid);
          } catch {}

          return { ok: true };
        } catch (e: any) {
          return { ok: false, error: e?.message || i18n.t("chat:store.undoChangesFailed") };
        }
      },

      undoMessage: async (messageUuid: string, targetConvId?: string): Promise<{ ok: boolean; error?: string }> => {
        const token = localStorage.getItem("token");
        const convId = targetConvId || get().conversationId;
        if (!token || !convId) return { ok: false, error: i18n.t("chat:store.unauthorizedOrMissingConversation") };

        const currentMessages = get().messages;
        const targetMessage = currentMessages.find((m) => m.uuid === messageUuid);
        if (!targetMessage) {
          return { ok: false, error: i18n.t("chat:store.messageNotFound") };
        }

        // Immediately restore the prompt so the user doesn't lose their input
        if (targetMessage.content) {
          get().setDraftPrompt(targetMessage.content);
        }

        try {
          const res = await fetch(`${env.API_URL}/conversations/${convId}/messages/${messageUuid}/undo/`, {
            method: "POST",
            headers: {
              ...workspaceHeaders(),
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ revert_workspace: true }),
          });

          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            return { ok: false, error: data?.error || i18n.t("chat:store.undoMessageFailed") };
          }

          const deletedUuids = new Set<string>(data?.deleted_uuids || []);
          deletedUuids.add(messageUuid);

          set((state) => {
            const filterFn = (m: Message) => {
              if (deletedUuids.has(m.uuid || "")) return false;
              if (targetMessage.created_at && m.created_at && new Date(m.created_at) >= new Date(targetMessage.created_at)) {
                return false;
              }
              return true;
            };

            const nextMessages = state.messages.filter(filterFn);
            const nextCache = { ...state.conversationCache };
            if (convId && nextCache[convId]) {
              nextCache[convId] = {
                ...nextCache[convId],
                messages: (nextCache[convId].messages || []).filter(filterFn),
                updatedAt: Date.now(),
              };
            }

            return {
              messages: nextMessages,
              conversationCache: nextCache,
              currentMessage: null,
            };
          });

          // Refresh files in sandbox projects store if an active sandbox exists
          try {
            const currentSandbox = useSandboxProjectsStore.getState().currentSandbox;
            if (currentSandbox?.uuid) {
              useSandboxProjectsStore.getState().fetchFiles(currentSandbox.uuid);
            }
          } catch {}

          return { ok: true };
        } catch (e: any) {
          return { ok: false, error: e?.message || i18n.t("chat:store.undoMessageFailed") };
        }
      },

      fetchModelDetails: async (modelName: string) => {
        const parts = modelName.split(':');
        const isDuplicate = parts.length === 2 && parts[0] === parts[1];
        const modelNameOnly = isDuplicate ? parts[0] : (parts[0] || modelName);
        const tagName = isDuplicate ? undefined : parts[1];
        const modelKey = extractModelKey(modelNameOnly);
        const initialSelectedKey = extractModelKey(get().selectedModel);

        const applySpec = (sourceModel: any, fallbackType = "text") => {
          const currentSelectedKey = extractModelKey(get().selectedModel);
          if (
            currentSelectedKey &&
            currentSelectedKey !== initialSelectedKey &&
            currentSelectedKey !== modelKey
          ) {
            return;
          }
          const spec = getModelReasoningSpec(sourceModel, DEFAULT_PLATFORM_MODELS);
          const state = get();
          const preferred =
            (tagName && isReasoningTier(tagName) ? tagName : undefined) ??
            state.reasoningLevelByModel?.[modelKey] ??
            (currentSelectedKey === modelKey ? state.reasoningLevel : undefined);
          const nextTier = spec.isReasoning ? resolveModelReasoningTier(spec, preferred) : "none";

          set((prev) => ({
            selectedModelType: sourceModel?.model_type || fallbackType || "text",
            selectedModelIsReasoning: spec.isReasoning,
            selectedModelReasoningMode: spec.mode,
            selectedModelReasoningTiers: spec.tiers,
            selectedModelDefaultReasoningEffort: spec.defaultTier,
            ...(currentSelectedKey === modelKey || currentSelectedKey === initialSelectedKey
              ? { reasoningLevel: nextTier }
              : {}),
            ...(spec.isReasoning && modelKey
              ? {
                  reasoningLevelByModel: {
                    ...(prev.reasoningLevelByModel || {}),
                    [modelKey]: nextTier,
                  },
                }
              : {}),
          }));
        };

        try {
          const modelResponse = await fetch(`${env.API_URL}/models/${modelNameOnly}/`);
          if (modelResponse.ok) {
            const data = await modelResponse.json();
            applySpec(data, data.model_type || "text");
            return;
          }

          const known = findKnownModelRecord(modelKey);
          if (known) {
            applySpec(known, known.model_type || "text");
          } else {
            set({
              selectedModelType: "text",
              selectedModelIsReasoning: false,
              selectedModelReasoningMode: "none",
              selectedModelReasoningTiers: [],
              selectedModelDefaultReasoningEffort: "none",
            });
          }
        } catch (error) {
          console.error("Error fetching model details:", error);
          const known = findKnownModelRecord(modelKey);
          if (known) {
            applySpec(known, known.model_type || "text");
          } else {
            set({
              selectedModelType: "text",
              selectedModelIsReasoning: false,
              selectedModelReasoningMode: "none",
              selectedModelReasoningTiers: [],
              selectedModelDefaultReasoningEffort: "none",
            });
          }
        }
      },
      fetchConversation: async (id: string, options?: { silent?: boolean }) => {
        const { fetchAbortController: prevController, requestId: prevRequestId } = get();
        if (prevController) {
          prevController.abort();
        }

        const controller = new AbortController();
        const newRequestId = prevRequestId + 1;
        const isSilent = options?.silent || (get().conversationId === id && get().messages.length > 0);
        set({ isLoading: !isSilent, fetchAbortController: controller, requestId: newRequestId, error: null });

        try {
          const res = await fetch(`${env.API_URL}/conversations/${id}/`, {
            headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
            signal: controller.signal,
          });

          if (!res.ok) {
            throw new Error(i18n.t("chat:store.fetchConversationFailed", { status: res.status }));
          }

          const data = await res.json();
          if (controller.signal.aborted || get().requestId !== newRequestId) return;
          const existingClientKeys = new Map<string, string>();
          for (const existing of get().messages) {
            if (existing.uuid && existing.clientKey) {
              existingClientKeys.set(existing.uuid, existing.clientKey);
            }
          }
          const messages: Message[] = (data?.conversation.messages ?? []).map((m: any) => {
                      // Build phases from tool_calls and thinking
                      const phases: ThinkingPhase[] = [];
                      if (m.phases && m.phases.length > 0) {
                        // Filter out leading whitespace-only content phases that precede thinking
                        const rawPhases = m.phases.filter((p: any, idx: number) => {
                          if (p.type === 'content' && !(p.chunk || '').trim()) {
                            const hasUpcomingThinking = m.phases.slice(idx + 1).some((later: any) => later.type === 'thinking');
                            if (hasUpcomingThinking) return false;
                          }
                          return true;
                        });
                        // Use pre-saved phases from backend, dedup tool_call+tool_result pairs
                        for (const p of rawPhases) {
                          const prev = phases[phases.length - 1];
                          if (prev && prev.toolCallId && prev.toolCallId === p.toolCallId && prev.type === 'tool_call' && p.type === 'tool_result') {
                            phases[phases.length - 1] = { ...p };
                          } else {
                            phases.push({ ...p });
                          }
                        }
                      } else if (m.thinking_segments && m.thinking_segments.length > 0) {
                        let toolIdx = 0;
                        const toolCalls = m.tool_calls || [];
                        for (let i = 0; i < m.thinking_segments.length; i++) {
                          phases.push({ type: "thinking", label: i18n.t("chat:store.thinking") });
                          // Each thinking round except the last gets one tool (typical pattern)
                          if (i < m.thinking_segments.length - 1 && toolIdx < toolCalls.length) {
                            const tc = toolCalls[toolIdx];
                            const name = tc.function?.name || tc.name || "";
                            phases.push({ type: "tool_call", label: formatToolName(name), toolName: name });
                            phases.push({ type: "tool_result", label: `${formatToolName(name)} - Done`, toolName: name });

                            toolIdx++;
                          }
                        }
                        // Any remaining tool calls that don't fit the heuristic
                        while (toolIdx < toolCalls.length) {
                          const tc = toolCalls[toolIdx];
                          const name = tc.function?.name || tc.name || "";
                          phases.push({ type: "tool_result", label: `${formatToolName(name)} - Done`, toolName: name });
                          toolIdx++;
                        }
                      } else if (m.thinking) {
                        phases.push({ type: "thinking", label: i18n.t("chat:store.thinking") });
                        if (m.tool_calls && m.tool_calls.length > 0) {
                          for (const tc of m.tool_calls) {
                            const name = tc.function?.name || tc.name || "";
                            const label = tc.result ? `${formatToolName(name)} - Done` : `${formatToolName(name)}`;
                            phases.push({ type: tc.result ? "tool_result" : "tool_call", label, toolName: name });
                          }
                        }
                      }
                      // Also handle case of tool calls without thinking
                      else if (!m.thinking && !m.thinking_segments && m.tool_calls && m.tool_calls.length > 0) {
                        for (const tc of m.tool_calls) {
                          const name = tc.function?.name || tc.name || "";
                          const label = tc.result ? `${formatToolName(name)} - Done` : `${formatToolName(name)}`;
                          phases.push({ type: tc.result ? "tool_result" : "tool_call", label, toolName: name });
                        }
                      }
                      if (m.content && phases.length > 0 && !phases.some((p: ThinkingPhase) => p.type === 'thinking_done')) {
                        phases.push({ type: "thinking_done", label: i18n.t("chat:store.done") });
                      }

                      return {
                        role: m.role,
                        content: m.content,
                        thinking: m.thinking ?? undefined,
                        thinkingSummary: m.thinking_summary ?? undefined,
                        thinkingSegments: m.thinking_segments ?? undefined,
                        uuid: m.uuid,
                        clientKey: m.uuid ? existingClientKeys.get(m.uuid) : undefined,
                        request_uuid: m.request_uuid,
                        parent: m.parent_uuid || m.parent,
                        created_at: m.created_at,
                        type: m.type || "text",
                        model: m.model ? (m.model.includes(":") && m.model.split(":")[0] === m.model.split(":")[1] ? m.model.split(":")[0] : m.model) : undefined,
                        modelDisplayName: m.model_display_name ?? resolveModelDisplayName(m.model),
                        totalDurationMs: typeof m.duration_ms === "number" ? m.duration_ms : (typeof m.duration_seconds === "number" ? Math.round(m.duration_seconds * 1000) : undefined),
                        tag: (m.tag && m.tag !== m.model) ? m.tag : undefined,
                        error: m.error ?? undefined,
                        file_diff: m.file_diff ?? undefined,
                        tool_calls: m.tool_calls
                          ? normalizeToolCalls(m.tool_calls, { defaultPendingStatus: "error" })
                          : undefined,
                        phases: phases.length > 0 ? phases : undefined,
                        images: (m.images || []).map((img: any) => ({
                          uuid: img.uuid || img.image_uuid,
                          image_uuid: img.image_uuid || img.uuid,
                          image_url: img.image_url || img.url || img.image || "",
                          prompt: img.prompt || "",
                          negative_prompt: img.negative_prompt || "",
                          width: img.width || 512,
                          height: img.height || 512,
                          seed: img.seed != null ? img.seed : null,
                          model: img.model ? (img.model.includes(":") && img.model.split(":")[0] === img.model.split(":")[1] ? img.model.split(":")[0] : img.model) : undefined,
                          tag: (img.tag && img.tag !== img.model) ? img.tag : undefined,
                          created_at: img.created_at || "",
                          shared: img.shared || false,
                        })),
                        attachments: (m.attachments || []).map((attachment: any) => ({
                          uuid: attachment.uuid,
                          original_name: attachment.original_name,
                          content_type: attachment.content_type ?? null,
                          file_size: Number(attachment.file_size || 0),
                          created_at: attachment.created_at,
                          download_url: attachment.download_url,
                        })),
                      };
                    });

          const localMessages = get().messages;
          const lastLocalMsg = localMessages[localMessages.length - 1];
          if (
            lastLocalMsg &&
            lastLocalMsg.role === "assistant" &&
            (lastLocalMsg.content || lastLocalMsg.thinking || lastLocalMsg.tool_calls?.length) &&
            !messages.some(m => m.uuid === lastLocalMsg.uuid || (m.role === "assistant" && m.parent && m.parent === lastLocalMsg.parent))
          ) {
            const lastFetchedMsg = messages[messages.length - 1];
            const hasRecentAssistant = lastFetchedMsg?.role === "assistant";
            if (!hasRecentAssistant) {
              messages.push(lastLocalMsg);
            }
          }

          const latestMessage = messages[messages.length - 1];
          const activeRequest = data?.conversation?.active_request as ActiveRequestPayload | null;
          const hasActiveRequest = Boolean(
            activeRequest && (activeRequest.status === "pending" || activeRequest.status === "processing")
          );
          const activeModelType: "text" | "image" = activeRequest?.model_type === "image" ? "image" : "text";
          const activeParentId = activeRequest?.parent_uuid ?? latestMessage?.uuid ?? null;
          const partialContent = activeRequest?.partial_content ?? "";
          const partialThinking = activeRequest?.partial_thinking ?? "";
          const partialPhases = activeRequest?.phases ?? [];
          const partialToolCalls = normalizeToolCalls(activeRequest?.tool_calls, {
            defaultPendingStatus: "calling",
          });
          if (hasActiveRequest && get().conversationId === id && partialToolCalls.some(tc => tc.name === "desktop" && tc.status === "calling")) {
            try {
              const tabsStore = useWorkspaceTabsStore.getState();
              const desktopTab = tabsStore.splitTabs.find(t => t.type === "desktop");
              if (!tabsStore.isSplit || tabsStore.activeSplitTabId !== desktopTab?.id) {
                tabsStore.openDesktopTab();
              }
            } catch {}
          }

          // A persisted failure for this exact request ends a stale local stream.
          // Older failures must not interrupt a retry that is still being created.
          const failedCurrentRequest = !hasActiveRequest && get().conversationId === id && Boolean(
            get().activeRequestId && messages.some(message =>
              message.request_uuid === get().activeRequestId && message.error
            )
          );
          if (failedCurrentRequest) {
            get().abortController?.abort();
            set({ isActivelyGenerating: false });
          }

          // Sync generating status
          if (hasActiveRequest) {
            get().setConversationGenerating(id, true);
          } else if (!get().isActivelyGenerating || get().conversationId !== id) {
            get().setConversationGenerating(id, false);
          }

          const existingCurrent = get().conversationId === id ? get().currentMessage : null;
          const prevCurrentPhases = existingCurrent?.phases || [];
          const mergedPartialPhases = partialPhases.map((phase, idx) => {
            if (phase.durationMs !== undefined) return phase;
            const prevMatch = phase.toolCallId
              ? prevCurrentPhases.find((p) => p.toolCallId === phase.toolCallId && p.durationMs !== undefined)
              : prevCurrentPhases[idx];
            return prevMatch?.durationMs !== undefined ? { ...phase, durationMs: prevMatch.durationMs } : phase;
          });
          const hasToolArgs = (args: unknown): boolean => {
            if (!args) return false;
            if (typeof args === "string") return args.trim().length > 0 && args.trim() !== "{}";
            if (typeof args === "object") return Object.keys(args as Record<string, unknown>).length > 0;
            return false;
          };
          const prevCurrentToolCalls = existingCurrent?.tool_calls || [];
          const prevToolById = new Map(prevCurrentToolCalls.map((tc) => [tc.id, tc]));
          const mergedPartialToolCalls = partialToolCalls.map((tc) => {
            const prevTc = prevToolById.get(tc.id);
            if (!prevTc) return tc;
            return {
              ...tc,
              arguments: hasToolArgs(tc.arguments)
                ? tc.arguments
                : hasToolArgs(prevTc.arguments)
                  ? prevTc.arguments
                  : tc.arguments,
              durationMs: tc.durationMs !== undefined ? tc.durationMs : prevTc.durationMs,
            };
          });

          const resolvedCurrentMessage: Message | null = hasActiveRequest
            ? {
                role: "assistant" as Role,
                content: (existingCurrent?.content && (existingCurrent?.content?.length ?? 0) > partialContent.length)
                  ? (existingCurrent?.content ?? "")
                  : partialContent,
                thinking: (existingCurrent?.thinking && (existingCurrent?.thinking?.length ?? 0) > partialThinking.length)
                  ? (existingCurrent?.thinking ?? "")
                  : (partialThinking || undefined),
                phases: mergedPartialPhases.length > 0
                  ? mergedPartialPhases
                  : (existingCurrent?.phases || undefined),
                tool_calls: mergedPartialToolCalls.length > 0
                  ? mergedPartialToolCalls
                  : (existingCurrent?.tool_calls || undefined),
                parent: activeParentId,
                created_at: activeRequest?.created_at,
                type: (activeModelType === "image" ? "image" : "text") as "text" | "image",
              }
            : null;

          const updatedCache = {
            ...get().conversationCache,
            [id]: {
              messages,
              currentMessage: resolvedCurrentMessage,
              activeRequestId: hasActiveRequest ? activeRequest?.uuid ?? null : null,
              activeRequestParentId: hasActiveRequest ? activeParentId : null,
              activeRequestModelType: hasActiveRequest ? activeModelType : null,
              isStreaming: hasActiveRequest || Boolean(get().generatingConversations[id]),
              selectedMessage: latestMessage,
              updatedAt: Date.now(),
            }
          };

          if (data?.conversation?.title) {
            useSidebarStore.getState().setConversationTitle(id, data.conversation.title, { insertIfMissing: false });
          }

          if (get().requestId === newRequestId) {
            if (get().conversationId === id) {
              set({
                conversationCache: updatedCache,
                conversationId: id,
                messages,
                selectedMessage: latestMessage,
                isLoading: false,
                fetchAbortController: null,
                isStreaming: hasActiveRequest || Boolean(get().generatingConversations[id]),
                currentMessage: (get().isActivelyGenerating && get().generatingConversations[id]) ? get().currentMessage : resolvedCurrentMessage,
                useModelStartingLoading: hasActiveRequest && activeModelType === "text" && !partialContent && !partialThinking && !partialPhases.length && !partialToolCalls.length,
                abortController: hasActiveRequest ? get().abortController : null,
                activeRequestId: hasActiveRequest ? activeRequest?.uuid ?? null : null,
                activeRequestParentId: hasActiveRequest ? activeParentId : null,
                activeRequestModelType: hasActiveRequest ? activeModelType : null,
              });
            } else {
              set({
                conversationCache: updatedCache,
                isLoading: false,
                fetchAbortController: null,
              });
            }
          }
        } catch (e: any) {
          if (e.name === 'AbortError') {
            console.log("Fetch conversation aborted");
          } else {
            console.error("Error fetching conversation:", e);
            if (get().requestId === newRequestId) {
              set({
                isLoading: false,
                isStreaming: false,
                isActivelyGenerating: false,
                currentMessage: null,
                useModelStartingLoading: false,
                activeRequestId: null,
                fetchAbortController: null,
                error: e?.message || i18n.t("chat:store.fetchConversationError"),
              });
            }
          }
        }
      },

      sendMessage: async (content: string, parentMessageId?: string, model?: string, conversationId?: string, files?: File[]): Promise<string | null> => {
       const token = localStorage.getItem("token");
        if (!token) {
          set({ error: i18n.t("chat:store.unauthorized") });
          return null;
        }
        const trimmed = content.trim();
        const hasFiles = Boolean(files && files.length > 0);
        if (!trimmed && !hasFiles && !parentMessageId) {
          return null;
        }

        const rawModelToUse = model ?? get().selectedModel ?? "deepseek-v4.1-flash-1017";
        const modelToUse = (rawModelToUse.includes(":") && rawModelToUse.split(":")[0] === rawModelToUse.split(":")[1])
          ? rawModelToUse.split(":")[0]
          : rawModelToUse;
        const currentConversationId = conversationId ?? get().conversationId;
        const sandboxState = useSandboxProjectsStore.getState();
        const activeProjectId = sandboxState.currentSandbox?.uuid || sandboxState.workspaceSandbox?.uuid;
        const linkToActiveProject = (conversationUuid?: string | null) => {
          if (activeProjectId && conversationUuid) {
            useSandboxProjectsStore
              .getState()
              .linkConversationToSandbox(activeProjectId, conversationUuid);
          }
        };
        const previousController = get().abortController;
        if (previousController) {
          previousController.abort();
        }
        const streamController = new AbortController();

        let isRegeneratingFailedMessage = false;
        let tempId = `temp-${Date.now()}`;
        let actualTrimmed = trimmed;
        let actualFiles = files;
        let actualParentId = parentMessageId;
        const effectiveConvId = currentConversationId || tempId;
        if (currentConversationId) {
          get().setConversationGenerating(currentConversationId, true);
        }

        if (!trimmed && !hasFiles && (parentMessageId?.startsWith("temp-") || parentMessageId?.startsWith("failed-"))) {
          const failedMsg = get().messages.find((m) => m.uuid === parentMessageId);
          if (failedMsg && failedMsg.role === "user") {
            isRegeneratingFailedMessage = true;
            tempId = parentMessageId;
            actualTrimmed = failedMsg.content || "";
            if (failedMsg.attachments?.length) {
              const attachStr = `Attachments: ${failedMsg.attachments.map((a: any) => a.original_name).join(', ')}`;
              actualTrimmed = actualTrimmed.replace(attachStr, '').trim();
              actualFiles = failedMsg.attachments.map((a: any) => a.local_file).filter(Boolean);
            }
            actualParentId = failedMsg.parent ?? undefined;
          }
        }

        let returnedUserMessageId = tempId;
        let returnedConversationId: string | null = null;
        let returnedRequestId: string | null = null;
        let returnedTitle: string | null = null;
        const actualHasFiles = Boolean(actualFiles && actualFiles.length > 0);
        const attachmentLines = (actualFiles || []).map((file) => {
          const isImg = file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(file.name);
          return `[Attached ${isImg ? "Image" : "File"}: /workspace/.uploads/${file.name}]`;
        });
        const attachmentLine = attachmentLines.join('\n');
        const provisionalContent = [actualTrimmed, attachmentLine].filter(Boolean).join('\n\n');
        const provisionalUser: Message = {
          role: "user",
          content: provisionalContent,
          uuid: tempId,
          clientKey: tempId,
          parent: actualParentId,
          created_at: new Date().toISOString(),
          attachments: (actualFiles || []).map((file) => ({
            original_name: file.name,
            content_type: file.type || null,
            file_size: file.size,
            local_file: file,
          })),
        };

        // Upload attached files to sandbox VM at /workspace/.uploads/
        if (actualHasFiles && actualFiles && activeProjectId) {
          const targetSandbox = activeProjectId;
          void Promise.all(
            actualFiles.map(async (file) => {
              try {
                await useSandboxProjectsStore.getState().uploadFile(
                  targetSandbox,
                  file,
                  `/workspace/.uploads/${file.name}`,
                  { refresh: false }
                );
              } catch (uploadErr) {
                console.warn(`[chat] Failed to upload ${file.name} to /workspace/.uploads/:`, uploadErr);
              }
            })
          ).then(() => {
            void useSandboxProjectsStore.getState().fetchFiles(targetSandbox);
          });
        }

        // Show user message immediately and start loading dots: strictly chronological, no rollback
        set(state => {
          const nextMessages = (actualTrimmed || actualHasFiles) ? [...state.messages, provisionalUser] : state.messages;
          const targetCacheConv = currentConversationId || effectiveConvId;
          const nextCache = {
            ...state.conversationCache,
            ...(targetCacheConv ? {
              [targetCacheConv]: {
                ...(state.conversationCache[targetCacheConv] || {}),
                messages: nextMessages,
                selectedMessage: provisionalUser,
                currentMessage: null,
                isStreaming: true,
                updatedAt: Date.now(),
              }
            } : {})
          };

          return {
            conversationCache: nextCache,
            messages: nextMessages,
            selectedMessage: provisionalUser,
            isStreaming: true,
            isActivelyGenerating: true,
            error: null,
            currentMessage: null,
            useModelStartingLoading: false,
            abortController: streamController,
            activeRequestId: null,
            activeRequestParentId: null,
            activeRequestModelType: null,
            toolTimeouts: {},
          };
        });

        if (currentConversationId && (actualTrimmed || actualHasFiles)) {
          useSidebarStore.getState().moveConversationToTop(currentConversationId);
        }

        let fullContent = '';
        let fullThinking = '';
        let streamStartTime = Date.now();
        let flushRaf: number | null = null;
        const cancelPendingFlush = () => {
          if (flushRaf !== null) {
            if (typeof cancelAnimationFrame === 'function') {
              cancelAnimationFrame(flushRaf);
            }
            flushRaf = null;
          }
        };

        try {
          const {
            selectedModel,
            selectedModelIsReasoning,
            selectedModelReasoningMode,
            selectedModelReasoningTiers,
            selectedModelDefaultReasoningEffort,
            temperature,
            topP,
            systemPrompt,
            reasoningLevel,
          } = get();

          const isUsingSelectedModel = extractModelKey(modelToUse) === extractModelKey(selectedModel);
          const knownTargetModel = findKnownModelRecord(modelToUse);
          const targetModelSpec = isUsingSelectedModel
            ? getModelReasoningSpec(
                {
                  ...knownTargetModel,
                  name: modelToUse,
                  is_reasoning: selectedModelIsReasoning,
                  ...(selectedModelReasoningTiers.length > 0
                    ? {
                        reasoning_mode: selectedModelReasoningMode,
                        reasoning_tiers: selectedModelReasoningTiers,
                        default_reasoning_effort: selectedModelDefaultReasoningEffort,
                      }
                    : {}),
                },
                DEFAULT_PLATFORM_MODELS
              )
            : getModelReasoningSpec(knownTargetModel ?? { name: modelToUse }, DEFAULT_PLATFORM_MODELS);

          const resolvedReasoningLevel = targetModelSpec.isReasoning
            ? resolveModelReasoningTier(targetModelSpec, reasoningLevel)
            : undefined;

          let parentIdToUse = actualParentId;
          if (parentIdToUse?.startsWith("virtual-failed-")) {
            const virtualMsg = get().messages.find((m) => m.uuid === parentIdToUse);
            parentIdToUse = virtualMsg?.parent || undefined;
          }

          const selectedVmUuid = frontendExtension.runtimeBridge.getSelectedRuntimeUuid();

          let userMessagePayloadContent: any = provisionalContent;
          const imageFiles = (actualFiles || []).filter(
            (f) => f.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name)
          );
          const hasVisionCapability = isModelVisionCapable(modelToUse);

          if (imageFiles.length > 0 && hasVisionCapability) {
            try {
              const parts: any[] = [{ type: "text", text: provisionalContent }];
              for (const img of imageFiles) {
                const dataUrl = await fileToDataUrl(img);
                parts.push({
                  type: "image_url",
                  image_url: { url: dataUrl, detail: "auto" }
                });
              }
              userMessagePayloadContent = parts;
            } catch (err) {
              console.warn("[chat] Could not convert image to data URL:", err);
            }
          } else if (imageFiles.length > 0 && !hasVisionCapability) {
            toaster.create({
              title: i18n.t("chat:store.imageSavedTitle"),
              description: i18n.t("chat:store.imageSavedDescription", { model: modelToUse }),
              type: "info",
            });
          }

          const payload: any = {
            parent_message_id: parentIdToUse,
            project_uuid: activeProjectId,
            model: modelToUse,
            conversation: currentConversationId || undefined,
            input: actualTrimmed,
            messages: [{ role: "user", content: userMessagePayloadContent }],
            temperature,
            top_p: topP,
            system_prompt: systemPrompt || undefined,
            chat_mode: get().chatMode,
            ...(targetModelSpec.isReasoning && resolvedReasoningLevel
              ? { reasoning_level: resolvedReasoningLevel }
              : {}),
            ...(selectedVmUuid ? { vm_uuid: selectedVmUuid } : {}),
          };

          const isText = true;

          fullContent = '';
          fullThinking = '';
          let lastPhaseEvent: string | null = null;
          let currentRound = 0;
          let lastFlushTime = 0;
          const FLUSH_INTERVAL_MS = 35; // ~28fps throttle for high-frequency chunk updates

          let workingMessage: Message = {
            role: "assistant",
            content: "",
            thinking: "",
            parent: tempId,
            created_at: new Date().toISOString(),
            type: 'text',
            phases: [],
            thinkingSegments: [],
            tool_calls: [],
          };

          const flushWorkingMessage = (force = false) => {
            cancelPendingFlush();
            const now = Date.now();
            const targetConv = returnedConversationId || currentConversationId || effectiveConvId;
            const updatedWorkingMsg: Message = {
              ...workingMessage,
              parent: returnedUserMessageId || workingMessage.parent,
            };

            const applyStateUpdate = () => {
              const currentConvId = get().conversationId;
              const currentCache = get().conversationCache;
              const targetCache = currentCache[targetConv] || {
                messages: get().conversationId === targetConv ? get().messages : [],
                selectedMessage: null,
                activeRequestId: null,
                activeRequestParentId: null,
                activeRequestModelType: null,
                isStreaming: true,
                updatedAt: Date.now(),
              };

              const nextCache = {
                ...currentCache,
                [targetConv]: {
                  ...targetCache,
                  currentMessage: updatedWorkingMsg,
                  isStreaming: true,
                  updatedAt: Date.now(),
                }
              };

              if (currentConvId === targetConv) {
                set({
                  conversationCache: nextCache,
                  currentMessage: updatedWorkingMsg,
                  isStreaming: true,
                });
              } else {
                set({
                  conversationCache: nextCache,
                });
              }
            };

            if (!force && now - lastFlushTime < FLUSH_INTERVAL_MS) {
              if (typeof requestAnimationFrame === 'function') {
                flushRaf = requestAnimationFrame(() => {
                  flushRaf = null;
                  lastFlushTime = Date.now();
                  applyStateUpdate();
                });
              }
              return;
            }
            lastFlushTime = now;
            applyStateUpdate();
          };

          const addPhase = (phase: ThinkingPhase) => {
            workingMessage.phases = [...(workingMessage.phases || []), phase];
            flushWorkingMessage(true);
          };

          const clearToolTimeout = (id: string) => {
            const state = get();
            if (state.toolTimeouts[id]) {
              clearTimeout(state.toolTimeouts[id]);
              set(s => ({ toolTimeouts: { ...s.toolTimeouts, [id]: undefined as any } }));
            }
          };

          let desktopTabOpenedForTurn = false;
          const ensureDesktopPanelOpen = () => {
            try {
              const tabsStore = useWorkspaceTabsStore.getState();
              const desktopTab = tabsStore.splitTabs.find(t => t.type === "desktop");
              if (!desktopTabOpenedForTurn || !tabsStore.isSplit || tabsStore.activeSplitTabId !== desktopTab?.id) {
                desktopTabOpenedForTurn = true;
                tabsStore.openDesktopTab();
              }
            } catch {}
          };

          const toolCallStartTimes = new Map<string, number>();

          const addOrUpdateToolCall = (toolCall: any) => {
            const existingToolCalls = workingMessage.tool_calls || [];
            const toolId = toolCall.id || toolCall.toolCallId;
            const toolName = toolCall.function_name || toolCall.name;
            const existingIndex = existingToolCalls.findIndex(tc => tc.id === toolId || (!toolId && tc.name === toolName));
            const effectiveToolName = toolName || (existingIndex >= 0 ? existingToolCalls[existingIndex].name : "");
            if (effectiveToolName === "desktop") {
              ensureDesktopPanelOpen();
            }

            if (existingIndex >= 0) {
              clearToolTimeout(existingToolCalls[existingIndex].id);
              const updatedToolCalls = [...existingToolCalls];
              const prev = updatedToolCalls[existingIndex];
              const incomingArgs = toolCall.function_arguments || toolCall.arguments;
              let nextArgs = prev.arguments;
              if (incomingArgs !== undefined && incomingArgs !== '') {
                const strIncoming = typeof incomingArgs === 'string' ? incomingArgs : JSON.stringify(incomingArgs);
                const prevStr = typeof prev.arguments === 'string' && prev.arguments !== '{}' ? prev.arguments : '';
                if (prevStr && strIncoming === '{}') {
                  nextArgs = prevStr;
                } else if (!prevStr || strIncoming.startsWith(prevStr) || (strIncoming.startsWith('{') && strIncoming.endsWith('}'))) {
                  nextArgs = strIncoming;
                } else {
                  nextArgs = prevStr + strIncoming;
                }
              }
              const toolTitle = toolCall.title || toolCall.function_title;
              const incomingDurationMs =
                typeof toolCall.durationMs === "number"
                  ? toolCall.durationMs
                  : typeof toolCall.duration_ms === "number"
                    ? toolCall.duration_ms
                    : undefined;
              const hasResult = hasToolResult(toolCall.result);
              const startedAt = toolCallStartTimes.get(prev.id);
              const resolvedDurationMs =
                incomingDurationMs !== undefined
                  ? incomingDurationMs
                  : prev.durationMs !== undefined
                    ? prev.durationMs
                    : hasResult && startedAt !== undefined
                      ? Math.max(1, Date.now() - startedAt)
                      : undefined;
              if (hasResult) {
                toolCallStartTimes.delete(prev.id);
              }
              updatedToolCalls[existingIndex] = {
                ...prev,
                title: toolTitle || prev.title,
                result: hasResult ? serializeToolResult(toolCall.result) : prev.result,
                status: hasResult ? toolResultStatus(toolCall.result) : 'calling',
                arguments: nextArgs,
                ...(resolvedDurationMs !== undefined ? { durationMs: resolvedDurationMs } : {}),
              };

              let updatedContentBlocks = workingMessage.content_blocks || [];
              let updatedImages = workingMessage.images || [];

              if (hasToolResult(toolCall.result) && !["view_image", "image_search", "desktop"].includes(effectiveToolName)) {
                try {
                  const parsed = typeof toolCall.result === 'string' ? JSON.parse(toolCall.result) : toolCall.result;
                  if (parsed && typeof parsed === 'object') {
                    const rawUrl = parsed.content_url || parsed.image_url || parsed.url || (parsed.b64_image ? `data:image/png;base64,${parsed.b64_image}` : undefined) || (typeof parsed.image === 'string' ? parsed.image : undefined);
                    let cUrl = '';
                    if (rawUrl) {
                      const t = String(rawUrl).trim();
                      if (t.startsWith('data:') || t.startsWith('blob:') || t.startsWith('http://') || t.startsWith('https://')) {
                        cUrl = t;
                      } else if (t.startsWith('//')) {
                        cUrl = `https:${t}`;
                      } else if (t.includes('.') && !t.startsWith('/')) {
                        cUrl = `https://${t}`;
                      } else {
                        cUrl = t;
                      }
                    }
                    if (cUrl && !updatedContentBlocks.some(b => b.content_url === cUrl)) {
                      updatedContentBlocks = [
                        ...updatedContentBlocks,
                        {
                          content_url: cUrl,
                          mime: parsed.mime || 'image/png',
                          return_type: parsed.return_type || 'image',
                          size_bytes: parsed.size_bytes,
                          execution_id: parsed.execution_id,
                          cost_usd: parsed.cost_usd,
                          title: toolName,
                        }
                      ];
                      updatedImages = [
                        ...updatedImages,
                        {
                          uuid: parsed.execution_id || `img_${Date.now()}`,
                          image_uuid: parsed.execution_id || `img_${Date.now()}`,
                          image_url: cUrl,
                          prompt: toolCall.function_arguments || '',
                          negative_prompt: '',
                          width: 1024,
                          height: 1024,
                          seed: null,
                          created_at: new Date().toISOString(),
                        }
                      ];
                    }
                  }
                } catch {}
              }

              workingMessage.tool_calls = updatedToolCalls;
              workingMessage.content_blocks = updatedContentBlocks.length > 0 ? updatedContentBlocks : undefined;
              workingMessage.images = updatedImages.length > 0 ? updatedImages : workingMessage.images;
              flushWorkingMessage(true);
            } else {
              const newId = toolId || `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              const toolTitle = toolCall.title || toolCall.function_title;
              const initialDurationMs =
                typeof toolCall.durationMs === "number"
                  ? toolCall.durationMs
                  : typeof toolCall.duration_ms === "number"
                    ? toolCall.duration_ms
                    : undefined;
              if (!hasToolResult(toolCall.result)) {
                toolCallStartTimes.set(newId, Date.now());
              }
              const newToolCall: ToolCallInfo = {
                id: newId,
                name: toolName,
                title: toolTitle,
                arguments: toolCall.function_arguments || toolCall.arguments
                  ? (typeof (toolCall.function_arguments || toolCall.arguments) === 'string'
                      ? (toolCall.function_arguments || toolCall.arguments)
                      : JSON.stringify(toolCall.function_arguments || toolCall.arguments))
                  : '{}',
                result: undefined,
                status: 'calling',
                ...(initialDurationMs !== undefined ? { durationMs: initialDurationMs } : {}),
              };
              const timeoutId = setTimeout(() => {
                set(s => {
                  if (!s.currentMessage?.tool_calls) return s;
                  const tcIndex = s.currentMessage.tool_calls.findIndex(tc => tc.id === newId && tc.status === 'calling');
                  if (tcIndex < 0) return s;
                  if (s.currentMessage.tool_calls[tcIndex].name === "shell_exec" || s.currentMessage.tool_calls[tcIndex].name === "desktop") return s;
                  const updated = [...s.currentMessage.tool_calls];
                  updated[tcIndex] = { ...updated[tcIndex], status: 'error' };
                  return {
                    ...s,
                    currentMessage: { ...s.currentMessage, tool_calls: updated },
                    toolTimeouts: { ...s.toolTimeouts, [newId]: undefined as any },
                  };
                });
              }, 60000);
              set(s => ({ toolTimeouts: { ...s.toolTimeouts, [newId]: timeoutId } }));
              workingMessage.tool_calls = [...existingToolCalls, newToolCall];
              flushWorkingMessage(true);
            }
          };

          let completed = false;
          let thinkingPhaseStartTime: number | null = null;
          let inThinkTag = false;

          const finishActiveThinking = (phasesList: ThinkingPhase[]) => {
            if (lastPhaseEvent === 'thinking' || phasesList.some(p => p.type === 'thinking' && p.streaming)) {
              let durationMs: number | undefined;
              let durationStr = '';
              if (thinkingPhaseStartTime) {
                durationMs = Date.now() - thinkingPhaseStartTime;
                durationStr = durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${Math.round(durationMs)}ms`;
                thinkingPhaseStartTime = null;
              }
              for (let i = phasesList.length - 1; i >= 0; i--) {
                if (phasesList[i].type === 'thinking' && phasesList[i].streaming) {
                  phasesList[i] = {
                    ...phasesList[i],
                    label: durationStr ? i18n.t("chat:execution.responseDetailsWithDuration", { duration: durationStr }) : i18n.t("chat:execution.responseDetails"),
                    durationMs,
                    streaming: false,
                  };
                }
              }
              if (!phasesList.some(p => p.type === 'thinking_done')) {
                phasesList.push({ type: 'thinking_done', label: i18n.t("chat:store.done") });
              }
            }
          };

          set({
            currentMessage: {
              ...workingMessage,
            },
          });

          if (isText) {
            const openai = new OpenAI({
              apiKey: token || "dummy-token",
              baseURL: `${env.API_URL}/v1`,
              dangerouslyAllowBrowser: true,
              defaultHeaders: workspaceHeaders(),
              timeout: 30 * 60 * 1000,
              maxRetries: 0,
            });

            const finalizeOpenAIStream = (msgUuid?: string, finalTitle?: string, fileDiff?: FileDiffData) => {
              if (completed) return;
              completed = true;
              cancelPendingFlush();

              const currentToolCalls = workingMessage.tool_calls || get().currentMessage?.tool_calls || [];
              const currentContentBlocks = workingMessage.content_blocks || get().currentMessage?.content_blocks || [];
              const currentImages = workingMessage.images || get().currentMessage?.images || [];
              let completedPhases = workingMessage.phases ? [...workingMessage.phases] : (get().currentMessage?.phases ? [...get().currentMessage!.phases!] : undefined);
              if (completedPhases) {
                finishActiveThinking(completedPhases);
                completedPhases = completedPhases.map((p: ThinkingPhase) => ({ ...p, streaming: false }));
              }
              const hasThinking = completedPhases?.some((p: ThinkingPhase) => p.type === 'thinking') ?? false;
              if (completedPhases && hasThinking && !completedPhases.some((p: ThinkingPhase) => p.type === 'thinking_done')) {
                completedPhases = [...completedPhases, { type: 'thinking_done' as const, label: i18n.t("chat:store.done") }];
              }

              const completedMessage: Message = {
                uuid: msgUuid || returnedRequestId || `msg_${Date.now()}`,
                role: "assistant",
                content: fullContent || '',
                thinking: fullThinking || undefined,
                thinkingSummary: workingMessage.thinkingSummary || get().currentMessage?.thinkingSummary,
                thinkingSegments: workingMessage.thinkingSegments || get().currentMessage?.thinkingSegments || undefined,
                thinkingTokens: workingMessage.thinkingTokens || get().currentMessage?.thinkingTokens,
                totalDurationMs: Date.now() - streamStartTime,
                phases: completedPhases,
                parent: returnedUserMessageId || workingMessage.parent || get().currentMessage?.parent || tempId,
                created_at: new Date().toISOString(),
                model: modelToUse,
                modelDisplayName: resolveModelDisplayName(modelToUse),
                type: (currentImages.length > 0 && !fullContent) ? 'image' : 'text',
                images: currentImages,
                content_blocks: currentContentBlocks.length > 0 ? currentContentBlocks : undefined,
                tool_calls: currentToolCalls.length > 0 ? currentToolCalls : undefined,
                file_diff: fileDiff || (workingMessage as any).file_diff || undefined,
              };

              const conversationUuid = returnedConversationId || currentConversationId || effectiveConvId || get().conversationId;
              if (conversationUuid) {
                get().setConversationGenerating(conversationUuid, false);

                const currentCache = get().conversationCache;
                const targetEntry = currentCache[conversationUuid] || {
                  messages: get().conversationId === conversationUuid ? get().messages : [],
                  selectedMessage: null,
                  activeRequestId: null,
                  activeRequestParentId: null,
                  activeRequestModelType: null,
                  isStreaming: false,
                  updatedAt: Date.now(),
                };

                // Strictly preserve and append chronologically: never drop existing messages!
                const currentMessages = get().conversationId === conversationUuid ? get().messages : (targetEntry.messages || []);
                const normalizedMessages = currentMessages.map(m => (m.uuid === tempId && returnedUserMessageId) ? { ...m, uuid: returnedUserMessageId, clientKey: m.clientKey ?? m.uuid } : m);
                const updatedTargetMessages = normalizedMessages.some(m => m.uuid === completedMessage.uuid)
                  ? normalizedMessages.map(m => m.uuid === completedMessage.uuid ? completedMessage : m)
                  : [...normalizedMessages, completedMessage];

                const nextCache = {
                  ...currentCache,
                  [conversationUuid]: {
                    ...targetEntry,
                    messages: updatedTargetMessages,
                    currentMessage: null,
                    isStreaming: false,
                    activeRequestId: null,
                    activeRequestParentId: null,
                    activeRequestModelType: null,
                    selectedMessage: completedMessage,
                    updatedAt: Date.now(),
                  }
                };

                if (get().conversationId === conversationUuid) {
                  set(state => ({
                    conversationCache: nextCache,
                    messages: updatedTargetMessages,
                    currentMessage: null,
                    isStreaming: false,
                    isActivelyGenerating: false,
                    selectedMessage: completedMessage,
                    useModelStartingLoading: false,
                    abortController: null,
                    activeRequestId: null,
                    activeRequestParentId: null,
                    activeRequestModelType: null,
                    toolTimeouts: {},
                  }));
                } else {
                  set({
                    conversationCache: nextCache,
                    abortController: null,
                    isActivelyGenerating: false,
                  });
                }
              } else {
                set(state => ({
                  messages: [...state.messages, completedMessage],
                  currentMessage: null,
                  isStreaming: false,
                  isActivelyGenerating: false,
                  selectedMessage: completedMessage,
                  useModelStartingLoading: false,
                  abortController: null,
                  activeRequestId: null,
                  activeRequestParentId: null,
                  activeRequestModelType: null,
                  toolTimeouts: {},
                }));
              }

              if (conversationUuid) {
                const titleToUse = finalTitle || returnedTitle;
                if (titleToUse) {
                  useSidebarStore.getState().setConversationTitle(conversationUuid, titleToUse);
                } else {
                  const sidebar = useSidebarStore.getState();
                  const existingIndex = sidebar.conversations.findIndex(c => c.uuid === conversationUuid);
                  if (existingIndex < 0) {
                    sidebar.setConversationTitle(conversationUuid, i18n.t("chat:store.newConversation"));
                  }
                }
              }
            };

            payload.stateful = true;

            const stream = await openai.chat.completions.create({
              ...payload,
              stream: true,
            } as any, {
              signal: streamController.signal,
            }) as any;

            for await (const chunk of stream) {
              if ((chunk as any)?.error) {
                const errObj = (chunk as any).error;
                const msg = errObj?.message || (typeof errObj === "string" ? errObj : JSON.stringify(errObj));
                throw new Error(msg || i18n.t("chat:store.streamingError"));
              }

              const metadata = (chunk as any).neuronrunner_metadata;
              if (metadata) {
                if (metadata.conversation_id && !currentConversationId && returnedConversationId !== metadata.conversation_id) {
                  const oldId = returnedConversationId || effectiveConvId;
                  returnedConversationId = metadata.conversation_id;
                  linkToActiveProject(metadata.conversation_id);
                  if (oldId && oldId !== metadata.conversation_id) {
                    get().setConversationGenerating(oldId, false);
                  }
                  get().setConversationGenerating(metadata.conversation_id, true);
                  if (get().conversationId === oldId || !get().conversationId) {
                    set({
                      conversationId: metadata.conversation_id,
                      skipFetchConversationId: metadata.conversation_id
                    });
                  }
                  const sidebar = useSidebarStore.getState();
                  const existingIndex = sidebar.conversations.findIndex(c => c.uuid === metadata.conversation_id);
                  const previewTitle = actualTrimmed.slice(0, 40) || i18n.t("chat:store.newConversation");
                  if (existingIndex < 0) {
                    sidebar.setConversationTitle(
                      metadata.conversation_id,
                      previewTitle
                    );
                  }
                  try {
                    useWorkspaceTabsStore.getState().openChatTab(metadata.conversation_id, previewTitle);
                  } catch {}
                  const resolver = get().newConversationResolver;
                  if (resolver) {
                    resolver(metadata.conversation_id);
                    set({ newConversationResolver: null });
                  }
                }
                if (metadata.request_id && returnedRequestId !== metadata.request_id) {
                  returnedRequestId = metadata.request_id;
                  set({ activeRequestId: metadata.request_id });
                }
                if (metadata.user_message_uuid && returnedUserMessageId !== metadata.user_message_uuid) {
                  returnedUserMessageId = metadata.user_message_uuid;
                  set(state => {
                    const updatedMessages = state.messages.map(m => m.uuid === tempId ? { ...m, uuid: metadata.user_message_uuid, clientKey: m.clientKey ?? m.uuid } : m);
                    const convId = returnedConversationId || state.conversationId;
                    const updatedCache = { ...state.conversationCache };
                    if (convId && updatedCache[convId]) {
                      updatedCache[convId] = {
                        ...updatedCache[convId],
                        messages: updatedMessages,
                        selectedMessage: state.selectedMessage?.uuid === tempId
                          ? { ...state.selectedMessage, uuid: metadata.user_message_uuid }
                          : state.selectedMessage,
                      };
                    }
                    return {
                      messages: updatedMessages,
                      conversationCache: updatedCache,
                      selectedMessage: state.selectedMessage?.uuid === tempId
                        ? { ...state.selectedMessage, uuid: metadata.user_message_uuid }
                        : state.selectedMessage,
                      currentMessage: state.currentMessage ? { ...state.currentMessage, parent: metadata.user_message_uuid } : null,
                      activeRequestParentId: metadata.user_message_uuid,
                    };
                  });
                }
                if (metadata.file_diff) {
                  (workingMessage as any).file_diff = metadata.file_diff;
                }
                if (metadata.title) {
                  returnedTitle = metadata.title;
                  const convId = returnedConversationId || get().conversationId;
                  if (convId) {
                    useSidebarStore.getState().setConversationTitle(convId, metadata.title);
                  }
                }
              }

              const choice = chunk.choices?.[0];
              if (choice) {
                const delta = choice.delta;

                let rawChunkStr = delta.content || '';
                let reasoningContent = (delta as any).reasoning_content || (delta as any).reasoning || (delta as any).thinking || '';

                // Streaming <think> tag parser (for Ollama, DeepSeek-R1, vLLM models outputting <think> in content)
                let chunkStr = '';
                if (rawChunkStr) {
                  let buffer = rawChunkStr;
                  while (buffer.length > 0) {
                    if (!inThinkTag) {
                      const thinkOpenIdx = buffer.indexOf('<think>');
                      if (thinkOpenIdx !== -1) {
                        chunkStr += buffer.slice(0, thinkOpenIdx);
                        buffer = buffer.slice(thinkOpenIdx + 7);
                        inThinkTag = true;
                      } else {
                        chunkStr += buffer;
                        buffer = '';
                      }
                    } else {
                      const thinkCloseIdx = buffer.indexOf('</think>');
                      if (thinkCloseIdx !== -1) {
                        reasoningContent += buffer.slice(0, thinkCloseIdx);
                        buffer = buffer.slice(thinkCloseIdx + 8);
                        inThinkTag = false;
                      } else {
                        reasoningContent += buffer;
                        buffer = '';
                      }
                    }
                  }
                }

                // Handle tool calls
                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const outputText = terminalOutputText(tc.output);
                    if (outputText && tc.id) {
                      const calls = workingMessage.tool_calls || [];
                      const index = calls.findIndex(call => call.id === tc.id);
                      if (index >= 0) {
                        clearToolTimeout(tc.id);
                        const updated = [...calls];
                        updated[index] = { ...updated[index], output: (terminalOutputText(updated[index].output) + outputText).slice(-65536), status: "calling" };
                        workingMessage.tool_calls = updated;
                        flushWorkingMessage();
                      }
                    }
                    const toolName = tc.function?.name;
                    const toolCallId = tc.id;

                    if (toolName || hasToolResult(tc.result)) {
                      if (lastPhaseEvent === 'thinking') {
                        const phases = workingMessage.phases ? [...workingMessage.phases] : [];
                        finishActiveThinking(phases);
                        workingMessage.phases = phases;
                      }
                      addOrUpdateToolCall({
                        id: toolCallId,
                        function_name: toolName,
                        function_arguments: tc.function?.arguments || '',
                        result: tc.result,
                        title: tc.title,
                        duration_ms: (tc as any).duration_ms ?? (tc as any).durationMs,
                      });
                      const hasToolPhase = toolCallId
                        ? (workingMessage.phases || []).some(phase => phase.toolCallId === toolCallId)
                        : lastPhaseEvent === 'tool_call';
                      if (toolName && !hasToolPhase) {
                        currentRound++;
                        if (workingMessage.phases) {
                          const phases = [...workingMessage.phases];
                          const lastP = phases[phases.length - 1];
                          if (lastP && lastP.type === 'content') {
                            phases[phases.length - 1] = { ...lastP, streaming: false };
                            workingMessage.phases = phases;
                          }
                        }
                        addPhase({ type: "tool_call", label: formatToolName(toolName) || '…', toolName, toolCallId, round: currentRound });
                        lastPhaseEvent = 'tool_call';
                      }
                      if (hasToolResult(tc.result)) {
                        if (workingMessage.phases) {
                          const phases = [...workingMessage.phases];
                          const idx = phases.findIndex(p => p.toolCallId === toolCallId);
                          if (idx >= 0) {
                            const label = `${formatToolName(phases[idx].toolName || '')} - ${toolResultStatus(tc.result) === "error" ? "Failed" : "Done"}`;
                            phases[idx] = {
                              ...phases[idx],
                              type: 'tool_result',
                              label,
                            };
                            workingMessage.phases = phases;
                          }
                        }
                        flushWorkingMessage(true);
                        try {
                          const sandboxStore = useSandboxProjectsStore.getState();
                          const targetUuid = sandboxStore.workspaceSandbox?.uuid || sandboxStore.currentSandbox?.uuid;
                          if (targetUuid) {
                            sandboxStore.fetchFiles(targetUuid);
                          }
                        } catch (e) {
                          console.error("Failed to fetch files on tool result:", e);
                        }
                      }
                    } else if (tc.function?.arguments) {
                      const toolCalls = workingMessage.tool_calls || [];
                      const targetIndex = tc.id
                        ? toolCalls.findIndex(call => call.id === tc.id)
                        : (tc.index != null && toolCalls[tc.index] ? tc.index : toolCalls.length - 1);
                      if (targetIndex >= 0 && toolCalls[targetIndex]) {
                        const prev = toolCalls[targetIndex];
                        const prevArgs = typeof prev.arguments === 'string' && prev.arguments !== '{}' ? prev.arguments : '';
                        const incoming = tc.function.arguments;
                        if (!(prevArgs && incoming === '{}')) {
                          const nextArgs = prevArgs && incoming.startsWith(prevArgs) ? incoming : (prevArgs + incoming);
                          const updated = [...toolCalls];
                          updated[targetIndex] = {
                            ...prev,
                            arguments: nextArgs,
                          };
                          workingMessage.tool_calls = updated;
                          flushWorkingMessage();
                        }
                      }
                    }
                  }
                }

                // Handle reasoning_content / reasoning
                let phaseToAdd: ThinkingPhase | null = null;
                const prevPhaseEvent = lastPhaseEvent;
                if (reasoningContent) {
                  fullThinking += reasoningContent;
                  if (lastPhaseEvent !== 'thinking') {
                    thinkingPhaseStartTime = Date.now();
                    // If a whitespace-only content phase was added before thinking started, clean it up
                    if (workingMessage.phases) {
                      workingMessage.phases = workingMessage.phases.filter(
                        p => !(p.type === 'content' && !(p.chunk || '').trim())
                      );
                    }
                    currentRound++;
                    phaseToAdd = {
                      type: "thinking",
                      label: i18n.t("chat:store.thinking"),
                      round: currentRound,
                      chunk: reasoningContent,
                      streaming: true,
                    };
                    lastPhaseEvent = 'thinking';
                  }
                }

                // Handle content
                if (chunkStr) {
                  fullContent += chunkStr;
                }

                if (chunkStr && lastPhaseEvent === 'thinking') {
                  const phases = workingMessage.phases ? [...workingMessage.phases] : [];
                  finishActiveThinking(phases);
                  workingMessage.phases = phases;
                }

                let isNewContentRound = false;
                if (chunkStr) {
                  if (lastPhaseEvent !== 'content') {
                    currentRound++;
                    lastPhaseEvent = 'content';
                    isNewContentRound = true;
                  }
                }

                if (reasoningContent || chunkStr) {
                  let segments = workingMessage.thinkingSegments;
                  if (reasoningContent) {
                    segments = [...(segments || [])];
                    if (prevPhaseEvent !== 'thinking') {
                      segments.push(reasoningContent);
                    } else {
                      segments[segments.length - 1] += reasoningContent;
                    }
                  }

                  let phases = workingMessage.phases ? [...workingMessage.phases] : [];
                  if (phaseToAdd) {
                    phases.push(phaseToAdd);
                  } else if (reasoningContent && lastPhaseEvent === 'thinking' && phases.length > 0) {
                    const lastPhase = phases[phases.length - 1];
                    if (lastPhase && lastPhase.type === 'thinking' && lastPhase.round === currentRound) {
                      phases[phases.length - 1] = {
                        ...lastPhase,
                        chunk: (lastPhase.chunk || '') + reasoningContent,
                        streaming: true,
                      };
                    }
                  }

                  if (chunkStr) {
                    const lastPhase = phases[phases.length - 1];
                    if (!isNewContentRound && lastPhase && lastPhase.type === 'content' && lastPhase.round === currentRound) {
                      phases[phases.length - 1] = {
                        ...lastPhase,
                        chunk: (lastPhase.chunk || '') + chunkStr,
                        streaming: true,
                      };
                    } else {
                      phases.push({
                        type: 'content',
                        label: '',
                        chunk: chunkStr,
                        round: currentRound,
                        streaming: true,
                      });
                    }
                  }

                  workingMessage.content = fullContent;
                  workingMessage.thinking = fullThinking || undefined;
                  workingMessage.thinkingSegments = segments;
                  workingMessage.phases = phases;
                  workingMessage.lastChunk = chunkStr || reasoningContent || undefined;

                  flushWorkingMessage(false);
                }

                // Handle finish reason
                if (choice.finish_reason === "stop") {
                  const msgUuid = metadata?.message_uuid;
                  const finishTitle = metadata?.title || returnedTitle;
                  const finishDiff = metadata?.file_diff || (workingMessage as any).file_diff;
                  flushWorkingMessage(true);
                  finalizeOpenAIStream(msgUuid, finishTitle || undefined, finishDiff);
                }
              }
            }

            flushWorkingMessage(true);
            finalizeOpenAIStream(undefined, returnedTitle || undefined, (workingMessage as any).file_diff);
          }

          if (!completed) {
            throw new Error(i18n.t("chat:store.requestFailedBeforeCompletion"));
          }

          const resolvedConversationId = returnedConversationId || currentConversationId || effectiveConvId;
          if (!resolvedConversationId) {
            throw new Error(i18n.t("chat:store.conversationCreationFailed"));
          }

          linkToActiveProject(resolvedConversationId);

          return resolvedConversationId;
        } catch (e: any) {
          const resolver = get().newConversationResolver;
          if (resolver) {
            resolver("");
            set({ newConversationResolver: null });
          }
          cancelPendingFlush();
          const resolvedConversationId = returnedConversationId || currentConversationId || effectiveConvId || get().conversationId;
          if (resolvedConversationId) {
            get().setConversationGenerating(resolvedConversationId, false);
          }

          const errorMessage = e?.error?.message || e?.message || i18n.t("chat:store.sendMessageFailed");
          const isCancelAbort = e?.name === "AbortError" || e?.name === "APIUserAbortError" || errorMessage === "Generation canceled by user.";
          if (!isCancelAbort) {
            notifyInsufficientBalanceIfNeeded?.(e, errorMessage);
          }
          if (isCancelAbort) {
            const currentMsg = get().currentMessage;
            const hasPartial = currentMsg && (
              Boolean(fullContent?.trim()) ||
              Boolean(fullThinking?.trim()) ||
              Boolean(currentMsg.tool_calls?.length) ||
              Boolean(currentMsg.phases?.length) ||
              Boolean(currentMsg.content?.trim()) ||
              Boolean(currentMsg.thinking?.trim())
            );

            let nextMessages = get().messages;
            let finalMsg: Message | null = null;
            if (hasPartial && currentMsg) {
              finalMsg = {
                uuid: returnedRequestId || currentMsg.uuid || `canceled-${Date.now()}`,
                role: "assistant",
                content: fullContent || currentMsg.content || '',
                thinking: fullThinking || currentMsg.thinking || undefined,
                thinkingSummary: currentMsg.thinkingSummary,
                thinkingSegments: currentMsg.thinkingSegments,
                thinkingTokens: currentMsg.thinkingTokens,
                totalDurationMs: Date.now() - streamStartTime,
                phases: currentMsg.phases || undefined,
                parent: returnedUserMessageId || currentMsg.parent || tempId,
                created_at: currentMsg.created_at || new Date().toISOString(),
                model: get().selectedModel || undefined,
                tag: get().selectedModelIsReasoning && get().reasoningLevel && get().reasoningLevel !== "none" ? get().reasoningLevel : undefined,
                type: 'text',
                tool_calls: currentMsg.tool_calls?.length ? currentMsg.tool_calls : undefined,
              };
              if (!nextMessages.some(m => m.uuid === finalMsg!.uuid || (m.role === "assistant" && m.parent === finalMsg!.parent))) {
                nextMessages = [...nextMessages, finalMsg];
              }
            }

            const targetConv = returnedConversationId || currentConversationId || effectiveConvId || get().conversationId;
            const nextCache = targetConv ? {
              ...get().conversationCache,
              [targetConv]: {
                ...(get().conversationCache[targetConv] || {}),
                messages: nextMessages,
                currentMessage: null,
                isStreaming: false,
                updatedAt: Date.now(),
              }
            } : get().conversationCache;

            set({
              messages: nextMessages,
              conversationCache: nextCache,
              selectedMessage: finalMsg || get().selectedMessage,
              isStreaming: false,
              isActivelyGenerating: false,
              currentMessage: null,
              useModelStartingLoading: false,
              abortController: null,
              activeRequestId: null,
              activeRequestParentId: null,
              activeRequestModelType: null,
              toolTimeouts: {},
              error: null,
            });
            return resolvedConversationId;
          }

          const currentMsg = get().currentMessage;
          const hasPartialGeneration = currentMsg && (
            fullContent ||
            fullThinking ||
            currentMsg.tool_calls?.length ||
            currentMsg.phases?.length
          );

          if (hasPartialGeneration) {
            const completedMessage: Message = {
              uuid: returnedRequestId || `failed-${Date.now()}`,
              role: "assistant",
              content: fullContent || '',
              thinking: fullThinking || undefined,
              thinkingSummary: currentMsg.thinkingSummary,
              thinkingSegments: currentMsg.thinkingSegments,
              thinkingTokens: currentMsg.thinkingTokens,
              totalDurationMs: Date.now() - streamStartTime,
              phases: currentMsg.phases || undefined,
              parent: returnedUserMessageId || currentMsg.parent,
              created_at: currentMsg.created_at || new Date().toISOString(),
              model: get().selectedModel || undefined,
              tag: get().selectedModelIsReasoning && get().reasoningLevel && get().reasoningLevel !== "none" ? get().reasoningLevel : undefined,
              type: 'text',
              tool_calls: currentMsg.tool_calls?.length ? currentMsg.tool_calls : undefined,
              error: errorMessage,
            };

            set(state => ({
              messages: [...state.messages, completedMessage],
              isStreaming: false,
              isActivelyGenerating: false,
              currentMessage: null,
              selectedMessage: completedMessage,
              error: errorMessage,
              useModelStartingLoading: false,
              abortController: null,
              activeRequestId: null,
              activeRequestParentId: null,
              activeRequestModelType: null,
              toolTimeouts: {},
            }));
          } else {
            const failedMessage: Message = {
              uuid: `error-${Date.now()}`,
              role: "assistant",
              content: errorMessage,
              parent: returnedUserMessageId,
              created_at: new Date().toISOString(),
              type: "error",
            };

            set(state => ({
              messages: [...state.messages, failedMessage],
              isStreaming: false,
              isActivelyGenerating: false,
              currentMessage: null,
              selectedMessage: failedMessage,
              error: errorMessage,
              useModelStartingLoading: false,
              abortController: null,
              activeRequestId: null,
              activeRequestParentId: null,
              activeRequestModelType: null,
              toolTimeouts: {},
            }));
          }
          return null;
        } finally {
          const finishedConvId = returnedConversationId || currentConversationId || effectiveConvId;
          if (finishedConvId) {
            get().setConversationGenerating(finishedConvId, false);
          }
          const currentConv = get().conversationId;
          if (currentConv === finishedConvId || !currentConv) {
            set({
              isLoading: false,
              isStreaming: false,
              isActivelyGenerating: false,
              useModelStartingLoading: false,
              abortController: null,
            });
          } else {
            set({
              abortController: null,
              isActivelyGenerating: false,
            });
          }
          try {
            const sandboxStore = useSandboxProjectsStore.getState();
            const targetUuid = sandboxStore.workspaceSandbox?.uuid || sandboxStore.currentSandbox?.uuid;
            if (targetUuid) {
              sandboxStore.fetchFiles(targetUuid);
            }
          } catch (e) {
            console.error("Failed to fetch files after streaming completion:", e);
          }
        }
      },

      cancelGeneration: async () => {
        const token = localStorage.getItem("token");
        const { activeRequestId, abortController, conversationId, currentMessage } = get();

        if (abortController) {
          abortController.abort();
        }

        if (conversationId) {
          get().setConversationGenerating(conversationId, false);
        }

        const currentMsg = currentMessage || get().currentMessage;
        const hasPartial = currentMsg && (
          Boolean(currentMsg.content?.trim()) ||
          Boolean(currentMsg.thinking?.trim()) ||
          Boolean(currentMsg.tool_calls?.length) ||
          Boolean(currentMsg.phases?.length) ||
          Boolean(currentMsg.images?.length)
        );

        let nextMessages = get().messages;
        let finalMsg: Message | null = null;
        if (hasPartial && currentMsg) {
          finalMsg = {
            ...currentMsg,
            uuid: currentMsg.uuid || activeRequestId || `msg_${Date.now()}`,
            role: "assistant",
            type: currentMsg.type || "text",
            created_at: currentMsg.created_at || new Date().toISOString(),
          };
          if (!nextMessages.some(m => m.uuid === finalMsg!.uuid || (m.role === "assistant" && m.parent === finalMsg!.parent))) {
            nextMessages = [...nextMessages, finalMsg];
          }
        }

        const targetConv = conversationId;
        const nextCache = targetConv ? {
          ...get().conversationCache,
          [targetConv]: {
            ...(get().conversationCache[targetConv] || {}),
            messages: nextMessages,
            currentMessage: null,
            isStreaming: false,
            activeRequestId: null,
            updatedAt: Date.now(),
          }
        } : get().conversationCache;

        set({
          messages: nextMessages,
          conversationCache: nextCache,
          selectedMessage: finalMsg || get().selectedMessage,
          isStreaming: false,
          isActivelyGenerating: false,
          currentMessage: null,
          useModelStartingLoading: false,
          abortController: null,
          activeRequestId: null,
          activeRequestParentId: null,
          activeRequestModelType: null,
          toolTimeouts: {},
        });

        const cancelPayload = currentMsg ? {
          content: currentMsg.content || undefined,
          thinking: currentMsg.thinking || undefined,
          tool_calls: currentMsg.tool_calls?.length ? currentMsg.tool_calls : undefined,
          phases: currentMsg.phases?.length ? currentMsg.phases : undefined,
        } : {};

        const cancelPromises: Promise<any>[] = [];
        if (activeRequestId && token) {
          cancelPromises.push(
            fetch(`${env.API_URL}/requests/${activeRequestId}/cancel/`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
                ...workspaceHeaders(),
              },
              body: JSON.stringify(cancelPayload),
            }).catch((error) => {
              console.error("Failed to cancel generation by request ID:", error);
            })
          );
        }

        if (conversationId && token) {
          cancelPromises.push(
            fetch(`${env.API_URL}/conversations/${conversationId}/cancel/`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
                ...workspaceHeaders(),
              },
              body: JSON.stringify(cancelPayload),
            }).catch((error) => {
              console.error("Failed to cancel generation by conversation ID:", error);
            })
          );
        }

        if (cancelPromises.length > 0) {
          await Promise.allSettled(cancelPromises);
        }

        if (conversationId) {
          try {
            await get().fetchConversation(conversationId);
          } catch (error) {
            console.error("Failed to refresh conversation after cancel:", error);
          }
        }

        return true;
      },
      stopStreaming: () => {
        const { abortController, conversationId, currentMessage } = get();
        if (conversationId) {
          get().setConversationGenerating(conversationId, false);
        }
        if (abortController) {
          abortController.abort();
        }

        const currentMsg = currentMessage || get().currentMessage;
        const hasPartial = currentMsg && (
          Boolean(currentMsg.content?.trim()) ||
          Boolean(currentMsg.thinking?.trim()) ||
          Boolean(currentMsg.tool_calls?.length) ||
          Boolean(currentMsg.phases?.length) ||
          Boolean(currentMsg.images?.length)
        );

        let nextMessages = get().messages;
        let finalMsg: Message | null = null;
        if (hasPartial && currentMsg) {
          finalMsg = {
            ...currentMsg,
            uuid: currentMsg.uuid || `msg_${Date.now()}`,
            role: "assistant",
            type: currentMsg.type || "text",
            created_at: currentMsg.created_at || new Date().toISOString(),
          };
          if (!nextMessages.some(m => m.uuid === finalMsg!.uuid || (m.role === "assistant" && m.parent === finalMsg!.parent))) {
            nextMessages = [...nextMessages, finalMsg];
          }
        }

        const targetConv = conversationId;
        const nextCache = targetConv ? {
          ...get().conversationCache,
          [targetConv]: {
            ...(get().conversationCache[targetConv] || {}),
            messages: nextMessages,
            currentMessage: null,
            isStreaming: false,
            activeRequestId: null,
            updatedAt: Date.now(),
          }
        } : get().conversationCache;

        set({
          messages: nextMessages,
          conversationCache: nextCache,
          selectedMessage: finalMsg || get().selectedMessage,
          isStreaming: false,
          isActivelyGenerating: false,
          currentMessage: null,
          useModelStartingLoading: false,
          abortController: null,
          activeRequestId: null,
          activeRequestParentId: null,
          activeRequestModelType: null,
          toolTimeouts: {},
        });
      },
      reset: () => {
        const state = get();
        let updatedCache = state.conversationCache;
        if (state.conversationId && state.messages.length > 0) {
          updatedCache = {
            ...updatedCache,
            [state.conversationId]: {
              messages: state.messages,
              currentMessage: state.currentMessage,
              activeRequestId: state.activeRequestId,
              activeRequestParentId: state.activeRequestParentId,
              activeRequestModelType: state.activeRequestModelType,
              isStreaming: state.isStreaming,
              selectedMessage: state.selectedMessage,
              updatedAt: Date.now(),
            }
          };
        }
        set({
          conversationCache: updatedCache,
          conversationId: null,
          messages: [],
          currentMessage: null,
          isLoading: false,
          isStreaming: false,
          error: null,
          useModelStartingLoading: false,
          abortController: null,
          fetchAbortController: null,
          activeRequestId: null,
          activeRequestParentId: null,
          activeRequestModelType: null,
          toolTimeouts: {},
        });
      }
    }),
    {
      name: "chat-store",
      storage: createJSONStorage(() =>
        typeof window !== "undefined"
          ? window.localStorage
          : {
              getItem: () => null,
              setItem: () => {},
              removeItem: () => {},
            }
      ),
      partialize: (state) => ({
        selectedModel: state.selectedModel,
        selectedModelType: state.selectedModelType,
        selectedModelIsReasoning: state.selectedModelIsReasoning,
        selectedModelReasoningMode: state.selectedModelReasoningMode,
        selectedModelReasoningTiers: state.selectedModelReasoningTiers,
        selectedModelDefaultReasoningEffort: state.selectedModelDefaultReasoningEffort,
        temperature: state.temperature,
        topP: state.topP,
        systemPrompt: state.systemPrompt,
        reasoningLevel: state.reasoningLevel,
        reasoningLevelByModel: state.reasoningLevelByModel,
        chatMode: state.chatMode,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          let targetModel = state.selectedModel;
          if (targetModel === "llama3.3" || !targetModel || targetModel === "deepseek-v4.1-flash") {
            targetModel = INITIAL_DEFAULT_MODEL;
          } else if (targetModel && targetModel.includes(":")) {
            const parts = targetModel.split(":");
            if (parts.length === 2 && parts[0] === parts[1]) {
              targetModel = parts[0];
            }
          }
          const key = extractModelKey(targetModel);
          if (key && state.reasoningLevel && !state.reasoningLevelByModel?.[key]) {
            state.reasoningLevelByModel = {
              ...(state.reasoningLevelByModel || {}),
              [key]: state.reasoningLevel,
            };
          }
          state.setSelectedModel(targetModel);
        }
      },
    }
  )
);

export default useChatStore;
