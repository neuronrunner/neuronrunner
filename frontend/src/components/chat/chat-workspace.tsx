"use client";

import { env } from "@/lib/env";
import { useEffect, useRef, useMemo, useCallback, useState, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation } from "react-router-dom";
import { useParams, usePathname, useRouter } from "@/lib/navigation";
import { LuLoader as LuLoader2 } from "react-icons/lu";
import { cn, formatModelIdentifier } from "@/lib/utils";
import { toaster } from "@/components/ui/toaster";
import useChatStore, { type Message } from "@/stores/chat";
import useAuthStore from "@/stores/auth";
import useRecentModelsStore from "@/stores/recent-models";
import PromptInput from "@/components/prompt-input";
import { LoadingDots } from "@/components/loading-dots";
import ChatMessage from "@/components/chat/chat-message";
import { mergeRequestUpdateMessage } from "@/components/chat/normalize-tool-calls";
import {
  animatePromptPosition,
  clearPromptTransition,
  promptPosition,
  promptAnimationTime,
  takePromptTransition,
  NEW_CHAT_TRANSITION_ID,
  PROMPT_TRANSITION_DURATION,
  type PromptPosition,
} from "@/lib/prompt-transition";
import useSandboxProjectsStore from "@/stores/sandbox-projects";
import useSidebarStore from "@/stores/sidebar";
import useWorkspaceTabsStore from "@/stores/workspace-tabs";
import ChatProjectSelector from "@/components/projects/chat-project-selector";
import CloudAgentSelector from "@/components/chat/cloud-agent-selector";
import AmbientGlow from "@/components/chat/ambient-glow";
import { HomeSuggestions } from "@/components/home-welcome";
import { SEO } from "@/components/seo";
import frontendExtension from "@cloud";

/**
 * Unified chat workspace shared across `/new` and `/chat/:uuid`.
 *
 * Keeping one mounted composer and message viewport across the `/new` -> `/chat/:uuid`
 * handoff prevents prompt focus loss, Suspense flashes, and user-message remounts.
 */
