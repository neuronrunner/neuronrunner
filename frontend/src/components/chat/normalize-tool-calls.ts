import { terminalOutputText } from "@/components/chat/terminal-output";
import { hasToolResult, serializeToolResult, toolResultStatus } from "@/components/chat/tool-status";
import type { Message, ThinkingPhase, ToolCallInfo } from "@/stores/chat";

export interface NormalizeToolCallsOptions {
  defaultPendingStatus?: "calling" | "error";
}

function hasNonEmptyArgs(args: string | Record<string, unknown> | undefined): boolean {
  if (!args) return false;
  if (typeof args === "object") return Object.keys(args).length > 0;
  const trimmed = args.trim();
  return trimmed.length > 0 && trimmed !== "{}";
}

export function normalizeToolCall(
  tc: any,
  options: NormalizeToolCallsOptions = {},
  fallbackIndex = 0
): ToolCallInfo {
  const defaultPendingStatus = options.defaultPendingStatus ?? "calling";
  const name = tc?.function?.name || tc?.name || "";
  const id = tc?.id || tc?.toolCallId || `tc_${fallbackIndex}_${name || "tool"}`;
  const rawArgs = tc?.function?.arguments ?? tc?.arguments;
  const argumentsValue =
    rawArgs === undefined || rawArgs === null || rawArgs === "" ? "{}" : rawArgs;
  const result = serializeToolResult(tc?.result);
  const output = terminalOutputText(tc?.output) || undefined;
  const durationMs =
    typeof tc?.durationMs === "number"
      ? tc.durationMs
      : typeof tc?.duration_ms === "number"
        ? tc.duration_ms
        : undefined;
  const status = hasToolResult(tc?.result)
    ? toolResultStatus(tc.result)
    : tc?.status === "error" || tc?.status === "done" || tc?.status === "calling"
      ? tc.status
      : defaultPendingStatus;

  return {
    ...tc,
    id,
    name,
    title: tc?.title || tc?.function_title,
    arguments: argumentsValue,
    result,
    output,
    status,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

export function normalizeToolCalls(
  toolCalls: any[] | undefined | null,
  options: NormalizeToolCallsOptions = {}
): ToolCallInfo[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((tc, index) => normalizeToolCall(tc, options, index));
}

export interface RequestUpdatePayload {
  partial_content?: string | null;
  partial_thinking?: string | null;
  parent_uuid?: string | null;
  phases?: ThinkingPhase[] | null;
  tool_calls?: any[] | null;
}

/**
 * Merge a WebSocket `request_update` payload into the active `currentMessage`
 * without losing nested `function.arguments` or regressing ahead of newer
 * polled/streamed state.
 */
export function mergeRequestUpdateMessage(
  prev: Message | null | undefined,
  requestData: RequestUpdatePayload
): Message {
  const partialContent = requestData.partial_content ?? "";
  const partialThinking = requestData.partial_thinking ?? "";
  const incomingPhases = Array.isArray(requestData.phases) ? requestData.phases : [];
  const incomingToolCalls = normalizeToolCalls(requestData.tool_calls, {
    defaultPendingStatus: "calling",
  });

  const prevToolCalls = prev?.tool_calls ?? [];
  const prevById = new Map(prevToolCalls.map((tc) => [tc.id, tc]));

  let resolvedToolCalls: ToolCallInfo[] | undefined;
  if (incomingToolCalls.length >= prevToolCalls.length && incomingToolCalls.length > 0) {
    resolvedToolCalls = incomingToolCalls.map((tc) => {
      const existing = prevById.get(tc.id);
      if (!existing) return tc;
      return {
        ...tc,
        name: tc.name || existing.name,
        title: tc.title || existing.title,
        arguments: hasNonEmptyArgs(tc.arguments)
          ? tc.arguments
          : hasNonEmptyArgs(existing.arguments)
            ? existing.arguments
            : tc.arguments,
        result: tc.result !== undefined ? tc.result : existing.result,
        output: tc.output !== undefined ? tc.output : existing.output,
        durationMs: tc.durationMs !== undefined ? tc.durationMs : existing.durationMs,
      };
    });
  } else {
    resolvedToolCalls = prevToolCalls.length > 0 ? prevToolCalls : undefined;
  }

  const prevPhases = prev?.phases ?? [];
  const mergedIncomingPhases = incomingPhases.map((phase, idx) => {
    if (phase.durationMs !== undefined) return phase;
    const prevMatch = phase.toolCallId
      ? prevPhases.find((p) => p.toolCallId === phase.toolCallId && p.durationMs !== undefined)
      : prevPhases[idx];
    return prevMatch?.durationMs !== undefined
      ? { ...phase, durationMs: prevMatch.durationMs }
      : phase;
  });
  const resolvedPhases =
    mergedIncomingPhases.length >= prevPhases.length && mergedIncomingPhases.length > 0
      ? mergedIncomingPhases
      : prevPhases.length > 0
        ? prevPhases
        : undefined;

  const prevContent = prev?.content ?? "";
  const prevThinking = prev?.thinking ?? "";

  return {
    ...(prev || {
      role: "assistant",
      parent: requestData.parent_uuid ?? null,
      created_at: new Date().toISOString(),
      type: "text",
    }),
    content: prevContent.length > partialContent.length ? prevContent : partialContent,
    thinking:
      (prevThinking.length > partialThinking.length ? prevThinking : partialThinking) ||
      undefined,
    phases: resolvedPhases,
    tool_calls: resolvedToolCalls,
  };
}
