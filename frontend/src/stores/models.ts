import { env } from "@/lib/env";
import { create } from 'zustand';
import type { Model } from '@/types/model';
import axios from 'axios';

type SharedImage = {
  uuid: string;
  imageUrl: string;
  prompt: string;
  width: number;
  height: number;
  seed?: number;
  tag?: string;
  author?: string;
};

interface ModelDetailState {
  model: Model | null;
  setModel: (model: Model) => void;
  isLikeLoading: boolean;
  isPublishLoading: boolean;
  galleryImages: SharedImage[];
  isGalleryLoading: boolean;
  setIsLikeLoading: (loading: boolean) => void;
  setIsPublishLoading: (loading: boolean) => void;
  setGalleryImages: (images: SharedImage[]) => void;
  setIsGalleryLoading: (loading: boolean) => void;
  refreshLikeStatus: (modelName: string, token: string) => Promise<void>;
  fetchGallery: (modelName: string, modelType: string) => Promise<void>;
  toggleLike: (modelName: string, token: string) => Promise<void>;
  publishModel: (modelName: string, token: string) => Promise<void>;
}

const apiBase = env.API_URL;

type GalleryResponseItem = {
  uuid: string;
  image_url: string;
  prompt: string;
  width: number;
  height: number;
  seed?: number;
  tag?: string;
  user?: string;
};

export const useModelDetailStore = create<ModelDetailState>((set, get) => ({
  model: null,
  setModel: (model) => set({ model }),
  isLikeLoading: false,
  isPublishLoading: false,
  galleryImages: [],
  isGalleryLoading: false,
  setIsLikeLoading: (loading) => set({ isLikeLoading: loading }),
  setIsPublishLoading: (loading) => set({ isPublishLoading: loading }),
  setGalleryImages: (images) => set({ galleryImages: images }),
  setIsGalleryLoading: (loading) => set({ isGalleryLoading: loading }),
  refreshLikeStatus: async (modelName, token) => {
    if (!apiBase || !token) return;

    try {
      const response = await axios.get(`${apiBase}/models/${modelName}/?fields=is_liked`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      set((state) => ({
        model: state.model && state.model.name === modelName
          ? {
              ...state.model,
              is_liked: response.data.is_liked,
            }
          : state.model,
      }));
    } catch (error) {
      console.error('Failed to refresh model with auth:', error);
    }
  },
  fetchGallery: async () => {
    set({ galleryImages: [], isGalleryLoading: false });
  },
  toggleLike: async (modelName, token) => {
    const { model, isLikeLoading } = get();
    if (!apiBase || !model || !token) return;
    if (isLikeLoading) return;

    const previousModel = model;
    const nextIsLiked = !model.is_liked;
    const nextLikesCount = Math.max(
      0,
      (model.likes_count ?? 0) + (model.is_liked ? -1 : 1)
    );

    set({
      isLikeLoading: true,
      model: {
        ...model,
        is_liked: nextIsLiked,
        likes_count: nextLikesCount,
      },
    });

    try {
      const endpoint = previousModel.is_liked ? 'unlike' : 'like';
      const response = await axios.post(
        `${apiBase}/models/${modelName}/${endpoint}/`,
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );

      set((state) => ({
        model: state.model
          ? {
              ...state.model,
              is_liked: response.data.is_liked,
              likes_count: response.data.likes_count,
            }
          : state.model,
      }));
    } catch (error) {
      set({ model: previousModel });
      throw error;
    } finally {
      set({ isLikeLoading: false });
    }
  },
  publishModel: async (modelName, token) => {
    const { model, isPublishLoading } = get();
    if (!apiBase || !model || !token) return;
    if (isPublishLoading) return;

    set({ isPublishLoading: true });
    try {
      const response = await axios.post(
        `${apiBase}/models/${modelName}/publish/`,
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );

      set((state) => ({
        model: state.model
          ? {
              ...state.model,
              is_public: response.data.is_public,
            }
          : state.model,
      }));
    } catch (error) {
      throw error;
    } finally {
      set({ isPublishLoading: false });
    }
  },
}));
