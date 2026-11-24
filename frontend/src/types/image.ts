export interface SharedImage {
  uuid: string;
  imageUrl: string;
  imageBlurDataUrl?: string;
  prompt: string;
  negative_prompt?: string;
  width: number;
  height: number;
  seed?: number;
  num_inference_steps?: number;
  model?: string;
  tag?: string;
  modelAuthor?: string;
  author?: string;
  sharedAt?: string;
  category?: string;
  order?: number;
  related_tags?: string[];
  reactions?: Record<string, number>;
  user_reactions?: string[];
}

export interface ImageComment {
  uuid: string;
  user: string;
  user_profile_picture?: string;
  user_profile_picture_blur_data_url?: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface CategoryOption {
  name: string;
  count: number;
}
