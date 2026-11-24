"use client";

import React from "react";
import { cn } from "@/lib/utils";

interface AmbientGlowProps {
  isSending?: boolean;
  fadeOut?: boolean;
  className?: string;
}

/**
 * AmbientGlow
 * 
 * Provides a modern, GPU-accelerated atmospheric lighting/glow effect for the New Chat screen.
 * Uses layered, hardware-accelerated radial gradients with slow, organic breathing & drifting motion.
 * Automatically adapts between Dark (#050508) and Light (#f9fafb) themes and smoothly fades out
 * when the user sends a message or when a conversation view opens.
 */
export default function AmbientGlow({ isSending = false, fadeOut = false, className }: AmbientGlowProps) {
  const shouldFade = isSending || fadeOut;

  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 -z-10 overflow-hidden select-none flex items-center justify-center transition-[opacity,transform] duration-650 ease-out motion-reduce:transition-none",
        shouldFade ? "opacity-0 scale-95" : "opacity-100 scale-100",
        className
      )}
      style={{
        // Radial mask guarantees soft falloff with zero hard edge clipping
        maskImage: "radial-gradient(ellipse 70% 65% at 50% 48%, black 20%, transparent 80%)",
        WebkitMaskImage: "radial-gradient(ellipse 70% 65% at 50% 48%, black 20%, transparent 80%)",
      }}
    >
      <div className="ambient-glow-enter relative w-full max-w-5xl h-[560px] flex items-center justify-center">
        {/* Core Ambient Breathing Glow (Center) */}
        <div
          className={cn(
            "absolute top-[32%] -translate-y-1/2 rounded-full anim-ambient-breath",
            "w-[340px] h-[220px] sm:w-[580px] sm:h-[340px] md:w-[740px] md:h-[400px]",
            "bg-gradient-to-tr from-indigo-500/25 via-violet-500/20 to-cyan-400/15",
            "dark:from-indigo-600/30 dark:via-violet-600/25 dark:to-cyan-400/18",
            "blur-[80px] sm:blur-[110px] md:blur-[130px]"
          )}
        />

        {/* Drift Orb A (Violet/Purple - Left & Lower Accent) */}
        <div
          className={cn(
            "absolute top-[38%] left-[18%] -translate-x-1/2 -translate-y-1/2 rounded-full anim-ambient-drift-a",
            "w-[220px] h-[180px] sm:w-[380px] sm:h-[280px] md:w-[480px] md:h-[320px]",
            "bg-gradient-to-br from-violet-600/20 via-purple-600/15 to-indigo-600/10",
            "dark:from-violet-500/22 dark:via-purple-500/18 dark:to-indigo-500/12",
            "blur-[70px] sm:blur-[95px] md:blur-[115px]"
          )}
        />

        {/* Drift Orb B (Cyan/Emerald - Right & Upper Accent) */}
        <div
          className={cn(
            "absolute top-[28%] right-[16%] translate-x-1/2 -translate-y-1/2 rounded-full anim-ambient-drift-b",
            "w-[200px] h-[160px] sm:w-[340px] sm:h-[260px] md:w-[440px] md:h-[300px]",
            "bg-gradient-to-tl from-cyan-400/20 via-sky-500/15 to-indigo-500/10",
            "dark:from-cyan-400/18 dark:via-sky-400/14 dark:to-indigo-500/12",
            "blur-[70px] sm:blur-[95px] md:blur-[115px]"
          )}
        />

        {/* Subtle Top Spotlight Flare (Soft directional highlight from top-center) */}
        <div
          className={cn(
            "absolute -top-12 left-1/2 -translate-x-1/2 rounded-full",
            "w-[260px] h-[90px] sm:w-[460px] sm:h-[140px] md:w-[600px] md:h-[180px]",
            "bg-gradient-to-b from-indigo-400/20 via-violet-400/10 to-transparent",
            "dark:from-indigo-400/25 dark:via-violet-400/12 dark:to-transparent",
            "blur-[50px] sm:blur-[70px]"
          )}
        />
      </div>
    </div>
  );
}
