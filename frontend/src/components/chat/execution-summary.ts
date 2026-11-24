import type { StreamSegment, StreamToolCall } from "./stream-types";

export type ActivityCategory = "Files" | "Commands" | "Changes" | "Searches" | "Agents" | "Other";

function toolCategory(name: string): ActivityCategory {
  const lower = name.toLowerCase();
  if (/shell|exec|terminal|bash|run_command|python/.test(lower)) return "Commands";
  if (/edit|patch|write|replace|rename|delete|remove|upload|mkdir|create_file/.test(lower)) return "Changes";
  if (/file|directory|folder|read|list|glob/.test(lower)) return "Files";
  if (/search|find|grep|query|browse|fetch|web/.test(lower)) return "Searches";
  if (/agent/.test(lower)) return "Agents";
  return "Other";
}

export function summarizeExecution(segments: StreamSegment[]) {
  const byId = new Map<string, StreamToolCall>();
  const thinking = segments.filter(segment => segment.kind === "thinking");
  for (const segment of segments) {
    const tools = segment.tools || (segment.tool ? [segment.tool] : []);
    for (const tool of tools) {
      const previous = byId.get(tool.id);
      byId.set(tool.id, { ...previous, ...tool, result: tool.result ?? previous?.result });
    }
  }
  const tools = Array.from(byId.values());
  const categories = new Map<ActivityCategory, number>();
  for (const tool of tools) {
    const category = toolCategory(tool.name);
    categories.set(category, (categories.get(category) || 0) + 1);
  }
  const activeTool = [...tools].reverse().find(tool => tool.status === "calling" || tool.status === "streaming");
  return {
    tools,
    thinkingCount: thinking.length,
    categories: Array.from(categories, ([label, count]) => ({ label, count })),
    activeTool,
    running: !!activeTool || thinking.some(segment => segment.status === "streaming" || segment.status === "calling"),
    errorCount: tools.filter(tool => tool.status === "error").length + thinking.filter(segment => segment.status === "error").length,
  };
}

export function executionGroupKey(first: StreamSegment) {
  const toolId = first.tool?.id || first.tools?.[0]?.id;
  return toolId ? `group-tool-${toolId}` : `group-${first.key || `seg-${first.segIdx}`}`;
}
