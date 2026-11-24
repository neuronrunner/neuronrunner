import type { Message, ToolCallInfo } from "@/stores/chat";
import type {
  ChronologicalStream,
  StreamSegment,
  StreamToolCall,
} from "@/components/chat/stream-types";

const groupConsecutiveTools = (segments: StreamSegment[]): StreamSegment[] => {
  const result: StreamSegment[] = [];
  let currentGroup: StreamSegment | null = null;

  const flushGroup = () => {
    if (!currentGroup) return;
    if (currentGroup.tools && currentGroup.tools.length === 1) {
      result.push({
        ...currentGroup,
        key: `tool-${currentGroup.tools[0].id}`,
        kind: currentGroup.tools[0].status === "calling" ? "tool_call" : "tool_result",
        tool: currentGroup.tools[0],
        tools: undefined,
      });
    } else if (currentGroup.tools && currentGroup.tools.length > 1) {
      result.push(currentGroup);
    }
    currentGroup = null;
  };

  for (const seg of segments) {
    if (seg.kind === "tool_call" || seg.kind === "tool_result") {
      if (!seg.tool) continue;
      const toolCall: StreamToolCall = {
        id: seg.tool.id,
        name: seg.tool.name,
        title: seg.tool.title,
        arguments: seg.tool.arguments,
        result: seg.tool.result,
        output: seg.tool.output,
        status: seg.tool.status,
        durationMs: seg.tool.durationMs,
        primaryArg: seg.tool.primaryArg,
        resultSummary: seg.tool.resultSummary,
      };

      if (currentGroup) {
        // Check if this tool call is already in the group (e.g. updating tool_call to tool_result)
        const existingIdx = currentGroup.tools!.findIndex(t => t.id === toolCall.id);
        if (existingIdx >= 0) {
          const prevTool = currentGroup.tools![existingIdx];
          currentGroup.tools![existingIdx] = {
            ...prevTool,
            ...toolCall,
            result: toolCall.result ?? prevTool.result,
            output: toolCall.output ?? prevTool.output,
            durationMs: toolCall.durationMs ?? prevTool.durationMs,
          };
        } else {
          currentGroup.tools!.push(toolCall);
        }
        
        currentGroup.status = currentGroup.tools!.some(t => t.status === "calling")
          ? "calling"
          : currentGroup.tools!.some(t => t.status === "error") ? "error" : "done";
      } else {
        currentGroup = {
          segIdx: seg.segIdx,
          key: `tool-group-${seg.tool.id}`,
          kind: "tool_group",
          status: toolCall.status,
          content: "",
          tools: [toolCall],
          modelTag: seg.modelTag,
          startedAt: seg.startedAt,
          endedAt: seg.endedAt,
          round: seg.round,
        };
      }
    } else {
      if (!(seg.content || "").trim() && seg.status !== "streaming") {
        continue;
      }
      flushGroup();
      result.push(seg);
    }
  }

  flushGroup();

  return result;
};

interface RawPhase {
  type: string;
  label?: string;
  title?: string;
  toolName?: string;
  toolCallId?: string;
  round?: number;
  chunk?: string;
  streaming?: boolean;
  durationMs?: number;
}

interface BuildOptions {
  modelTag?: string;
}

const MODEL_LABEL_BY_TAG: Record<string, string> = {
  "MiniMax-M3": "MiniMax-M3",
  nvidia: "Nvidia",
  Nvidia: "Nvidia",
};

const formatToolNameLocal = (name: string): string => {
  if (!name) return "";
  return name
    .replace(/^mcp__/, "")
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
};

const resolveModelTag = (
  model: string | undefined,
  tag: string | undefined
): string | undefined => {
  if (!model && !tag) return undefined;
  if (tag && tag !== model && MODEL_LABEL_BY_TAG[tag]) return tag;
  if (model && MODEL_LABEL_BY_TAG[model]) return model;
  if (tag && tag !== model) return tag;
  if (model) {
    if (model.includes(":")) {
      const parts = model.split(":");
      if (parts.length === 2 && parts[0] === parts[1]) return parts[0];
    }
    return model;
  }
  return undefined;
};

