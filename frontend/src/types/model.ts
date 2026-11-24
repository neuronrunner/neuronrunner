// types/model.ts
import type { ReasoningMode, ReasoningTier } from '@/lib/reasoning';
import type { Tag } from './tag';

export interface Model {
  uuid: string;
  name: string;
  description: string;
  readme: string;
  thumbnail: File | string | undefined;
  thumbnail_blur_data_url?: string;
  category: string;
  author: string;
  model_type: string;
  default_tag: string;
  tags?: Tag[];
  runs?: number;
  likes_count?: number;
  is_liked?: boolean;
  is_public?: boolean;
  benchmark_scores?: Record<string, number>;
  llm_stats_id?: string | null;
  display_name?: string;
  is_free_tier?: boolean;
  is_byok?: boolean;
  is_byos?: boolean;
  provider_name?: string;
  is_reasoning?: boolean;
  reasoning_mode?: ReasoningMode;
  reasoning_tiers?: ReasoningTier[];
  default_reasoning_effort?: ReasoningTier;
  supports_vision?: boolean;
  context_length?: number | null;
}
