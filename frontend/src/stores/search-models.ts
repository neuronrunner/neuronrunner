import { env } from "@/lib/env";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { Model } from "@/types/model";
import { authedAxios } from "@/lib/axios";
import { DEFAULT_PLATFORM_MODELS } from "@/lib/default-models";

export type ModelTypeFilter = "all" | "text" | "image";
export type SortOption = "popular" | "newest" | "reasoning" | "coding" | "agentic" | "math";

interface StoreState {
  models: Model[];
  searchQuery: string;
  isLoading: boolean;
  error: string | null;
  nextUrl: string | null;
  typeFilter: ModelTypeFilter;
  sortBy: SortOption;
  typeCounts: { all: number; text: number; image: number };
  setModels: (models: Model[]) => void;
  setSearchQuery: (query: string) => void;
  setTypeFilter: (filter: ModelTypeFilter) => void;
  setSortBy: (sort: SortOption) => void;
  setNextUrl: (url: string | null) => void;
  setIsLoading: (loading: boolean) => void;
  setTypeCounts: (counts: { all: number; text: number; image: number }) => void;
  reset: () => void;
  fetchFirstPage: () => Promise<void>;
  fetchNext: () => Promise<void>;
  fetchTypeCounts: () => Promise<void>;
}

const FIELDS = "uuid,name,display_name,author,description,thumbnail,thumbnail_blur_data_url,runs,model_type,benchmark_scores,llm_stats_id,is_free_tier,is_byok,is_byos,is_reasoning,reasoning_mode,reasoning_tiers,default_reasoning_effort,supports_vision,provider_name,context_length";
const PAGE_SIZE = 50;

export function sanitizeModelList(rawModels: Model[]): Model[] {
  if (!Array.isArray(rawModels) || rawModels.length === 0) return DEFAULT_PLATFORM_MODELS;
  const seenNames = new Set<string>();
  const seenDisplayNames = new Set<string>();
  const sanitized: Model[] = [];

  for (const m of rawModels) {
    if (!m) continue;
    // Map legacy alias 'deepseek-v4.1-flash' to 'deepseek-v4.1-flash-1017'
    const name = m.name === "deepseek-v4.1-flash" ? "deepseek-v4.1-flash-1017" : m.name;
    let displayName = m.display_name || name;
    displayName = displayName.replace(/\s*\(1017\)/g, "").trim();
    if (name === "deepseek-v4.1-flash-1017") {
      displayName = "DeepSeek V4.1 Flash";
    }

    const key = name.toLowerCase();
    const isSub = ["anthropic_sub", "openai_sub", "antigravity_sub"].includes(m.provider_name || "");
    // Scope by provider so a BYOS model (e.g. Claude Code Haiku) isn't dropped by a same-named platform model.
    const displayKey = `${isSub ? m.provider_name : "neuron"}::${displayName.toLowerCase()}`;
    if (seenNames.has(key) || seenDisplayNames.has(displayKey)) {
      continue;
    }
    seenNames.add(key);
    seenDisplayNames.add(displayKey);

    const fallback = DEFAULT_PLATFORM_MODELS.find((d) => d.name === name);
    const hasExplicitIsReasoning = typeof m.is_reasoning === "boolean";
    const resolvedIsReasoning = hasExplicitIsReasoning ? m.is_reasoning : fallback?.is_reasoning;

    sanitized.push({
      ...fallback,
      ...m,
      name,
      display_name: displayName,
      is_free_tier:
        typeof m.is_free_tier === "boolean" ? m.is_free_tier : fallback?.is_free_tier,
      is_byos: Boolean(
        m.is_byos ||
          m.provider_name === "anthropic_sub" ||
          m.provider_name === "openai_sub" ||
          m.provider_name === "antigravity_sub"
      ),
      is_reasoning: resolvedIsReasoning,
      reasoning_mode:
        m.reasoning_mode ?? (resolvedIsReasoning ? fallback?.reasoning_mode : "none"),
      reasoning_tiers:
        Array.isArray(m.reasoning_tiers) && m.reasoning_tiers.length > 0
          ? m.reasoning_tiers
          : resolvedIsReasoning
            ? fallback?.reasoning_tiers
            : [],
      default_reasoning_effort:
        m.default_reasoning_effort ??
        (resolvedIsReasoning ? fallback?.default_reasoning_effort : "none"),
      supports_vision: m.supports_vision ?? fallback?.supports_vision,
    });
  }

  sanitized.sort((a, b) => Number(Boolean(b.is_free_tier)) - Number(Boolean(a.is_free_tier)));
  return sanitized.length > 0 ? sanitized : DEFAULT_PLATFORM_MODELS;
}

