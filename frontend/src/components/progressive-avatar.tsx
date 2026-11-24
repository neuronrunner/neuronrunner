"use client";

import React, { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface ProgressiveAvatarProps {
  name?: string;
  src?: string;
  blurDataUrl?: string;
  className?: string;
  rootProps?: any;
}

const ProgressiveAvatar: React.FC<ProgressiveAvatarProps> = ({
  name,
  src,
  blurDataUrl,
  className,
}) => {
  const [isHighResLoaded, setIsHighResLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setIsHighResLoaded(false);
    setHasError(false);

    if (!src) {
      return;
    }

    const image = new window.Image();
    image.src = src;
    image.onload = () => setIsHighResLoaded(true);
    image.onerror = () => {
      setIsHighResLoaded(false);
      setHasError(true);
    };
  }, [src]);

  const displaySrc = isHighResLoaded ? src : (blurDataUrl || undefined);
  const showImage = !!src && !hasError && (isHighResLoaded || !!blurDataUrl);

  const cleanName = (name || "").trim();
  const initials = cleanName
    ? cleanName
        .split(/\s+/)
        .map((n) => n[0])
        .join("")
        .substring(0, 2)
        .toUpperCase()
    : "U";

  return (
    <div
      className={cn(
        "relative inline-flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-200/90 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border border-border/50 font-semibold text-xs select-none",
        className
      )}
    >
      {showImage ? (
        <img
          src={displaySrc}
          alt={name || "Avatar"}
          className={cn(
            "h-full w-full object-cover transition-all duration-300",
            isHighResLoaded ? "opacity-100 blur-none scale-100" : "opacity-70 blur-sm scale-105"
          )}
        />
      ) : (
        <span>{initials}</span>
      )}
    </div>
  );
};

export default ProgressiveAvatar;
