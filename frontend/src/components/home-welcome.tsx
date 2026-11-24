"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { IconType } from "react-icons";
import {
  LuArrowUpRight,
  LuBoxes,
  LuBug,
  LuCode,
  LuDatabase,
  LuGitPullRequest,
  LuRocket,
  LuSparkles,
  LuTerminal,
} from "react-icons/lu";
import { env } from "@/lib/env";
import { authedAxios } from "@/lib/axios";
import useSandboxProjectsStore, {
  type IProject,
  type IProjectFile,
} from "@/stores/sandbox-projects";

export type HomeSuggestion = {
  icon: IconType;
  label: string;
  prompt: string;
};

function getGeneralSuggestions(t: TFunction<"chat">): HomeSuggestion[] {
  return [
    {
      icon: LuRocket,
      label: t("suggestions.general.fullstackLabel"),
      prompt: t("suggestions.general.fullstackPrompt"),
    },
    {
      icon: LuBug,
      label: t("suggestions.general.debugLabel"),
      prompt: t("suggestions.general.debugPrompt"),
    },
    {
      icon: LuBoxes,
      label: t("suggestions.general.archLabel"),
      prompt: t("suggestions.general.archPrompt"),
    },
    {
      icon: LuDatabase,
      label: t("suggestions.general.dbLabel"),
      prompt: t("suggestions.general.dbPrompt"),
    },
    {
      icon: LuCode,
      label: t("suggestions.general.auditLabel"),
      prompt: t("suggestions.general.auditPrompt"),
    },
  ];
}

function getCodeModeSuggestions(t: TFunction<"chat">): HomeSuggestion[] {
  return [
    {
      icon: LuRocket,
      label: t("suggestions.code.buildLabel"),
      prompt: t("suggestions.code.buildPrompt"),
    },
    {
      icon: LuTerminal,
      label: t("suggestions.code.terminalLabel"),
      prompt: t("suggestions.code.terminalPrompt"),
    },
    {
      icon: LuDatabase,
      label: t("suggestions.code.migrationsLabel"),
      prompt: t("suggestions.code.migrationsPrompt"),
    },
    {
      icon: LuGitPullRequest,
      label: t("suggestions.code.prLabel"),
      prompt: t("suggestions.code.prPrompt"),
    },
  ];
}

function categoryToIcon(category?: string): IconType {
  switch (category?.toLowerCase()) {
    case "run":
      return LuTerminal;
    case "test":
    case "debug":
      return LuBug;
    case "feature":
      return LuRocket;
    case "git":
      return LuGitPullRequest;
    case "arch":
    case "code":
      return LuCode;
    case "db":
    case "database":
      return LuDatabase;
    default:
      return LuCode;
  }
}

function getProjectFallbackSuggestions(
  project: IProject,
  files: IProjectFile[],
  t: TFunction<"chat">
): HomeSuggestion[] {
  const name = project.display_name?.trim() || t("suggestions.defaultProjectName");
  const path = (project.filesystem_path || "").toLowerCase();

  const filePaths = files.map((f) => f.path.toLowerCase());
  const fileNames = filePaths.map((p) => p.split("/").pop() || "");

  const isNode =
    fileNames.includes("package.json") ||
    path.includes("node") ||
    path.includes("frontend") ||
    path.includes("web") ||
    path.includes("client");

  const isPython =
    fileNames.includes("requirements.txt") ||
    fileNames.includes("pyproject.toml") ||
    fileNames.includes("pipfile") ||
    fileNames.includes("manage.py") ||
    fileNames.includes("main.py") ||
    path.includes("backend") ||
    path.includes("api") ||
    path.includes("python");

  const hasDocker =
    fileNames.includes("dockerfile") ||
    fileNames.some((f) => f.includes("docker-compose"));

  const hasTests =
    fileNames.some((f) => f.includes("test") || f.includes("spec")) ||
    filePaths.some((p) => p.includes("/tests/") || p.includes("/__tests__/"));

  const items: HomeSuggestion[] = [];

  if (isNode) {
    items.push({
      icon: LuTerminal,
      label: t("suggestions.projectFallback.startDevLabel"),
      prompt: t("suggestions.projectFallback.startDevPrompt", { name }),
    });
  } else if (isPython) {
    items.push({
      icon: LuTerminal,
      label: t("suggestions.projectFallback.runApiLabel"),
      prompt: t("suggestions.projectFallback.runApiPrompt", { name }),
    });
  } else {
    items.push({
      icon: LuTerminal,
      label: t("suggestions.projectFallback.runTerminalLabel"),
      prompt: t("suggestions.projectFallback.runTerminalPrompt", { name }),
    });
  }

  items.push({
    icon: LuCode,
    label: t("suggestions.projectFallback.exploreArchLabel"),
    prompt: t("suggestions.projectFallback.exploreArchPrompt", { name }),
  });

  if (hasTests) {
    items.push({
      icon: LuBug,
      label: t("suggestions.projectFallback.runTestsLabel"),
      prompt: t("suggestions.projectFallback.runTestsPrompt", { name }),
    });
  } else {
    items.push({
      icon: LuBug,
      label: t("suggestions.projectFallback.debugLogsLabel"),
      prompt: t("suggestions.projectFallback.debugLogsPrompt", { name }),
    });
  }

  if (hasDocker) {
    items.push({
      icon: LuBoxes,
      label: t("suggestions.projectFallback.dockerLabel"),
      prompt: t("suggestions.projectFallback.dockerPrompt", { name }),
    });
  } else {
    items.push({
      icon: LuRocket,
      label: t("suggestions.projectFallback.addFeatureLabel"),
      prompt: t("suggestions.projectFallback.addFeaturePrompt", { name }),
    });
  }

  items.push({
    icon: LuGitPullRequest,
    label: t("suggestions.projectFallback.gitDiffLabel"),
    prompt: t("suggestions.projectFallback.gitDiffPrompt", { name }),
  });

  return items;
}

