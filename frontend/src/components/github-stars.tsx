"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IoLogoGithub } from "react-icons/io5";
import { LuStar } from "react-icons/lu";
import { cn } from "@/lib/utils";

export const GITHUB_REPO = "neuronrunner/neuronrunner";
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO}`;

const CACHE_KEY = "nr_github_stars";
const CACHE_MS = 60 * 60 * 1000; // GitHub allows 60 anonymous requests an hour per address

function readCache(): { count: number; at: number } | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return typeof value?.count === "number" && typeof value?.at === "number" ? value : null;
  } catch {
    return null;
  }
}

let inflightStars: Promise<number | null> | null = null;

function fetchStars(): Promise<number | null> {
  if (!inflightStars) {
    inflightStars = fetch(`https://api.github.com/repos/${GITHUB_REPO}`, {
      headers: { Accept: "application/vnd.github+json" },
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (typeof data?.stargazers_count !== "number") return null;
        try {
          window.localStorage.setItem(CACHE_KEY, JSON.stringify({ count: data.stargazers_count, at: Date.now() }));
        } catch {
          // storage unavailable: the count is simply fetched again next time
        }
        return data.stargazers_count as number;
      })
      .catch(() => null)
      .finally(() => {
        inflightStars = null;
      });
  }
  return inflightStars;
}

/** Star count of the public repository, or null while it is unknown. Cached for an hour; a failed request shows nothing. */
export function useGitHubStars(): number | null {
  const [count, setCount] = useState<number | null>(() => (typeof window === "undefined" ? null : readCache()?.count ?? null));
  useEffect(() => {
    const cached = readCache();
    if (cached && Date.now() - cached.at < CACHE_MS) {
      setCount(cached.count);
      return;
    }
    let active = true;
    void fetchStars().then((stars) => {
      if (active && stars !== null) setCount(stars);
    });
    return () => {
      active = false;
    };
  }, []);
  return count;
}

export function formatStars(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(count >= 10000 ? 0 : 1).replace(/\.0$/, "")}k` : String(count);
}

/** "Star on GitHub" button with the live star count, styled like the secondary hero button. */
export function GitHubStarLink({ className, badgeClassName }: { className?: string; badgeClassName?: string }) {
  const { t } = useTranslation("landing");
  const stars = useGitHubStars();
  return (
    <a
      href={GITHUB_REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "group inline-flex min-h-11 items-center justify-center gap-2.5 rounded-xl border border-border/80 bg-card/60 px-5 text-sm font-medium text-foreground backdrop-blur-md transition-all duration-200 hover:-translate-y-0.5 hover:border-foreground/25 hover:bg-card",
        className,
      )}
    >
      <IoLogoGithub className="h-4 w-4 shrink-0" />
      <span>{t("hero.starOnGithub", { defaultValue: "Star on GitHub" })}</span>
      {stars !== null && (
        <span
          className={cn(
            "inline-flex items-center gap-1 border-l border-border/80 pl-2.5 font-mono text-xs font-medium tabular-nums text-muted-foreground transition-colors group-hover:text-foreground",
            badgeClassName,
          )}
        >
          <LuStar className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
          {formatStars(stars)}
        </span>
      )}
    </a>
  );
}
