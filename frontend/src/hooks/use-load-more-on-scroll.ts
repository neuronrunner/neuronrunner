"use client";

import { useEffect, type RefObject } from "react";

interface Options {
  /** False while there is nothing more to load, a load is running, or an error is showing. */
  enabled: boolean;
  onLoadMore: () => void;
  /** The scrolling container. */
  rootRef: RefObject<HTMLElement | null>;
  /** The marker element rendered after the last row. */
  sentinelRef: RefObject<HTMLElement | null>;
  /** Re-check whenever the number of rows changes (a short page can leave the marker on screen). */
  itemCount: number;
  /** Start loading this many pixels before the marker scrolls into view. */
  margin?: number;
}

/**
 * Infinite scroll that measures the marker directly instead of relying on IntersectionObserver callbacks:
 * it checks right after every render that matters, on scroll and on resize, so a list that is still
 * too short to scroll keeps loading pages until the marker falls below the fold.
 */
export function useLoadMoreOnScroll({ enabled, onLoadMore, rootRef, sentinelRef, itemCount, margin = 200 }: Options) {
  useEffect(() => {
    if (!enabled) return;
    const check = () => {
      const marker = sentinelRef.current;
      const root = rootRef.current;
      if (!marker || !root) return;
      if (marker.getBoundingClientRect().top <= root.getBoundingClientRect().bottom + margin) onLoadMore();
    };
    check();
    const root = rootRef.current;
    root?.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    return () => {
      root?.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, [enabled, onLoadMore, itemCount, margin, rootRef, sentinelRef]);
}
