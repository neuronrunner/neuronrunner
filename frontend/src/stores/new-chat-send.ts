import { create } from "zustand";

/**
 * True while a first message is being sent from the new-chat screen, before the
 * route has moved to /chat/<id>. The workspace shell reads it so the header and
 * its top inset are reserved from the first frame of the conversation instead of
 * appearing (and shifting the content) once the route changes.
 */
interface NewChatSendState {
  isSendingFromNew: boolean;
  setIsSendingFromNew: (isSendingFromNew: boolean) => void;
}

const useNewChatSendStore = create<NewChatSendState>((set) => ({
  isSendingFromNew: false,
  setIsSendingFromNew: (isSendingFromNew) =>
    set((state) => (state.isSendingFromNew === isSendingFromNew ? state : { isSendingFromNew })),
}));

export default useNewChatSendStore;
