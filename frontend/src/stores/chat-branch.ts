"use client";

import { create } from "zustand";

/** A branch picked before the chat exists; it is sent with the first message and becomes that chat's own checkout. */
export interface PendingChatBranch {
  project: string;
  branch: string;
  create: boolean;
}

interface ChatBranchState {
  pending: PendingChatBranch | null;
  setPending: (pending: PendingChatBranch | null) => void;
}

export const useChatBranchStore = create<ChatBranchState>((set) => ({
  pending: null,
  setPending: (pending) => set({ pending }),
}));
