export type StreamSegmentKind =
  | "preamble"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "tool_group"
  | "message"
  | "done";

export type StreamSegmentStatus = "streaming" | "done" | "error" | "calling";

export interface StreamToolCall {
  id: string;
  name: string;
  title?: string;
  arguments: string | Record<string, unknown>;
  result?: string;
  output?: string;
  status: StreamSegmentStatus;
  durationMs?: number;
  primaryArg?: string;
  resultSummary?: string;
}

export interface StreamSegment {
  segIdx: number;
  key?: string;
  kind: StreamSegmentKind;
  status: StreamSegmentStatus;
  content: string;
  tool?: StreamToolCall;
  tools?: StreamToolCall[];
  modelTag?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  lastChunk?: string;
  round?: number;
}

export interface ChronologicalStream {
  preToolPreserved: boolean;
  segments: StreamSegment[];
  segCount?: number;
}

export const createEmptyStream = (): ChronologicalStream => ({
  preToolPreserved: false,
  segments: [],
});

export const ensureSegment = (
  stream: ChronologicalStream,
  partial: Omit<StreamSegment, "segIdx" | "content"> & {
    segIdx?: number;
    content?: string;
  }
): { stream: ChronologicalStream; segment: StreamSegment } => {
  if (partial.segIdx != null) {
    const idx = stream.segments.findIndex((s) => s.segIdx === partial.segIdx);
    if (idx >= 0) {
      const existing = stream.segments[idx];
      const merged: StreamSegment = {
        ...existing,
        ...partial,
        segIdx: existing.segIdx,
        content: partial.content ?? existing.content,
      };
      const segments = [...stream.segments];
      segments[idx] = merged;
      return { stream: { ...stream, segments }, segment: merged };
    }
  }
  const segIdx = partial.segIdx ?? nextSegIdx(stream);
  const segment: StreamSegment = {
    segIdx,
    kind: partial.kind,
    status: partial.status,
    content: partial.content ?? "",
    tool: partial.tool,
    modelTag: partial.modelTag,
    startedAt: partial.startedAt,
    endedAt: partial.endedAt,
  };
  return {
    stream: { ...stream, segments: [...stream.segments, segment] },
    segment,
  };
};

export const nextSegIdx = (stream: ChronologicalStream): number => {
  if (stream.segments.length === 0) return 0;
  return Math.max(...stream.segments.map((s) => s.segIdx)) + 1;
};

export const preservePreToolContent = (stream: ChronologicalStream): ChronologicalStream => {
  if (stream.preToolPreserved) return stream;
  let firstToolIdx = -1;
  for (let i = 0; i < stream.segments.length; i++) {
    if (stream.segments[i].kind === "tool_call") {
      firstToolIdx = i;
      break;
    }
  }
  if (firstToolIdx <= 0) return stream;
  const segments = stream.segments.map((s) => ({ ...s }));
  segments[firstToolIdx - 1] = { ...segments[firstToolIdx - 1], status: "done" };
  return { ...stream, segments, preToolPreserved: true };
};
