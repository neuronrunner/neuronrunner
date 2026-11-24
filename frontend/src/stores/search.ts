import { create } from "zustand";

export type SearchType = "models" | "images";

interface SearchState {
  searchType: SearchType;
  searchQuery: string;
  setSearchType: (type: SearchType) => void;
  setSearchQuery: (query: string) => void;
  reset: () => void;
}

const useSearchStore = create<SearchState>((set) => ({
  searchType: "models",
  searchQuery: "",
  
  setSearchType: (type) => set({ searchType: type }),
  
  setSearchQuery: (query) => set({ searchQuery: query }),
  
  reset: () => set({ searchQuery: "", searchType: "models" }),
}));

export default useSearchStore;