interface SegmentAccumulator {
  segments: StreamSegment[];
  nextIdx: number;
  toolIndexById: Map<string, number>;
  modelTag?: string;
}

const createAcc = (modelTag?: string): SegmentAccumulator => ({
  segments: [],
  nextIdx: 0,
  toolIndexById: new Map(),
  modelTag,
});

const allocIdx = (acc: SegmentAccumulator): number => {
  const idx = acc.nextIdx;
  acc.nextIdx += 1;
  return idx;
};

const ensureThinkingSegment = (
  acc: SegmentAccumulator,
  phase: RawPhase
): StreamSegment => {
  const existing = [...acc.segments].reverse().find(
    (s) => s.kind === "thinking" && (s as any).round != null && (s as any).round === phase.round
  );
  const chunk = phase.chunk ?? "";
  if (existing) {
    existing.content = chunk || existing.content;
    existing.status = phase.streaming ? "streaming" : "done";
    if (phase.durationMs != null) existing.durationMs = phase.durationMs;
    return existing;
  }

  // If the last segment was an empty/whitespace-only message segment before thinking started, remove it
  const lastSeg = acc.segments[acc.segments.length - 1];
  if (lastSeg && lastSeg.kind === "message" && !(lastSeg.content || "").trim()) {
    acc.segments.pop();
  }

  const idx = allocIdx(acc);
  const roundVal = phase.round ?? idx;
  const seg: StreamSegment = {
    segIdx: idx,
    key: `thinking-round-${roundVal}`,
    kind: "thinking",
    status: phase.streaming ? "streaming" : "done",
    content: chunk,
    modelTag: acc.modelTag,
    durationMs: phase.durationMs,
    round: phase.round,
  } as StreamSegment & { round?: number };
  acc.segments.push(seg);
  return seg;
};

const ensureContentSegment = (
  acc: SegmentAccumulator,
  phase: RawPhase
): StreamSegment => {
  const matches = acc.segments
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.kind === "message")
    .filter(({ s }) => phase.round != null ? (s as any).round === phase.round : true);
  const last = matches[matches.length - 1];
  const chunk = phase.chunk ?? "";

  // Only merge with `last` if no tool or thinking segment was added after `last.i`
  const hasExecutionAfterLast =
    last != null &&
    acc.segments
      .slice(last.i + 1)
      .some(
        (s) =>
          s.kind === "tool_call" ||
          s.kind === "tool_result" ||
          s.kind === "tool_group" ||
          s.kind === "thinking"
      );

  // If last was just whitespace before an execution block, remove that artifact
  if (last && hasExecutionAfterLast && !(last.s.content || "").trim()) {
    const removeIdx = acc.segments.indexOf(last.s);
    if (removeIdx !== -1) {
      acc.segments.splice(removeIdx, 1);
    }
  }

  if (last && !hasExecutionAfterLast) {
    last.s.content = chunk;
    last.s.status = phase.streaming ? "streaming" : "done";
    return last.s;
  }
  const idx = allocIdx(acc);
  const roundVal = phase.round ?? idx;
  const seg: StreamSegment = {
    segIdx: idx,
    key: `message-round-${roundVal}`,
    kind: "message",
    status: phase.streaming ? "streaming" : "done",
    content: chunk,
    modelTag: acc.modelTag,
    round: phase.round,
  } as StreamSegment & { round?: number };
  acc.segments.push(seg);
  return seg;
};

const toolCallName = (tc: ToolCallInfo | undefined): string =>
  tc?.name || (tc as any)?.function?.name || "";

const hasNonEmptyToolArgs = (args: unknown): boolean => {
  if (!args) return false;
  if (typeof args === "string") return args.trim().length > 0 && args.trim() !== "{}";
  if (typeof args === "object") return Object.keys(args as Record<string, unknown>).length > 0;
  return false;
};

