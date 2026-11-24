import { useEffect } from "react";
import useWorkspaceTabsStore from "@/stores/workspace-tabs";

/** Collapses the right-hand split panel when a full-width page mounts. */
export function useCloseRightPanelOnMount() {
  useEffect(() => {
    if (useWorkspaceTabsStore.getState().isSplit) {
      useWorkspaceTabsStore.setState({ isSplit: false, focusedPane: "left" });
    }
  }, []);
}