const ChatWorkspace = () => {
  const { t } = useTranslation("chat");
  const { t: tLanding } = useTranslation("landing");
  const { items: cloudRuntimes, selectedUuid: selectedCloudRuntimeUuid } = frontendExtension.runtimeBridge.useRuntimeList();
  const activeCloudRuntime = useMemo(() => {
    if (frontendExtension.edition !== "cloud") return null;
    return (
      cloudRuntimes.find((r) => r.uuid === selectedCloudRuntimeUuid && r.status !== "terminated") ||
      cloudRuntimes.find((r) => r.status === "running") ||
      cloudRuntimes.find((r) => r.status !== "terminated") ||
      null
    );
  }, [cloudRuntimes, selectedCloudRuntimeUuid]);
  const params = useParams();
  const pathname = usePathname();
  const location = useLocation();
  const router = useRouter();
  const uuid = pathname === "/new" ? undefined : (params?.uuid as string | undefined);
  const isNewRoute = pathname === "/new" || uuid === "new";

  const {
    messages,
    isLoading,
    isStreaming,
    isActivelyGenerating: isActivelyGeneratingGlobal,
    sendMessage,
    fetchConversation,
    selectedModel,
    selectedModelType,
    selectedModelIsReasoning,
    selectedModelReasoningMode,
    selectedModelReasoningTiers,
    selectedModelDefaultReasoningEffort,
    useModelStartingLoading,
    setSelectedModel,
    setSelectedModelType,
    setCurrentMessage,
    setConversationId,
    currentMessage,
    conversationId,
    activeRequestId,
    abortController: abortControllerGlobal,
    cancelGeneration,
    reset,
    reasoningLevel,
    reasoningLevelByModel,
    setReasoningLevel,
    fetchModelDetails,
    chatMode,
    setChatMode,
    draftPrompt,
    setDraftPrompt,
  } = useChatStore();
  const generatingConversations = useChatStore((state) => state.generatingConversations);
  // isActivelyGenerating / abortController are global: they belong to whichever
  // conversation started the stream. Scope them to the one being viewed so other
  // chats don't appear to be running.
  const ownsLocalStream = Boolean(conversationId && generatingConversations?.[conversationId]);
  const isActivelyGenerating = isActivelyGeneratingGlobal && ownsLocalStream;
  const abortController = ownsLocalStream ? abortControllerGlobal : null;

  const { sandboxes, sandboxConversations, currentSandbox, linkConversationToSandbox, ensureSandboxes, pickSandbox } =
    useSandboxProjectsStore();
  const { token, user } = useAuthStore();
  const { recentModels, loadRecentModels } = useRecentModelsStore();

  const [isSendingFromNew, setIsSendingFromNew] = useState(false);
  const [newSendNonce, setNewSendNonce] = useState(0);
  const [createdFromNewUuid, setCreatedFromNewUuid] = useState<string | null>(null);
  const [sentMessageText, setSentMessageText] = useState("");
  const [trackedRouteKey, setTrackedRouteKey] = useState(() => (isNewRoute ? "__new__" : uuid || "__new__"));

  const currentRouteKey = isNewRoute ? "__new__" : (uuid || "__new__");
  if (trackedRouteKey !== currentRouteKey) {
    setTrackedRouteKey(currentRouteKey);
    if (isNewRoute || (uuid && createdFromNewUuid !== uuid)) {
      setIsSendingFromNew(false);
      setSentMessageText("");
      setCreatedFromNewUuid(null);
    }
  }

  const isCreatedFromNewSession =
    (isNewRoute && isSendingFromNew) ||
    (Boolean(uuid) && createdFromNewUuid === uuid);
  const isLandingMode = isNewRoute && !isSendingFromNew;
  const activeSessionKey = isCreatedFromNewSession
    ? `new-sending-${newSendNonce}`
    : isNewRoute
      ? "new-landing"
      : `chat-${uuid || ""}`;

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contentContainerRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const latestTurnAnchorRef = useRef<HTMLDivElement>(null);
  const latestTurnSpacerRef = useRef<HTMLDivElement>(null);
  const bottomAnchorRef = useRef<HTMLDivElement>(null);
  const streamAnchorRef = useRef<HTMLDivElement | null>(null);
  const promptWrapperRef = useRef<HTMLDivElement>(null);

  const sendingPositionRef = useRef<PromptPosition | null>(null);
  const transitionEndsAtRef = useRef(0);
  const navigatedConversationRef = useRef<string | null>(null);
  const mountedRef = useRef(false);

  const programmaticScrollRef = useRef(false);
  const shouldAutoScrollRef = useRef(true);
  const suppressAutoScrollUntilRef = useRef(0);
  const lastUserScrollTimeRef = useRef(0);
  const isUserScrollingRef = useRef(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollTopRef = useRef(0);

  const fetchRef = useRef<string | null>(null);
  const previousMessageCountRef = useRef(0);
  const lastFetchedModelRef = useRef<string | null>(null);
  const streamedMessageIdsRef = useRef(new Set<string>());
  const streamedReplyParentsRef = useRef(new Set<string>());
  const localMessageKeysRef = useRef(new Set<string>());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    streamedMessageIdsRef.current.clear();
    streamedReplyParentsRef.current.clear();
    localMessageKeysRef.current.clear();
  }, [activeSessionKey]);

  useEffect(() => {
    if (!isStreaming) return;
    if (currentMessage?.uuid) streamedMessageIdsRef.current.add(currentMessage.uuid);
    // Live replies often have no UUID until completion. Their prompt remains
    // identifiable when the completed reply moves into the persisted list.
    const parent = currentMessage?.parent || messages.findLast((message) => message.role === "user")?.uuid;
    if (parent) streamedReplyParentsRef.current.add(parent);
  }, [activeSessionKey, isStreaming, currentMessage?.uuid, currentMessage?.parent, messages]);

  const updateLatestTurnSpace = useCallback(() => {
    const container = scrollContainerRef.current;
    const content = contentContainerRef.current;
    const anchor = latestTurnAnchorRef.current;
    const spacer = latestTurnSpacerRef.current;
    if (!container || !content || !spacer) return;

    const padding = getComputedStyle(content);
    // Reserve a viewport for the latest prompt and answer, even while loading.
    // Layout offsets stay stable during message entrance animations.
    const turnHeight = anchor ? spacer.offsetTop - anchor.offsetTop : 0;
    const height = anchor
      ? Math.max(
          0,
          container.clientHeight -
            turnHeight -
            parseFloat(padding.paddingTop) -
            parseFloat(padding.paddingBottom) -
            1
        )
      : 0;
    const nextHeight = `${height}px`;
    if (spacer.style.height !== nextHeight) spacer.style.height = nextHeight;
  }, []);

  useLayoutEffect(() => {
    if (!isLandingMode) {
      updateLatestTurnSpace();
    }
  });

  useLayoutEffect(() => {
    if (activeSessionKey === "new-landing") {
      navigatedConversationRef.current = null;
      sendingPositionRef.current = null;
      fetchRef.current = null;
      previousMessageCountRef.current = 0;
      reset();
    }
  }, [activeSessionKey, reset]);

  useLayoutEffect(() => {
    const element = promptWrapperRef.current;
    if (!element) return;

    if (activeSessionKey === "new-landing") {
      const transition = takePromptTransition(NEW_CHAT_TRANSITION_ID);
      if (!transition) {
        delete element.dataset.composerHandoff;
        return;
      }
      element.dataset.composerHandoff = "true";
      const elapsed = promptAnimationTime() - (transition.endsAt - PROMPT_TRANSITION_DURATION);
      const promptAnimation = animatePromptPosition(element, transition.position, PROMPT_TRANSITION_DURATION, elapsed);
      return () => {
        promptAnimation?.cancel();
      };
    }

    if (activeSessionKey.startsWith("new-sending-")) {
      const position = sendingPositionRef.current;
      if (!position) return;
      element.dataset.composerHandoff = "true";
      const elapsed = promptAnimationTime() - (transitionEndsAtRef.current - PROMPT_TRANSITION_DURATION);
      const promptAnimation = animatePromptPosition(element, position, PROMPT_TRANSITION_DURATION, elapsed);
      const messageAnimation = contentContainerRef.current
        ? animatePromptPosition(contentContainerRef.current, position, PROMPT_TRANSITION_DURATION, elapsed)
        : null;
      return () => {
        promptAnimation?.cancel();
        messageAnimation?.cancel();
      };
    }

    if (uuid && uuid !== "new") {
      const transition = takePromptTransition(uuid);
      if (!transition) {
        delete element.dataset.composerHandoff;
        return;
      }
      element.dataset.composerHandoff = "true";
      const elapsed = promptAnimationTime() - (transition.endsAt - PROMPT_TRANSITION_DURATION);
      const promptAnimation = animatePromptPosition(element, transition.position, PROMPT_TRANSITION_DURATION, elapsed);
      return () => {
        promptAnimation?.cancel();
      };
    }
  }, [activeSessionKey, uuid]);

  const navigateToConversation = useCallback(
    (id: string, message = sentMessageText) => {
      if (!mountedRef.current || navigatedConversationRef.current || !id || id.startsWith("temp-")) return;
      navigatedConversationRef.current = id;
      setCreatedFromNewUuid(id);
      document.body.classList.remove("nav-from-home");
      const previewTitle = message.replace(/[\r\n\t]+/g, " ").trim().slice(0, 35) || tLanding("home.newConversation");
      useWorkspaceTabsStore.getState().openChatTab(id, previewTitle);
      router.push(`/chat/${id}`);
    },
    [router, sentMessageText, tLanding]
  );

  useEffect(() => {
    if (isNewRoute && isSendingFromNew && conversationId) {
      navigateToConversation(conversationId);
    }
  }, [isNewRoute, isSendingFromNew, conversationId, navigateToConversation]);

  // Auto-detect if conversation belongs to a workspace sandbox and activate Code mode
  useEffect(() => {
    if (!uuid || uuid === "new") return;
    const store = useSandboxProjectsStore.getState();
    const matchingSandbox = store.sandboxes.find(
      (s) => s.conversation === uuid || (store.sandboxConversations[s.uuid] || []).includes(uuid)
    );
    if (matchingSandbox) {
      if (chatMode !== "code") {
        setChatMode("code");
      }
      if (store.currentSandbox?.uuid !== matchingSandbox.uuid) {
        void pickSandbox(matchingSandbox.uuid);
      }
    }
  }, [uuid, sandboxes, sandboxConversations, chatMode, setChatMode, pickSandbox]);

  useEffect(() => {
    if (uuid && uuid !== "new") {
      if (createdFromNewUuid === uuid) {
        if (useChatStore.getState().skipFetchConversationId === uuid) {
          useChatStore.setState({ skipFetchConversationId: null });
        }
        fetchRef.current = uuid;
        return;
      }

      const skipFetchId = useChatStore.getState().skipFetchConversationId;
      if (skipFetchId === uuid) {
        useChatStore.setState({ skipFetchConversationId: null });
        fetchRef.current = uuid;
        return;
      }
      if (fetchRef.current === uuid) return;

      const currentStore = useChatStore.getState();
      const isAlreadyActive =
        currentStore.conversationId === uuid && (currentStore.messages.length > 0 || currentStore.isStreaming);
      if (isAlreadyActive) {
        fetchRef.current = uuid;
        return;
      }

      previousMessageCountRef.current = 0;
      shouldAutoScrollRef.current = true;
      lastUserScrollTimeRef.current = 0;
      scrollContainerRef.current?.scrollTo({ top: 0, behavior: "auto" });

      useChatStore.getState().switchConversation(uuid);
      fetchRef.current = uuid;

      const hasCachedMessages = (useChatStore.getState().conversationCache[uuid]?.messages?.length ?? 0) > 0;
      fetchConversation(uuid, { silent: hasCachedMessages });
    } else if (uuid === "new") {
      setConversationId(null);
      fetchRef.current = "new";
      useChatStore.setState({
        messages: [],
        currentMessage: null,
        error: null,
        isStreaming: false,
        activeRequestId: null,
      });
    }

    return () => {
      const currentStoreState = useChatStore.getState();
      if (currentStoreState.isStreaming) {
        return;
      }
      if (uuid === "new") fetchRef.current = null;
    };
  }, [uuid, createdFromNewUuid, setConversationId, fetchConversation]);

  useEffect(() => {
    if (uuid && uuid !== "new") {
      const sidebarConv = useSidebarStore.getState().conversations.find((c) => c.uuid === uuid);
      useWorkspaceTabsStore.getState().openChatTab(uuid, sidebarConv?.title);
    }
  }, [uuid]);

  useEffect(() => {
    if (uuid && uuid !== "new" && conversationId === uuid && messages.length > 0) {
      const { tabs, splitTabs, updateChatTabTitle } = useWorkspaceTabsStore.getState();
      const currentTab = [...tabs, ...splitTabs].find(
        (tab) => tab.type === "chat" && tab.conversationUuid === uuid
      );
      if (currentTab) {
        const isGeneric =
          !currentTab.title ||
          currentTab.title === "Conversation" ||
          currentTab.title === "New Chat" ||
          currentTab.title === "New Conversation" ||
          currentTab.title.startsWith("New Conversation");

        if (isGeneric) {
          const sidebarConv = useSidebarStore.getState().conversations.find((c) => c.uuid === uuid);
          if (
            sidebarConv?.title &&
            sidebarConv.title !== "New Conversation" &&
            sidebarConv.title !== "Conversation" &&
            sidebarConv.title !== "Untitled Conversation"
          ) {
            updateChatTabTitle(uuid, sidebarConv.title);
          } else {
            const firstUserMsg = messages.find((m) => m.role === "user");
            if (firstUserMsg?.content) {
              const clean = firstUserMsg.content
                .replace(/^[\s#>*_`~-]+/, "")
                .replace(/[\r\n\t]+/g, " ")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 35);
              if (clean) {
                updateChatTabTitle(uuid, clean);
              }
            }
          }
        }
      }
    }
  }, [uuid, messages, conversationId]);

  useEffect(() => {
    if (token) {
      void loadRecentModels(token);
      if (isNewRoute) {
        void ensureSandboxes();
      }
    }
  }, [token, isNewRoute, loadRecentModels, ensureSandboxes]);

  useEffect(() => {
    if (!selectedModel) {
      useChatStore.getState().setSelectedModelIsReasoning(false);
      return;
    }
    if (lastFetchedModelRef.current === selectedModel) return;
    lastFetchedModelRef.current = selectedModel;
    void useChatStore.getState().fetchModelDetails(selectedModel);
  }, [selectedModel]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || isLandingMode) return;

    const handleScroll = () => {
      const currentScrollTop = container.scrollTop;
      const distanceFromBottom = container.scrollHeight - container.clientHeight - currentScrollTop;

      if (distanceFromBottom <= 80 && Date.now() >= suppressAutoScrollUntilRef.current) {
        shouldAutoScrollRef.current = true;
        isUserScrollingRef.current = false;
      } else if (!programmaticScrollRef.current) {
        if (currentScrollTop < lastScrollTopRef.current - 15) {
          shouldAutoScrollRef.current = false;
          isUserScrollingRef.current = true;
        }
      }
      lastScrollTopRef.current = currentScrollTop;
    };

    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < -10) {
        const distanceFromBottom = container.scrollHeight - container.clientHeight - container.scrollTop;
        if (distanceFromBottom > 30) {
          shouldAutoScrollRef.current = false;
          isUserScrollingRef.current = true;
        }
      } else if (e.deltaY > 10) {
        const distanceFromBottom = container.scrollHeight - container.clientHeight - container.scrollTop;
        if (distanceFromBottom <= 120) {
          shouldAutoScrollRef.current = true;
          isUserScrollingRef.current = false;
        }
      }
    };

    let touchStartY = 0;
    const handleTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0]?.clientY ?? 0;
    };
    const handleTouchMove = (e: TouchEvent) => {
      const currentY = e.touches[0]?.clientY ?? 0;
      const deltaY = currentY - touchStartY;
      if (deltaY > 20) {
        const distanceFromBottom = container.scrollHeight - container.clientHeight - container.scrollTop;
        if (distanceFromBottom > 30) {
          shouldAutoScrollRef.current = false;
          isUserScrollingRef.current = true;
        }
      } else if (deltaY < -20) {
        const distanceFromBottom = container.scrollHeight - container.clientHeight - container.scrollTop;
        if (distanceFromBottom <= 120) {
          shouldAutoScrollRef.current = true;
          isUserScrollingRef.current = false;
        }
      }
    };

    const handleActivityInteraction = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest("[data-execution-group]")) return;
      shouldAutoScrollRef.current = false;
      isUserScrollingRef.current = true;
      suppressAutoScrollUntilRef.current = Date.now() + 500;
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    container.addEventListener("wheel", handleWheel, { passive: true });
    container.addEventListener("touchstart", handleTouchStart, { passive: true });
    container.addEventListener("touchmove", handleTouchMove, { passive: true });
    container.addEventListener("pointerdown", handleActivityInteraction, { passive: true });
    container.addEventListener("click", handleActivityInteraction);
    return () => {
      container.removeEventListener("scroll", handleScroll);
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("pointerdown", handleActivityInteraction);
      container.removeEventListener("click", handleActivityInteraction);
    };
  }, [isLandingMode]);

  useEffect(() => {
    if (isLandingMode) return;
    const prev = previousMessageCountRef.current;
    const hasNewMessages = messages.length > prev;
    previousMessageCountRef.current = messages.length;

    if (!hasNewMessages) return;
    if (!shouldAutoScrollRef.current || Date.now() < suppressAutoScrollUntilRef.current) return;

    const container = scrollContainerRef.current;
    if (container) {
      programmaticScrollRef.current = true;
      container.scrollTop = container.scrollHeight;
      requestAnimationFrame(() => {
        if (container && shouldAutoScrollRef.current) {
          container.scrollTop = container.scrollHeight;
        }
        programmaticScrollRef.current = false;
      });
    }
  }, [messages.length, isLandingMode]);

  useEffect(() => {
    if (isLandingMode || !isStreaming) return;
    if (shouldAutoScrollRef.current && Date.now() >= suppressAutoScrollUntilRef.current && scrollContainerRef.current) {
      programmaticScrollRef.current = true;
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
    }
  }, [isLandingMode, isStreaming, currentMessage]);

  useEffect(() => {
    if (isLandingMode) return;
    const el = contentContainerRef.current;
    const container = scrollContainerRef.current;
    if (!el || !container || typeof ResizeObserver === "undefined") return;

    let rafId: number | null = null;
    const observer = new ResizeObserver(() => {
      updateLatestTurnSpace();
      if (shouldAutoScrollRef.current && isStreaming && Date.now() >= suppressAutoScrollUntilRef.current) {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          rafId = null;
          if (shouldAutoScrollRef.current && isStreaming && Date.now() >= suppressAutoScrollUntilRef.current && container) {
            programmaticScrollRef.current = true;
            container.scrollTop = container.scrollHeight;
            requestAnimationFrame(() => {
              programmaticScrollRef.current = false;
            });
          }
        });
      }
    });

    observer.observe(el);
    observer.observe(container);
    if (messagesContainerRef.current) observer.observe(messagesContainerRef.current);
    return () => {
      observer.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [updateLatestTurnSpace, activeSessionKey, isLandingMode, isLoading, isStreaming]);

  useEffect(() => {
    const timerRef = scrollTimeoutRef;
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!conversationId || !activeRequestId || !isStreaming || isActivelyGenerating || abortController) return;

    const authToken = token || (typeof window !== "undefined" ? localStorage.getItem("token") : null);
    if (!authToken) return;

    const API_BASE = env.API_URL || "";
    const wsBase = API_BASE.replace(/^https/, "wss").replace(/^http/, "ws");
    const wsUrl = `${wsBase}/ws/chat/request/${activeRequestId}/`;

    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(wsUrl);
      const socket = ws;
      socket.onopen = () => socket.send(JSON.stringify({ type: "auth", token: authToken }));

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "request_update" && msg.request) {
            const requestData = msg.request;
            const status = requestData.status;
            const partialContent = requestData.partial_content ?? "";
            const partialThinking = requestData.partial_thinking ?? "";
            const modelType = requestData.model_type === "image" ? "image" : "text";

            if ((status === "processing" || status === "pending") && modelType === "text") {
              useChatStore.getState().setConversationGenerating(conversationId, true);
              const store = useChatStore.getState();
              if (store.conversationId === conversationId && !(store.generatingConversations?.[conversationId] && (store.isActivelyGenerating || store.abortController))) {
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
            }

            if (status === "completed" || status === "failed" || status === "canceled") {
              useChatStore.getState().setConversationGenerating(conversationId, false);
              void fetchConversation(conversationId);
              ws?.close();
              stopped = true;
            }
          }
        } catch (err) {
          console.error("Failed to parse request status WebSocket message:", err);
        }
      };

      ws.onclose = (event) => {
        if (!stopped && event.code !== 1000 && event.code !== 1001) {
          reconnectTimeout = setTimeout(connect, 3000);
        }
      };

      ws.onerror = (err) => {
        console.error("Request status WebSocket error:", err);
      };
    };

    connect();

    const pollInterval = setInterval(() => {
      const store = useChatStore.getState();
      const ownsStream = Boolean(store.generatingConversations?.[conversationId]) && (store.isActivelyGenerating || Boolean(store.abortController));
      if (!ownsStream && store.isStreaming && store.activeRequestId) {
        void fetchConversation(conversationId, { silent: true });
      }
    }, 2000);

    return () => {
      stopped = true;
      clearInterval(pollInterval);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) ws.close();
    };
  }, [conversationId, activeRequestId, isStreaming, isActivelyGenerating, abortController, fetchConversation, setCurrentMessage, token]);

  const currentMessageUuid = currentMessage?.uuid;

  const currentModelName = useMemo(() => {
    if (!selectedModel) return t("page.defaultModel");
    return selectedModel.split(":")[0] || t("page.defaultModel");
  }, [selectedModel, t]);

  const loadingLabel = useMemo(() => t("page.loadingModel", { model: currentModelName }), [currentModelName, t]);

  const conversationChain = useMemo<Message[]>(() => {
    if (!messages.length) return [];
    const sorted = [...messages].sort(
      (a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime()
    );

    const chain: Message[] = [];
    for (const msg of sorted) {
      const prev = chain[chain.length - 1];
      if (
        prev &&
        msg.role === "assistant" &&
        prev.role === "assistant" &&
        Boolean(msg.parent) &&
        msg.parent === prev.parent
      ) {
        const prevTools = prev.tool_calls?.length || 0;
        const currTools = msg.tool_calls?.length || 0;
        const prevLen = (prev.content?.length || 0) + (prev.thinking?.length || 0);
        const currLen = (msg.content?.length || 0) + (msg.thinking?.length || 0);
        if (currTools > prevTools || (currTools === prevTools && currLen >= prevLen)) {
          chain[chain.length - 1] = msg;
        }
      } else {
        chain.push(msg);
      }
    }

    if (isStreaming && currentMessageUuid && chain[chain.length - 1]?.uuid === currentMessageUuid) {
      chain.pop();
    }

    return chain;
  }, [messages, isStreaming, currentMessageUuid]);

  const lastChainUuidRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    lastChainUuidRef.current = conversationChain[conversationChain.length - 1]?.uuid;
  }, [conversationChain]);

  const onSendNew = useCallback(
    async (message: string, files?: File[]) => {
      const trimmed = message.trim();
      if (isSendingFromNew || (!trimmed && (!files || files.length === 0))) return;
      if (!user || !token) return;

      if (promptWrapperRef.current) {
        sendingPositionRef.current = promptPosition(promptWrapperRef.current);
      }
      clearPromptTransition();
      transitionEndsAtRef.current = promptAnimationTime() + PROMPT_TRANSITION_DURATION;
      navigatedConversationRef.current = null;
      setCreatedFromNewUuid(null);
      setSentMessageText(trimmed);
      if (draftPrompt) setDraftPrompt(null);
      setNewSendNonce((n) => n + 1);
      setIsSendingFromNew(true);

      try {
        const currentSandboxUuid = currentSandbox?.uuid;
        const sending = sendMessage(message, undefined, undefined, undefined, files);
        const controller = useChatStore.getState().abortController;
        const newUuid = await sending;
        if (currentSandboxUuid && newUuid && !newUuid.startsWith("temp-")) {
          linkConversationToSandbox(currentSandboxUuid, newUuid);
        }
        if (!mountedRef.current || navigatedConversationRef.current) return;
        if (controller?.signal.aborted) {
          setIsSendingFromNew(false);
          clearPromptTransition();
          if (!useChatStore.getState().conversationId) reset();
          return;
        }
        if (!newUuid || newUuid.startsWith("temp-")) {
          throw new Error(useChatStore.getState().error || tLanding("home.errors.createConversationFailed"));
        }
        navigateToConversation(newUuid, trimmed);
      } catch (err: any) {
        if (!mountedRef.current || navigatedConversationRef.current) return;
        setIsSendingFromNew(false);
        setSentMessageText("");
        clearPromptTransition();
        if (!useChatStore.getState().conversationId) {
          reset();
        }
        toaster.create({
          title: tLanding("home.errors.messageFailedTitle"),
          description: err?.message || tLanding("home.errors.messageFailedDescription"),
          type: "error",
        });
      }
    },
    [
      isSendingFromNew,
      user,
      token,
      draftPrompt,
      setDraftPrompt,
      currentSandbox?.uuid,
      sendMessage,
      linkConversationToSandbox,
      navigateToConversation,
      reset,
      tLanding,
    ]
  );

  const onSendConversation = useCallback(
    async (content: string, files?: File[]) => {
      shouldAutoScrollRef.current = true;
      isUserScrollingRef.current = false;
      lastUserScrollTimeRef.current = 0;
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
        scrollTimeoutRef.current = null;
      }

      const container = scrollContainerRef.current;
      if (container) {
        programmaticScrollRef.current = true;
        container.scrollTop = container.scrollHeight;
        requestAnimationFrame(() => {
          programmaticScrollRef.current = false;
        });
      }

      if (draftPrompt) setDraftPrompt(null);
      await sendMessage(content, lastChainUuidRef.current, undefined, undefined, files);
    },
    [sendMessage, draftPrompt, setDraftPrompt]
  );

  const onSend = useCallback(
    (content: string, files?: File[]) => {
      if (isLandingMode) {
        return onSendNew(content, files);
      }
      return onSendConversation(content, files);
    },
    [isLandingMode, onSendNew, onSendConversation]
  );

  const filteredChain = useMemo(
    () =>
      conversationChain.filter(
        (msg) =>
          msg.content ||
          msg.thinking ||
          msg.thinkingSegments?.length ||
          (msg.type === "image" && msg.images?.length) ||
          (msg.images && msg.images.length > 0) ||
          (msg.content_blocks && msg.content_blocks.length > 0) ||
          msg.tool_calls?.length ||
          msg.phases?.length ||
          msg.error
      ),
    [conversationChain]
  );

  useEffect(() => {
    for (const msg of filteredChain) {
      if (msg.clientKey || (msg.uuid && msg.uuid.startsWith("temp-"))) {
        localMessageKeysRef.current.add(msg.clientKey || msg.uuid || "");
      }
    }
  }, [filteredChain]);

  const showInitialLoading = !isNewRoute && isLoading && filteredChain.length === 0;
  const latestTurnIndex = useMemo(() => {
    const lastUserIndex = filteredChain.findLastIndex((message) => message.role === "user");
    return lastUserIndex >= 0 ? lastUserIndex : filteredChain.length - 1;
  }, [filteredChain]);

  const isLiveTextStream =
    isStreaming &&
    currentMessage?.type === "text" &&
    (currentMessage.content ||
      currentMessage.thinking ||
      currentMessage.tool_calls?.length ||
      currentMessage.phases?.length ||
      currentMessage.images?.length ||
      currentMessage.content_blocks?.length ||
      false);

  const showLivePlaceholder =
    isStreaming &&
    !isLiveTextStream &&
    (!currentMessage ||
      (!currentMessage.content &&
        !currentMessage.thinking &&
        !currentMessage.tool_calls?.length &&
        !currentMessage.phases?.length));

  if (isNewRoute && (!user || !token)) {
    return <Navigate replace to={`/${location.search}${location.hash}`} />;
  }

  return (
    <div className="isolate relative flex flex-col flex-1 h-full min-h-0 overflow-hidden">
      {isNewRoute && <SEO title={tLanding("home.newConversation")} noindex={true} />}
      {(isNewRoute || isCreatedFromNewSession) && <AmbientGlow isSending={!isLandingMode} />}

      {!isLandingMode && (
        <div
          id="chat-scroll-container"
          className="flex-1 overflow-y-auto overflow-x-hidden"
          ref={scrollContainerRef}
          style={{ willChange: "scroll-position", WebkitOverflowScrolling: "touch", overflowAnchor: "none" }}
        >
          <div
            ref={contentContainerRef}
            className="relative mx-auto flex w-full max-w-4xl min-w-0 flex-1 flex-col px-5 pb-28 pt-6 md:px-6 md:pb-36"
          >
            {showInitialLoading ? (
              <div className="chat-enter flex items-center justify-center flex-1 h-full py-20" style={{ animationDelay: "180ms" }}>
                <LuLoader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div
                key={activeSessionKey}
                ref={messagesContainerRef}
                className="min-w-0 flex flex-col"
              >
                {filteredChain.map((msg, index) => {
                  const renderKey = msg.clientKey || msg.uuid || `msg-${msg.created_at}-${msg.role}`;
                  const isLocallyCreated =
                    isCreatedFromNewSession ||
                    Boolean(msg.clientKey) ||
                    Boolean(msg.uuid && msg.uuid.startsWith("temp-")) ||
                    localMessageKeysRef.current.has(renderKey) ||
                    streamedMessageIdsRef.current.has(msg.uuid || "") ||
                    (msg.role === "assistant" && streamedReplyParentsRef.current.has(msg.parent || ""));

                  return (
                    <div
                      key={renderKey}
                      className={cn(
                        "mb-2 w-full min-w-0",
                        !isLocallyCreated && "chat-enter"
                      )}
                      style={isLocallyCreated ? undefined : { animationDelay: `${180 + Math.min(index, 5) * 100}ms` }}
                      ref={index === latestTurnIndex ? latestTurnAnchorRef : undefined}
                    >
                      <ChatMessage message={msg} />
                    </div>
                  );
                })}

                {isStreaming && (
                  <div
                    className={cn(
                      "flex flex-col self-stretch w-full min-w-0 overflow-hidden",
                      !isCreatedFromNewSession && "chat-enter"
                    )}
                    style={
                      isCreatedFromNewSession
                        ? undefined
                        : { animationDelay: `${180 + Math.min(filteredChain.length, 5) * 100}ms` }
                    }
                  >
                    {isLiveTextStream && currentMessage ? (
                      <div className="mb-2 w-full min-w-0" ref={streamAnchorRef}>
                        <ChatMessage
                          key="live-stream-message"
                          message={currentMessage}
                          isLive
                        />
                      </div>
                    ) : showLivePlaceholder ? (
                      useModelStartingLoading ? (
                        <div className="flex items-center gap-2.5 px-1 py-2">
                          <LuLoader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          <span className="text-xs font-medium text-muted-foreground">
                            {loadingLabel}
                          </span>
                        </div>
                      ) : currentSandbox?.setup_status === "running" ||
                        (frontendExtension.edition === "cloud" &&
                          Boolean(activeCloudRuntime) &&
                          ["pending", "provisioning", "starting"].includes(activeCloudRuntime?.status || "")) ? (
                        <div ref={streamAnchorRef} className="inline-flex items-center gap-2.5 px-1 py-2">
                          <LuLoader2 className="h-3.5 w-3.5 animate-spin text-indigo-400" />
                          <span className="text-xs font-medium text-muted-foreground animate-pulse">
                            {t("composer.preparingEnvironment", { defaultValue: "Preparing environment..." })}
                          </span>
                        </div>
                      ) : (
                        <div ref={streamAnchorRef} className="px-1 py-2">
                          <LoadingDots />
                        </div>
                      )
                    ) : useModelStartingLoading ? (
                      <div className="flex items-center gap-3 px-1 py-2">
                        <LuLoader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        <span className="text-xs font-mono text-muted-foreground">
                          {loadingLabel}
                        </span>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            )}
            <div ref={latestTurnSpacerRef} aria-hidden="true" className="w-full shrink-0 pointer-events-none" />
            <div ref={bottomAnchorRef} className="h-px w-full pointer-events-none opacity-0" />
          </div>
        </div>
      )}

      {!isLandingMode && (
        <div className="absolute bottom-0 left-0 right-0 h-[140px] pointer-events-none z-10 bg-gradient-to-t from-background via-background/40 to-transparent" />
      )}

      <div
        className={cn(
          isLandingMode
            ? "relative z-10 flex-1 flex flex-col items-center justify-center w-full max-w-4xl mx-auto min-h-0 gap-3.5 translate-y-8 sm:translate-y-14"
            : "contents"
        )}
      >
        {isLandingMode && (
          <div
            className="chat-enter flex w-full max-w-2xl items-center justify-between gap-2 px-3 sm:max-w-[700px] sm:px-4"
            style={{ animationDelay: "100ms" }}
          >
            <ChatProjectSelector />
            <CloudAgentSelector vmAttached={Boolean(currentSandbox)} />
          </div>
        )}

        <div
          ref={promptWrapperRef}
          data-chat-composer={isLandingMode ? "home" : "conversation"}
          className={cn(
            "w-full prompt-input-transition",
            isLandingMode && "mx-auto max-w-2xl sm:max-w-[700px] px-3 sm:px-4"
          )}
          style={
            isLandingMode
              ? undefined
              : {
                  maxWidth: "56rem",
                  position: "absolute",
                  paddingLeft: "1rem",
                  paddingRight: "1rem",
                  bottom: "1rem",
                  left: 0,
                  right: 0,
                  margin: "auto",
                  zIndex: 20,
                }
          }
        >
          <PromptInput
            compact={isLandingMode}
            className={cn("prompt-input-transition w-full", isLandingMode && "chat-enter chat-enter--composer")}
            style={isLandingMode ? { animationDelay: "340ms" } : undefined}
            initialValue={draftPrompt || undefined}
            onSend={onSend}
            loading={isLandingMode ? false : (isSendingFromNew && !conversationId) || isStreaming || isActivelyGenerating}
            onCancel={() => {
              if (isNewRoute && !useChatStore.getState().conversationId) {
                setIsSendingFromNew(false);
                setSentMessageText("");
                void cancelGeneration().finally(() => {
                  if (!useChatStore.getState().conversationId) {
                    reset();
                  }
                });
                return;
              }
              void cancelGeneration();
            }}
            placeholder={
              isLandingMode
                ? chatMode === "code"
                  ? tLanding("home.prompt.codePlaceholder")
                  : tLanding("home.prompt.chatPlaceholder")
                : chatMode === "code"
                  ? t("composer.codePlaceholder")
                  : t("composer.chatPlaceholder")
            }
            mobilePlaceholder={
              isLandingMode
                ? chatMode === "code"
                  ? tLanding("home.prompt.codeMobilePlaceholder")
                  : tLanding("home.prompt.chatMobilePlaceholder")
                : chatMode === "code"
                  ? t("composer.codeMobilePlaceholder")
                  : t("composer.chatMobilePlaceholder")
            }
            currentModel={selectedModel}
            modelType={selectedModelType === "image" ? "image" : "text"}
            recentModels={recentModels}
            onSelectModel={(model) => {
              setSelectedModel(model);
              const recent = recentModels.find((m) => {
                const identifier = m?.name
                  ? formatModelIdentifier(m.name)
                  : formatModelIdentifier(m?.model, m?.tag);
                return identifier === model;
              });
              const resolvedType = recent?.model_type ?? recent?.modelType ?? recent?.type;
              if (resolvedType === "text" || resolvedType === "image") setSelectedModelType(resolvedType);
              void fetchModelDetails(model);
            }}
            reasoningLevel={reasoningLevel}
            reasoningLevelByModel={reasoningLevelByModel}
            setReasoningLevel={setReasoningLevel}
            showReasoningOptions={selectedModelIsReasoning}
            reasoningMode={selectedModelReasoningMode}
            reasoningTiers={selectedModelReasoningTiers}
            defaultReasoningEffort={selectedModelDefaultReasoningEffort}
          />
        </div>

        {isLandingMode && <HomeSuggestions mode={chatMode} onSelect={setDraftPrompt} />}
      </div>
    </div>
  );
};

export default ChatWorkspace;
