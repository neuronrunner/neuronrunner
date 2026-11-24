export type ReasoningTier =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "on";

export type ReasoningMode = "none" | "effort" | "toggle" | "fixed";

export const CANONICAL_EFFORT_ORDER: readonly ReasoningTier[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const ACTIVE_EFFORT_TIERS: readonly ReasoningTier[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const ALL_CANONICAL_TIERS: readonly ReasoningTier[] = [
  ...CANONICAL_EFFORT_ORDER,
  "on",
];

export const LEGACY_DEFAULT_TIERS: ReasoningTier[] = ["low", "medium", "high"];

const EFFORT_RANK: Record<string, number> = {
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

const TIER_INDEX: Record<string, number> = ALL_CANONICAL_TIERS.reduce(
  (acc, tier, idx) => {
    acc[tier] = idx;
    return acc;
  },
  {} as Record<string, number>
);

const TIER_ALIASES: Record<string, ReasoningTier> = {
  off: "none",
  disabled: "none",
  enabled: "on",
};

export interface ReasoningCapableModel {
  name?: string;
  is_reasoning?: boolean;
  isReasoning?: boolean;
  reasoning_mode?: ReasoningMode | string;
  reasoningMode?: ReasoningMode | string;
  reasoning_tiers?: readonly (ReasoningTier | string)[];
  reasoningTiers?: readonly (ReasoningTier | string)[];
  default_reasoning_effort?: ReasoningTier | string;
  defaultReasoningEffort?: ReasoningTier | string;
  llm_config?: {
    reasoning_mode?: ReasoningMode | string;
    supported_reasoning_efforts?: readonly (ReasoningTier | string)[];
    default_reasoning_effort?: ReasoningTier | string;
  } | null;
}

export interface ModelReasoningSpec {
  isReasoning: boolean;
  mode: ReasoningMode;
  tiers: ReasoningTier[];
  defaultTier: ReasoningTier;
  hasExplicitTiers: boolean;
}

export function normalizeReasoningTier(value: unknown): ReasoningTier | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().toLowerCase();
  if (!cleaned) return null;
  const mapped = TIER_ALIASES[cleaned] ?? cleaned;
  return mapped in TIER_INDEX ? (mapped as ReasoningTier) : null;
}

export function isReasoningTier(value: unknown): value is ReasoningTier {
  return normalizeReasoningTier(value) !== null;
}

export function sortReasoningTiers(values: unknown): ReasoningTier[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<ReasoningTier>();
  for (const item of values) {
    const norm = normalizeReasoningTier(item);
    if (norm) seen.add(norm);
  }
  return Array.from(seen).sort((a, b) => TIER_INDEX[a] - TIER_INDEX[b]);
}

function pickDefaultTier(tiers: ReasoningTier[], preferred?: ReasoningTier | null): ReasoningTier {
  if (preferred && tiers.includes(preferred)) return preferred;
  const order: ReasoningTier[] = ["medium", "high", "low", "max", "xhigh", "minimal", "on"];
  for (const candidate of order) {
    if (tiers.includes(candidate)) return candidate;
  }
  return tiers[0] ?? "none";
}

export function extractModelKey(modelIdentifier?: string | null): string {
  if (!modelIdentifier) return "";
  const trimmed = modelIdentifier.trim();
  const colonIdx = trimmed.indexOf(":");
  const base = colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed;
  return base === "deepseek-v4.1-flash" ? "deepseek-v4.1-flash-1017" : base;
}

export function getModelReasoningSpec(
  model?: ReasoningCapableModel | null,
  fallbackCatalog?: readonly ReasoningCapableModel[]
): ModelReasoningSpec {
  const modelKey = extractModelKey(model?.name);
  const catalogMatch =
    modelKey && Array.isArray(fallbackCatalog)
      ? fallbackCatalog.find((entry) => extractModelKey(entry.name) === modelKey)
      : undefined;

  const isReasoningRaw =
    model?.is_reasoning ?? model?.isReasoning ?? catalogMatch?.is_reasoning ?? catalogMatch?.isReasoning;
  const isReasoning = Boolean(isReasoningRaw);

  if (!isReasoning) {
    return {
      isReasoning: false,
      mode: "none",
      tiers: [],
      defaultTier: "none",
      hasExplicitTiers: false,
    };
  }

  const rawModeRaw =
    model?.reasoning_mode ??
    model?.reasoningMode ??
    model?.llm_config?.reasoning_mode ??
    catalogMatch?.reasoning_mode ??
    catalogMatch?.reasoningMode;
  const rawMode = typeof rawModeRaw === "string" ? rawModeRaw.trim().toLowerCase() : "";

  const directTiers = sortReasoningTiers(
    model?.reasoning_tiers ??
      model?.reasoningTiers ??
      model?.llm_config?.supported_reasoning_efforts
  );
  const catalogTiers = sortReasoningTiers(
    catalogMatch?.reasoning_tiers ??
      catalogMatch?.reasoningTiers ??
      catalogMatch?.llm_config?.supported_reasoning_efforts
  );
  const tiers = directTiers.length > 0 ? directTiers : catalogTiers;

  const rawDefault = normalizeReasoningTier(
    model?.default_reasoning_effort ??
      model?.defaultReasoningEffort ??
      model?.llm_config?.default_reasoning_effort ??
      catalogMatch?.default_reasoning_effort ??
      catalogMatch?.defaultReasoningEffort
  );

  if (rawMode === "fixed" || (tiers.length === 1 && tiers[0] === "on" && rawMode !== "toggle")) {
    return {
      isReasoning: true,
      mode: "fixed",
      tiers: ["on"],
      defaultTier: "on",
      hasExplicitTiers: true,
    };
  }

  if (
    rawMode === "toggle" ||
    (tiers.length > 0 && tiers.every((t) => t === "none" || t === "on"))
  ) {
    const toggleTiers: ReasoningTier[] = ["none", "on"];
    return {
      isReasoning: true,
      mode: "toggle",
      tiers: toggleTiers,
      defaultTier: rawDefault === "none" || rawDefault === "on" ? rawDefault : "on",
      hasExplicitTiers: true,
    };
  }

  const effortTiers = tiers.filter((t) => t !== "on");
  if (effortTiers.length > 0) {
    const cleanTiers =
      effortTiers.length === 1 && effortTiers[0] === "none" ? [...LEGACY_DEFAULT_TIERS] : effortTiers;
    return {
      isReasoning: true,
      mode: "effort",
      tiers: cleanTiers,
      defaultTier: pickDefaultTier(cleanTiers, rawDefault),
      hasExplicitTiers: true,
    };
  }

  const fallbackTiers = [...LEGACY_DEFAULT_TIERS];
  if (rawDefault && rawDefault in EFFORT_RANK && !fallbackTiers.includes(rawDefault)) {
    fallbackTiers.push(rawDefault);
  }
  const sortedFallback = sortReasoningTiers(fallbackTiers);
  return {
    isReasoning: true,
    mode: "effort",
    tiers: sortedFallback,
    defaultTier: pickDefaultTier(sortedFallback, rawDefault),
    hasExplicitTiers: false,
  };
}

export function resolveModelReasoningTier(
  spec: ModelReasoningSpec,
  preferred?: unknown
): ReasoningTier {
  if (!spec.isReasoning || spec.mode === "none" || spec.tiers.length === 0) {
    return "none";
  }

  const norm = normalizeReasoningTier(preferred);
  if (!norm) {
    return spec.defaultTier;
  }
  if (spec.tiers.includes(norm)) {
    return norm;
  }
  if (spec.mode === "fixed") {
    return "on";
  }
  if (spec.mode === "toggle") {
    return norm === "none" ? "none" : "on";
  }

  const nonNone = spec.tiers.filter((t) => t !== "none");
  if (nonNone.length === 0) {
    return spec.defaultTier;
  }
  if (norm === "none") {
    return nonNone[0];
  }
  if (norm === "on") {
    return spec.defaultTier !== "none" ? spec.defaultTier : nonNone[0];
  }

  const targetRank = EFFORT_RANK[norm];
  if (targetRank === undefined) {
    return spec.defaultTier;
  }

  let best = nonNone[0];
  let bestKey: [number, number, number] = [Infinity, 1, 0];
  for (const candidate of nonNone) {
    const rank = EFFORT_RANK[candidate] ?? targetRank;
    const key: [number, number, number] = [
      Math.abs(rank - targetRank),
      candidate === spec.defaultTier ? 0 : 1,
      -rank,
    ];
    if (
      key[0] < bestKey[0] ||
      (key[0] === bestKey[0] && key[1] < bestKey[1]) ||
      (key[0] === bestKey[0] && key[1] === bestKey[1] && key[2] < bestKey[2])
    ) {
      best = candidate;
      bestKey = key;
    }
  }
  return best;
}

export type EditableReasoningMode = "effort" | "toggle" | "fixed";

export interface EditableReasoningState {
  isReasoning: boolean;
  mode: EditableReasoningMode;
  tiers: ReasoningTier[];
  defaultTier: ReasoningTier;
}

export function deriveEditableReasoningState(
  model?: ReasoningCapableModel | null
): EditableReasoningState {
  const spec = getModelReasoningSpec(model);
  if (!spec.isReasoning) {
    return {
      isReasoning: false,
      mode: "effort",
      tiers: [...LEGACY_DEFAULT_TIERS],
      defaultTier: "medium",
    };
  }
  const mode: EditableReasoningMode =
    spec.mode === "fixed" || spec.mode === "toggle" ? spec.mode : "effort";
  return {
    isReasoning: true,
    mode,
    tiers: spec.tiers.length > 0 ? spec.tiers : [...LEGACY_DEFAULT_TIERS],
    defaultTier: spec.defaultTier,
  };
}

export function normalizeEditableModeChange(
  nextMode: EditableReasoningMode,
  prevTiers: ReasoningTier[],
  prevDefault: ReasoningTier
): { mode: EditableReasoningMode; tiers: ReasoningTier[]; defaultTier: ReasoningTier } {
  if (nextMode === "fixed") {
    return { mode: "fixed", tiers: ["on"], defaultTier: "on" };
  }
  if (nextMode === "toggle") {
    return {
      mode: "toggle",
      tiers: ["none", "on"],
      defaultTier: prevDefault === "none" ? "none" : "on",
    };
  }
  const existingEffort = sortReasoningTiers(prevTiers).filter((t) => t !== "on");
  const tiers =
    existingEffort.some((t) => t !== "none") ? existingEffort : [...LEGACY_DEFAULT_TIERS];
  const defaultTier = tiers.includes(prevDefault)
    ? prevDefault
    : pickDefaultTier(tiers, prevDefault);
  return { mode: "effort", tiers, defaultTier };
}

export function toggleEffortTierSelection(
  currentTiers: ReasoningTier[],
  tier: ReasoningTier,
  currentDefault: ReasoningTier
): { tiers: ReasoningTier[]; defaultTier: ReasoningTier } {
  const sorted: ReasoningTier[] = sortReasoningTiers(currentTiers).filter((t) => t !== "on");
  const hasTier = sorted.includes(tier);
  let nextTiers: ReasoningTier[];

  if (hasTier) {
    nextTiers = sorted.filter((t) => t !== tier);
    const hasActiveEffort = nextTiers.some((t) => t !== "none");
    if (!hasActiveEffort) {
      return {
        tiers: sorted.length > 0 ? sorted : [...LEGACY_DEFAULT_TIERS],
        defaultTier: sorted.includes(currentDefault)
          ? currentDefault
          : pickDefaultTier(sorted, currentDefault),
      };
    }
  } else {
    nextTiers = sortReasoningTiers([...sorted, tier]);
  }

  const nextDefault = nextTiers.includes(currentDefault)
    ? currentDefault
    : pickDefaultTier(nextTiers, currentDefault);
  return { tiers: nextTiers, defaultTier: nextDefault };
}

export function buildReasoningConfigPayload(
  isReasoning: boolean,
  mode: EditableReasoningMode,
  tiers: ReasoningTier[],
  defaultTier: ReasoningTier
): {
  is_reasoning: boolean;
  reasoning_mode: ReasoningMode;
  supported_reasoning_efforts: ReasoningTier[];
  default_reasoning_effort: ReasoningTier;
} {
  if (!isReasoning) {
    return {
      is_reasoning: false,
      reasoning_mode: "none",
      supported_reasoning_efforts: [],
      default_reasoning_effort: "none",
    };
  }
  const normalized = normalizeEditableModeChange(mode, tiers, defaultTier);
  return {
    is_reasoning: true,
    reasoning_mode: normalized.mode,
    supported_reasoning_efforts: normalized.tiers,
    default_reasoning_effort: normalized.defaultTier,
  };
}