const useModelStore = create<StoreState>()(
  persist(
    (set, get) => ({
      models: DEFAULT_PLATFORM_MODELS,
      searchQuery: "",
      isLoading: false,
      error: null,
      nextUrl: null,
      typeFilter: "all",
      sortBy: "popular",
      typeCounts: { all: DEFAULT_PLATFORM_MODELS.length, text: DEFAULT_PLATFORM_MODELS.length, image: 0 },

      setModels: (models) => set({ models: sanitizeModelList(models) }),
      setSearchQuery: (query) => set({ searchQuery: query }),
      setTypeFilter: (filter) => set({ typeFilter: filter }),
      setSortBy: (sort) => set({ sortBy: sort }),
      setNextUrl: (url) => set({ nextUrl: url }),
      setIsLoading: (loading) => set({ isLoading: loading }),
      setTypeCounts: (counts) => set({ typeCounts: counts }),

      reset: () =>
        set({
          models: DEFAULT_PLATFORM_MODELS,
          nextUrl: null,
          error: null,
          isLoading: false,
          typeCounts: { all: DEFAULT_PLATFORM_MODELS.length, text: DEFAULT_PLATFORM_MODELS.length, image: 0 },
        }),

      fetchFirstPage: async () => {
        const { isLoading, searchQuery, typeFilter, sortBy } = get();
        if (isLoading) return;
        let base = `${env.API_URL}/models/?fields=${FIELDS}&page_size=${PAGE_SIZE}`;

        if (typeFilter !== "all") {
          base += `&model_type=${typeFilter}`;
        }

        // Map sort options to API ordering
        const sortMap: Record<string, string> = {
          popular: "-runs",
          newest: "-created_at",
        };
        if (sortMap[sortBy]) {
          base += `&ordering=${sortMap[sortBy]}`;
        }

        const url = searchQuery ? `${base}&search=${encodeURIComponent(searchQuery)}` : base;

        set({ isLoading: true, error: null });
        try {
          const response = await authedAxios.get(url);
          const rawResults = (response.data.results as Model[]) || [];
          const cleanResults = sanitizeModelList(rawResults);
          set({
            models: cleanResults.length > 0 ? cleanResults : get().models,
            nextUrl: response.data.next,
          });
        } catch (e: any) {
          set({ error: e?.message ?? "Failed to fetch models" });
        } finally {
          set({ isLoading: false });
        }
      },

      fetchNext: async () => {
        const { isLoading, nextUrl } = get();
        if (isLoading) return;
        if (!nextUrl) return;
        set({ isLoading: true, error: null });
        try {
          const response = await authedAxios.get(nextUrl);
          const rawResults = (response.data.results as Model[]) || [];
          const merged = sanitizeModelList([...get().models, ...rawResults]);
          set({
            models: merged,
            nextUrl: response.data.next,
          });
        } catch (e: any) {
          set({ error: e?.message ?? "Failed to fetch models" });
        } finally {
          set({ isLoading: false });
        }
      },

      fetchTypeCounts: async () => {
        try {
          const base = `${env.API_URL}/models/?fields=uuid&page_size=1`;
          const [allRes, textRes, imageRes] = await Promise.all([
            authedAxios.get(base),
            authedAxios.get(`${base}&model_type=text`),
            authedAxios.get(`${base}&model_type=image`),
          ]);
          set({
            typeCounts: {
              all: allRes.data.count ?? DEFAULT_PLATFORM_MODELS.length,
              text: textRes.data.count ?? DEFAULT_PLATFORM_MODELS.length,
              image: imageRes.data.count ?? 0,
            },
          });
        } catch {
          // silently fail, counts stay at initial
        }
      },
    }),
    {
      name: "nr_models_catalog_v2",
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
        models: state.models,
        typeCounts: state.typeCounts,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.models = sanitizeModelList(state.models);
        }
      },
    }
  )
);

export default useModelStore;