const toolCallArguments = (tc: ToolCallInfo | undefined): string | Record<string, unknown> | undefined => {
  const direct = tc?.arguments;
  const nested = (tc as any)?.function?.arguments;
  if (hasNonEmptyToolArgs(direct)) return direct;
  if (hasNonEmptyToolArgs(nested)) return nested;
  return direct ?? nested;
};

const ensureToolSegment = (
  acc: SegmentAccumulator,
  phase: RawPhase,
  toolCalls: ToolCallInfo[]
): StreamSegment | null => {
  const tc = phase.toolCallId
    ? toolCalls.find((t) => t.id === phase.toolCallId)
    : toolCalls.find((t) => toolCallName(t) === phase.toolName);
  const toolId = phase.toolCallId ?? tc?.id ?? phase.toolName ?? "tool";
  const isExecuted =
    phase.type === "tool_result" ||
    tc?.status === "done" ||
    tc?.status === "error" ||
    tc?.result !== undefined;

  const status = tc?.status === "error" ? "error" : isExecuted ? "done" : "calling";

  const resolvedTitle = tc?.title || (phase.title as string | undefined);
  const tcName = toolCallName(tc);
  const tcArgs = toolCallArguments(tc);
  const tcDurationMs = tc?.durationMs ?? (tc as any)?.duration_ms;

  if (acc.toolIndexById.has(toolId)) {
    const idx = acc.toolIndexById.get(toolId)!;
    const existing = acc.segments.find((s) => s.segIdx === idx);
    if (!existing || !existing.tool) return null;
    existing.kind = isExecuted ? "tool_result" : "tool_call";
    existing.status = status;
    existing.content = phase.label ?? existing.content;
    const nextArgs =
      tcArgs && tcArgs !== "{}"
        ? tcArgs
        : existing.tool.arguments && existing.tool.arguments !== "{}"
          ? existing.tool.arguments
          : (tcArgs ?? existing.tool.arguments);
    existing.tool = {
      ...existing.tool,
      title: resolvedTitle ?? existing.tool.title,
      arguments: nextArgs,
      result: tc?.result ?? existing.tool.result,
      output: tc?.output ?? existing.tool.output,
      status,
      durationMs: tcDurationMs ?? existing.tool.durationMs,
    };
    return existing;
  }

  const resolvedName = (
    phase.toolName && phase.toolName.length > 0
      ? phase.toolName
      : tcName.length > 0
      ? tcName
      : ""
  ) ?? "";

  const resolvedLabel = (phase.label && phase.label.length > 0)
    ? phase.label
    : (tcName.length > 0 ? formatToolNameLocal(tcName) : "");

  if (!resolvedName) {
    return null;
  }

  const idx = allocIdx(acc);
  acc.toolIndexById.set(toolId, idx);
  const seg: StreamSegment = {
    segIdx: idx,
    key: `tool-${toolId}`,
    kind: isExecuted ? "tool_result" : "tool_call",
    status,
    content: resolvedLabel || resolvedName,
    modelTag: acc.modelTag,
    tool: {
      id: toolId,
      name: resolvedName,
      title: resolvedTitle,
      arguments: tcArgs ?? "{}",
      status,
      result: tc?.result,
      output: tc?.output,
      durationMs: tcDurationMs,
    },
  };
  acc.segments.push(seg);
  return seg;
};

