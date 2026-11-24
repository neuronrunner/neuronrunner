export interface IRequestImage {
  uuid: string;
  image_url: string;
  prompt: string;
}

export interface IRequest {
  uuid: string;
  created_at: string;
  model: string | null;
  model_tag: string | null;
  cost_usd: number | null;
  cost?: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  duration_seconds: number | null;
  pricing_model: string | null;
  images?: IRequestImage[];
}

export interface IRequestStats {
  total_duration: number | 0;
  total_cost_usd: number | 0;
  total_cost?: number | 0;
  total_input_tokens: number | 0;
  total_output_tokens: number | 0;
}