export function HomeSuggestions({
  mode,
  onSelect,
}: {
  mode: "chat" | "code";
  onSelect: (prompt: string) => void;
}) {
  const { t } = useTranslation("chat");
  const currentSandbox = useSandboxProjectsStore((s) => s.currentSandbox);
  const files = useSandboxProjectsStore((s) => s.files);

  const [fetchedSuggestions, setFetchedSuggestions] = useState<HomeSuggestion[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // If the project already has persisted suggestions from the database, use them immediately
  const dbSuggestions = useMemo<HomeSuggestion[] | null>(() => {
    if (
      !currentSandbox?.suggestions ||
      !Array.isArray(currentSandbox.suggestions) ||
      currentSandbox.suggestions.length === 0
    ) {
      return null;
    }
    return currentSandbox.suggestions.map((item) => ({
      icon: categoryToIcon(item.category),
      label: item.label,
      prompt: item.prompt,
    }));
  }, [currentSandbox?.suggestions]);

  // Only fetch if project exists and has no suggestions yet (e.g. legacy project)
  useEffect(() => {
    if (!currentSandbox?.uuid) {
      setFetchedSuggestions(null);
      setIsLoading(false);
      return;
    }

    if (dbSuggestions && dbSuggestions.length > 0) {
      setFetchedSuggestions(null);
      setIsLoading(false);
      return;
    }

    let isMounted = true;
    setIsLoading(true);

    const loadAndFetch = async () => {
      try {
        const res = await authedAxios.get(
          `${env.API_URL}/sandbox/sandboxes/${currentSandbox.uuid}/suggestions/`
        );
        if (!isMounted) return;
        const raw = res.data?.suggestions;
        if (Array.isArray(raw) && raw.length > 0) {
          const mapped: HomeSuggestion[] = raw.map((item: any) => ({
            icon: categoryToIcon(item.category),
            label: item.label,
            prompt: item.prompt,
          }));
          setFetchedSuggestions(mapped);

          // Update store so this project and any subsequent tab changes have it in state
          useSandboxProjectsStore.setState((state) => ({
            sandboxes: state.sandboxes.map((s) =>
              s.uuid === currentSandbox.uuid ? { ...s, suggestions: raw } : s
            ),
            currentSandbox:
              state.currentSandbox?.uuid === currentSandbox.uuid
                ? { ...state.currentSandbox, suggestions: raw }
                : state.currentSandbox,
          }));
        }
      } catch (err) {
        console.warn("Project suggestions fetch error:", err);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };

    void loadAndFetch();

    return () => {
      isMounted = false;
    };
  }, [currentSandbox?.uuid, dbSuggestions]);

  const suggestions = useMemo(() => {
    if (currentSandbox) {
      if (dbSuggestions && dbSuggestions.length > 0) {
        return dbSuggestions;
      }
      if (fetchedSuggestions && fetchedSuggestions.length > 0) {
        return fetchedSuggestions;
      }
      return getProjectFallbackSuggestions(currentSandbox, files, t);
    }
    return mode === "code" ? getCodeModeSuggestions(t) : getGeneralSuggestions(t);
  }, [currentSandbox, files, mode, dbSuggestions, fetchedSuggestions, t]);

  return (
    <div
      className="chat-enter flex w-full max-w-2xl sm:max-w-[700px] flex-col gap-2 px-3 sm:px-4"
      style={{ animationDelay: "420ms" }}
      aria-label={t("suggestions.ariaLabel")}
    >
      {currentSandbox && isLoading && !dbSuggestions && !fetchedSuggestions && (
        <div className="flex items-center gap-1.5 px-1 py-0.5 text-[11px] text-muted-foreground animate-pulse">
          <LuSparkles className="h-3 w-3 text-indigo-500" />
          <span>{t("suggestions.loadingProject", { name: currentSandbox.display_name })}</span>
        </div>
      )}

      {suggestions.map((item) => (
        <button
          key={item.label}
          type="button"
          onClick={() => onSelect(item.prompt)}
          className="group flex w-full items-center justify-between gap-3 rounded-xl border border-border/70 bg-card/40 px-3.5 py-2.5 text-left text-xs text-muted-foreground backdrop-blur transition-all hover:border-primary/30 hover:bg-card/80 hover:text-foreground active:scale-[0.99]"
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <item.icon className="h-4 w-4 shrink-0 text-indigo-500 transition-transform group-hover:scale-110 dark:text-indigo-400" />
            <span className="font-medium text-foreground shrink-0">{item.label}</span>
            <span className="hidden sm:inline text-muted-foreground/60 shrink-0">—</span>
            <span className="truncate text-muted-foreground/80">{item.prompt}</span>
          </div>
          <LuArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground" />
        </button>
      ))}
    </div>
  );
}
