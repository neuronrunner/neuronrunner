import { create } from 'zustand';
import { clearRecentModelsCache, fetchRecentModels } from '@/lib/recent-models';

interface RecentModelsState {
  recentModels: any[];
  isLoadingRecentModels: boolean;
  recentModelsToken: string | null;
  loadRecentModels: (token?: string | null) => Promise<void>;
  clearRecentModels: () => void;
}

const useRecentModelsStore = create<RecentModelsState>((set, get) => ({
  recentModels: [],
  isLoadingRecentModels: false,
  recentModelsToken: null,

  loadRecentModels: async (token) => {
    const normalizedToken = token || null;
    const { recentModelsToken, recentModels } = get();

    if (!normalizedToken) {
      if (recentModelsToken) {
        clearRecentModelsCache();
      }
      set({ recentModels: [], recentModelsToken: null, isLoadingRecentModels: false });
      return;
    }

    if (recentModelsToken && recentModelsToken !== normalizedToken) {
      clearRecentModelsCache();
      set({ recentModels: [] });
    }

    if (recentModelsToken === normalizedToken && recentModels.length > 0) {
      return;
    }

    set({ isLoadingRecentModels: true, recentModelsToken: normalizedToken });
    try {
      const models = await fetchRecentModels(normalizedToken);
      set({ recentModels: models as any[] });
    } catch (error) {
      console.error('Failed to fetch recent models:', error);
      set({ recentModels: [] });
    } finally {
      set({ isLoadingRecentModels: false });
    }
  },

  clearRecentModels: () => {
    clearRecentModelsCache();
    set({ recentModels: [], recentModelsToken: null, isLoadingRecentModels: false });
  },
}));

export default useRecentModelsStore;