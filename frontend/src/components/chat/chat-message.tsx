"use client";

import { memo, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { FaCopy } from "react-icons/fa";
import { LuCheck, LuCopy, LuUndo2, LuLoader as LuLoader2 } from "react-icons/lu";
import ChatErrorMessage from "@/components/chat-error-message";
import ContentRenderer from "@/components/content-renderer";
import MarkdownRenderer from "@/components/markdown-renderer";
import { toaster } from "@/components/ui/toaster";
import useChatStore, { type Message } from "@/stores/chat";
import useModelStore from "@/stores/search-models";
import StreamView from "@/components/chat/stream-view";
import { buildStreamFromMessage } from "@/components/chat/stream-builder";
import MessageAttachments from "@/components/message-attachments";
import DiffView from "@/components/chat/diff-view";
import { cn, formatModelIdentifier } from "@/lib/utils";
import { isReasoningTier } from "@/lib/reasoning";

interface ChatMessageProps {
  message: Message;
  isLive?: boolean;
}

function formatResponseDuration(
  ms: number | undefined,
  t: TFunction<"chat">
): string {
  if (ms == null || ms <= 0 || !Number.isFinite(ms)) return "";
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return [
      t("message.durationHours", { count: hours }),
      minutes > 0 ? t("message.durationMinutes", { count: minutes }) : null,
      seconds > 0 ? t("message.durationSeconds", { count: seconds }) : null,
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (minutes > 0) {
    return [
      t("message.durationMinutes", { count: minutes }),
      seconds > 0 ? t("message.durationSeconds", { count: seconds }) : null,
    ]
      .filter(Boolean)
      .join(" ");
  }

  return t("message.durationSeconds", { count: seconds });
}

const ChatMessage = memo(function ChatMessage({
  message,
  isLive = false,
}: ChatMessageProps) {
  const { t } = useTranslation("chat");
  const setSelectedModel = useChatStore((state) => state.setSelectedModel);
  const setSelectedModelType = useChatStore((state) => state.setSelectedModelType);
  const setReasoningLevel = useChatStore((state) => state.setReasoningLevel);
  const fetchModelDetails = useChatStore((state) => state.fetchModelDetails);
  const isStreaming = useChatStore((state) => state.isStreaming);
  const undoMessage = useChatStore((state) => state.undoMessage);
  const conversationId = useChatStore((state) => state.conversationId);

  const isUser = message.role === "user";
  const isErrorMessage = !isUser && message.type === "error";

  const [hovered, setHovered] = useState(false);
  const [isUndoing, setIsUndoing] = useState(false);
  const [copied, setCopied] = useState(false);

  const displayContent = message.content.trim();
  const isStreamable =
    !isUser &&
    !isErrorMessage &&
    (message.phases?.length ||
      message.thinkingSegments?.length ||
      message.tool_calls?.length ||
      message.thinking?.trim() ||
      displayContent);

  const stream = useMemo(
    () => (isStreamable ? buildStreamFromMessage(message) : null),
    [isStreamable, message]
  );

  const handleCopy = () => {
    if (!message.content) return;
    try {
      navigator.clipboard.writeText(message.content);
      toaster.create({ title: t("message.copiedToClipboard"), type: "success" });
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = message.content;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      try {
        document.execCommand("copy");
      } catch {}
      document.body.removeChild(textarea);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const handleUndo = async () => {
    if (!message.uuid || isUndoing || isStreaming) return;
    setIsUndoing(true);
    try {
      const res = await undoMessage(message.uuid, conversationId || undefined);
      if (res.ok) {
        toaster.create({ title: t("message.undone"), type: "info" });
      } else {
        toaster.create({
          title: t("message.undoFailed"),
          description: res.error || t("message.unexpectedError"),
          type: "error",
        });
      }
    } finally {
      setIsUndoing(false);
    }
  };

  const handleModelSelect = (
    modelName?: string,
    tagName?: string,
    modelType?: "text" | "image"
  ) => {
    if (!modelName) return;
    if (tagName && isReasoningTier(tagName)) {
      setSelectedModel(modelName);
      setReasoningLevel(tagName);
      setSelectedModelType(modelType || "text");
      void fetchModelDetails(modelName);
      toaster.create({
        title: t("message.modelSetTo", { model: formatModelIdentifier(modelName, tagName) }),
        type: "info",
      });
      return;
    }
    const modelIdentifier = formatModelIdentifier(modelName, tagName);
    setSelectedModel(modelIdentifier);
    setSelectedModelType(modelType || "text");
    toaster.create({ title: t("message.modelSetTo", { model: modelIdentifier }), type: "info" });
  };

  const hasDiff = Boolean(
    message.file_diff &&
      (message.file_diff.has_changes || (message.file_diff.files && message.file_diff.files.length > 0))
  );

  const storeModels = useModelStore((s) => s.models);

  const modelLabel = useMemo(() => {
    const clean = (raw: string) => raw.replace(/\s*\(BYOS\)\s*$/i, "").trim();
    if (message.modelDisplayName) return clean(message.modelDisplayName);
    if (!message.model) return "";
    const matched = storeModels.find((m) => m.name === message.model);
    if (matched?.display_name) return clean(matched.display_name);
    return formatModelIdentifier(message.model, message.tag);
  }, [message.model, message.modelDisplayName, message.tag, storeModels]);

  const durationLabel = useMemo(
    () => formatResponseDuration(message.totalDurationMs, t),
    [message.totalDurationMs, t]
  );

  return (
    <div
      className={cn(
        "flex w-full min-w-0 flex-col overflow-hidden",
        isUser ? "self-end" : "self-start"
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className={cn(
          "flex flex-row w-full items-start min-w-0",
          isUser ? "justify-end" : "justify-start"
        )}
      >
        <div
          className={cn(
            "mb-1 min-w-0 max-w-full overflow-hidden",
            isUser ? "p-0" : "p-2",
            isUser ? "ml-auto max-w-[72%]" : "w-full"
          )}
        >
          {isUser ? (
            <div className="rounded-2xl p-3.5 bg-zinc-500/15 dark:bg-zinc-500/15 border border-zinc-500/20 shadow-sm">
              <p className="whitespace-pre-wrap text-[15px] sm:text-base text-foreground leading-relaxed">{message.content}</p>
              <MessageAttachments attachments={message.attachments} />
            </div>
          ) : (
            <div className="flex flex-col gap-0 min-w-0 overflow-hidden">
              {isErrorMessage ? (
                <div>
                  <ChatErrorMessage message={displayContent} />
                </div>
              ) : (
                <>
                  {isStreamable && stream ? (
                    <div className="min-w-0 max-w-full overflow-hidden">
                      <StreamView
                        stream={stream}
                        isStreaming={isLive && isStreaming}
                        fileDiff={hasDiff ? message.file_diff : undefined}
                        messageUuid={message.uuid}
                      />
                      {(!message.tool_calls || message.tool_calls.length === 0) &&
                        message.content_blocks &&
                        message.content_blocks.length > 0 && (
                          <div className="mt-3">
                            <ContentRenderer content={message.content_blocks} />
                          </div>
                        )}
                    </div>
                  ) : (
                    <div className="min-w-0 max-w-full overflow-hidden">
                      <MarkdownRenderer markdown={displayContent} />
                      {message.content_blocks && message.content_blocks.length > 0 && (
                        <div className="mt-3">
                          <ContentRenderer content={message.content_blocks} />
                        </div>
                      )}
                      {hasDiff && message.file_diff && (
                        <DiffView diff={message.file_diff} messageUuid={message.uuid} />
                      )}
                    </div>
                  )}
                  {message.error && (
                    <div className="mt-2">
                      <ChatErrorMessage message={message.error} />
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {!isUser && !isErrorMessage ? (
        !(isLive && isStreaming) && (
          <div
            className={cn(
              "flex items-center gap-2 px-2 mt-0.5 self-start text-xs text-muted-foreground/80 transition-opacity duration-150 focus-within:opacity-100 focus-within:pointer-events-auto",
              hovered || copied ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
            )}
          >
            <button
              type="button"
              onClick={handleCopy}
              className="p-0.5 rounded text-muted-foreground/80 hover:text-foreground transition-colors"
              title={t("message.copyMessage")}
              aria-label={t("message.copyMessage")}
            >
              {copied ? (
                <LuCheck className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <LuCopy className="h-3.5 w-3.5" />
              )}
            </button>
            {modelLabel && (
              <button
                type="button"
                onClick={() => handleModelSelect(message.model, message.tag, "text")}
                className="hover:text-foreground transition-colors truncate max-w-[280px]"
              >
                {modelLabel}
              </button>
            )}
            {modelLabel && durationLabel && <span aria-hidden="true">·</span>}
            {durationLabel && <span className="tabular-nums">{durationLabel}</span>}
          </div>
        )
      ) : (
        /* Hover action toolbar */
        <div
          className={cn(
            "flex items-center gap-1 h-6 overflow-hidden transition-opacity duration-150",
            isUser ? "self-end" : "self-start",
            (hovered || isUndoing) ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
          )}
        >
          {!isStreaming && (
            <button
              type="button"
              onClick={handleCopy}
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              title={t("message.copyMessage")}
            >
              <FaCopy className="h-3 w-3" />
            </button>
          )}
          {isUser && !isStreaming && message.uuid && !message.uuid.startsWith("temp-") && (
            <button
              type="button"
              onClick={handleUndo}
              disabled={isUndoing}
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-50"
              title={t("message.undoMessage")}
            >
              {isUndoing ? (
                <LuLoader2 className="h-3 w-3 animate-spin" />
              ) : (
                <LuUndo2 className="h-3 w-3" />
              )}
            </button>
          )}
          {message.model && (
            <button
              type="button"
              onClick={() => handleModelSelect(message.model, message.tag, "text")}
              className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-muted/60 text-muted-foreground hover:text-foreground transition-colors"
            >
              {modelLabel || formatModelIdentifier(message.model, message.tag)}
            </button>
          )}
        </div>
      )}
    </div>
  );
});

ChatMessage.displayName = "ChatMessage";

export default ChatMessage;
