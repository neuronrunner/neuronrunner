import { create } from "zustand";

interface NavbarState {
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
  isNotFound: boolean;
  setIsNotFound: (isNotFound: boolean) => void;
}

const useNavbarStore = create<NavbarState>((set) => ({
  isOpen: false,
  setIsOpen: (isOpen) => set({ isOpen }),
  isNotFound: false,
  setIsNotFound: (isNotFound) => set({ isNotFound }),
}));

export default useNavbarStore;