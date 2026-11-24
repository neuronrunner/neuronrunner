"use client";

import { memo } from "react";
import MarkdownRenderer from "@/components/markdown-renderer";
import ExecutionBlock from "@/components/chat/execution-block";
import DiffView from "@/components/chat/diff-view";
import { executionGroupKey } from "./execution-summary";
import type {
  ChronologicalStream,
  StreamSegment,
} from "@/components/chat/stream-types";
import type { FileDiffData } from "@/stores/chat";

interface StreamViewProps {
  stream: ChronologicalStream;
  fallbackMessage?: string;
  isStreaming?: boolean;
  fileDiff?: FileDiffData;
  messageUuid?: string;
}

const StreamView = memo(function StreamView({
  stream,
  fallbackMessage,
  isStreaming = false,
  fileDiff,
  messageUuid,
}: StreamViewProps) {
  if (stream.segments.length === 0) {
    if (fileDiff) return <DiffView diff={fileDiff} messageUuid={messageUuid} />;
    if (fallbackMessage) {
      return (
        <div className="pl-1 py-0.5">
          <p className="text-muted-foreground text-sm font-mono opacity-70">
            {fallbackMessage}
          </p>
        </div>
      );
    }
    return null;
  }

  const visibleSegments = stream.segments.filter((s) => {
    if (s.kind === "done") return false;
    if (s.kind === "message" || s.kind === "preamble") {
      return s.content.trim().length > 0 || s.status === "streaming";
    }
    if (s.kind === "thinking") {
      return (s.content || "").trim().length > 0 || s.status === "streaming";
    }
    if (s.kind === "tool_call" || s.kind === "tool_result") {
      if (!s.tool) return false;
      const toolName = (s.tool.name || "").trim();
      if (toolName.length === 0) return false;
      return true;
    }
    if (s.kind === "tool_group") {
      if (!s.tools || s.tools.length === 0) return false;
      return s.tools.some(t => !!t.name.trim());
    }
    return true;
  });

  if (visibleSegments.length === 0) {
    return fileDiff ? <DiffView diff={fileDiff} messageUuid={messageUuid} /> : null;
  }

  // Group contiguous execution segments (thinking, tool_call, tool_result, tool_group)
  const groupedItems: Array<
    | { kind: "execution_group"; segments: StreamSegment[]; status: "streaming" | "done" | "error" | "calling"; key: string }
    | { kind: "message" | "preamble"; segment: StreamSegment; key: string }
  > = [];

  let tempGroup: StreamSegment[] = [];

  const flushGroup = () => {
    if (tempGroup.length > 0) {
      let groupStatus: "streaming" | "done" | "error" | "calling" = "done";
      if (tempGroup.some(s => s.status === "streaming")) {
        groupStatus = "streaming";
      } else if (tempGroup.some(s => s.status === "calling")) {
        groupStatus = "calling";
      } else if (tempGroup.some(s => s.status === "error" || (s.kind === "tool_group" && s.tools?.some(t => t.status === "error")))) {
        groupStatus = "error";
      }

      const firstSeg = tempGroup[0];
      const stableKey = executionGroupKey(firstSeg);
      groupedItems.push({
        kind: "execution_group",
        segments: [...tempGroup],
        status: groupStatus,
        key: stableKey,
      });
      tempGroup = [];
    }
  };

  for (const segment of visibleSegments) {
    if (
      segment.kind === "thinking" ||
      segment.kind === "tool_call" ||
      segment.kind === "tool_result" ||
      segment.kind === "tool_group"
    ) {
      tempGroup.push(segment);
    } else {
      flushGroup();
      groupedItems.push({
        kind: segment.kind as "message" | "preamble",
        segment,
        key: segment.key || `seg-${segment.segIdx}-${segment.kind}`,
      });
    }
  }
  flushGroup();

  // Keep the latest activity running through gaps between tool calls and text chunks.
  const latestExecutionKey = groupedItems.findLast(item => item.kind === "execution_group")?.key;
  const lastExecutionIndex = groupedItems.findLastIndex(item => item.kind === "execution_group");

  return (
    <div className="w-full min-w-0 overflow-hidden">
      {groupedItems.map((item, index) => {
        if (item.kind === "execution_group") {
          return (
            <ExecutionBlock
              key={item.key}
              segments={item.segments}
              status={item.status}
              isRunning={isStreaming && item.key === latestExecutionKey}
              fileDiff={index === lastExecutionIndex ? fileDiff : undefined}
              messageUuid={messageUuid}
            />
          );
        }

        const segment = item.segment;
        if (!segment.content.trim() && segment.status !== "streaming") return null;

        return (
          <div
            key={item.key}
            className="pl-1 py-0.5 text-foreground text-sm leading-relaxed"
            data-seg-idx={segment.segIdx}
          >
            <MarkdownRenderer markdown={segment.content} />
          </div>
        );
      })}
      {fileDiff && lastExecutionIndex === -1 && <DiffView diff={fileDiff} messageUuid={messageUuid} />}
    </div>
  );
});

export default StreamView;