export const buildStreamFromMessage = (
  message: Message,
  options: BuildOptions = {}
): ChronologicalStream => {
  const modelTag = options.modelTag ?? resolveModelTag(message.model, message.tag);
  const acc = createAcc(modelTag);
  const phases = (message.phases ?? []) as RawPhase[];
  const toolCalls = message.tool_calls ?? [];
  const thinkingSegments = message.thinkingSegments;

  if (phases.length === 0) {
    if (thinkingSegments && thinkingSegments.length > 0) {
      thinkingSegments.forEach((segText, i) => {
        acc.segments.push({
          segIdx: allocIdx(acc),
          key: `thinking-round-${i}`,
          kind: "thinking",
          status: "done",
          content: segText,
          round: i,
          modelTag: acc.modelTag,
        } as StreamSegment & { round?: number });
      });
    } else if (message.thinking && message.thinking.trim()) {
      acc.segments.push({
        segIdx: allocIdx(acc),
        key: "thinking-round-0",
        kind: "thinking",
        status: "done",
        content: message.thinking.trim(),
        modelTag: acc.modelTag,
      });
    }
    for (const tc of toolCalls) {
      const tcName = toolCallName(tc).trim();
      if (tcName) {
        ensureToolSegment(
          acc,
          {
            type: tc.status === "calling" && tc.result === undefined ? "tool_call" : "tool_result",
            toolCallId: tc.id,
            toolName: tcName,
            label: tcName,
          },
          toolCalls
        );
      }
    }
    if (message.content?.trim()) {
      acc.segments.push({
        segIdx: allocIdx(acc),
        key: "message-round-0",
        kind: "message",
        status: "done",
        content: message.content.trim(),
        modelTag: acc.modelTag,
        round: 0,
      } as StreamSegment & { round?: number });
    }
    finalize(acc);
    const groupedSegs = groupConsecutiveTools(acc.segments);
    return { preToolPreserved: false, segments: groupedSegs, segCount: groupedSegs.length };
  }

  // Filter out leading whitespace-only content phases that precede thinking in the same round
  const normalizedPhases = phases.filter((p, idx) => {
    if (p.type === "content" && !(p.chunk || "").trim()) {
      const hasUpcomingThinking = phases.slice(idx + 1).some(
        (later) => later.type === "thinking" && (p.round == null || later.round == null || later.round === p.round)
      );
      if (hasUpcomingThinking) return false;
    }
    return true;
  });

  let thinkingSegCounter = 0;
  for (const phase of normalizedPhases) {
    if (phase.type === "thinking") {
      let content = phase.chunk ?? "";
      if (!content) {
        if (thinkingSegments && thinkingSegments[thinkingSegCounter] != null) {
          content = thinkingSegments[thinkingSegCounter];
        } else if (thinkingSegCounter === 0 && message.thinking) {
          content = message.thinking;
        }
      }
      thinkingSegCounter++;
      ensureThinkingSegment(acc, { ...phase, chunk: content });
      continue;
    }
    if (phase.type === "content") {
      ensureContentSegment(acc, phase);
      continue;
    }
    if (phase.type === "tool_call" || phase.type === "tool_result") {
      ensureToolSegment(acc, phase, toolCalls);
      continue;
    }
  }

  if (
    message.content?.trim() &&
    !acc.segments.some((s) => s.kind === "message")
  ) {
    acc.segments.push({
      segIdx: allocIdx(acc),
      key: "message-round-0",
      kind: "message",
      status: "done",
      content: message.content.trim(),
      modelTag: acc.modelTag,
      round: 0,
    } as StreamSegment & { round?: number });
  }

  // Invariant: within the same round (or when adjacent), thinking must always precede message
  for (let i = 0; i < acc.segments.length - 1; i++) {
    const cur = acc.segments[i];
    const next = acc.segments[i + 1];
    if (
      cur.kind === "message" &&
      next.kind === "thinking" &&
      (cur.round === next.round || cur.round == null || next.round == null)
    ) {
      acc.segments[i] = next;
      acc.segments[i + 1] = cur;
    }
  }

  const isActivelyStreaming = phases.some((p) => p.streaming);
  if (!isActivelyStreaming) {
    finalize(acc);
  }

  const groupedSegsLive = groupConsecutiveTools(acc.segments);
  return { preToolPreserved: false, segments: groupedSegsLive, segCount: groupedSegsLive.length };
};

const finalize = (acc: SegmentAccumulator): void => {
  for (const seg of acc.segments) {
    if (seg.kind === "message" && seg.status === "streaming") seg.status = "done";
    if (seg.kind === "thinking" && seg.status === "streaming") seg.status = "done";
  }
};

export const buildLiveStream = (
  currentMessage: Message | null | undefined,
  options: BuildOptions = {}
): ChronologicalStream => {
  if (!currentMessage) return { preToolPreserved: false, segments: [], segCount: 0 };
  return buildStreamFromMessage(currentMessage, options);
};

export type { RawPhase };
