import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/** Fade the previous text out before revealing its replacement. */
export default function FadingText({ text, className }: { text: string; className?: string }) {
  const [displayedText, setDisplayedText] = useState(text);
  const [fadingOut, setFadingOut] = useState(false);

  useEffect(() => {
    if (text === displayedText || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDisplayedText(text);
      setFadingOut(false);
      return;
    }

    setFadingOut(true);
    const timeout = setTimeout(() => {
      setDisplayedText(text);
      setFadingOut(false);
    }, 150);
    return () => clearTimeout(timeout);
  }, [text, displayedText]);

  return (
    <span className={cn("title-fade-in truncate", className)}>
      <span className="transition-opacity duration-150 motion-reduce:transition-none" style={{ opacity: fadingOut ? 0 : 1 }}>
        {displayedText}
      </span>
    </span>
  );
}
