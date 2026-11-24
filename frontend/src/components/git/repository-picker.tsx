"use client";

import { useTranslation } from "react-i18next";
import { LuFolderGit2 } from "react-icons/lu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { WorkspaceRepository } from "@/lib/repository-api";
import { cn } from "@/lib/utils";

export function RepositoryPicker({ repositories, value, onChange, className }: { repositories: WorkspaceRepository[]; value?: string; onChange: (path: string) => void; className?: string }) {
  const { t } = useTranslation("git");
  const selected = repositories.find(repository => repository.path === value);
  return <Select value={value || ""} onValueChange={onChange}>
    <SelectTrigger aria-label={t("picker.ariaLabel")} title={selected?.path} className={cn("h-10 min-w-0 gap-2 rounded-lg border-border bg-background text-xs shadow-none [&>span]:min-w-0 [&>span]:flex-1 [&>span]:text-left", className)}>
      <LuFolderGit2 aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" /><SelectValue placeholder={t("picker.placeholder")}>{selected && <span className="block truncate font-medium">{selected.github_repository || selected.name}</span>}</SelectValue>
    </SelectTrigger>
    <SelectContent className="w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)]">
      {repositories.map((item) => <SelectItem key={item.path} value={item.path} textValue={`${item.name} ${item.path}`} className="text-xs [&>span:last-child]:min-w-0 [&>span:last-child]:flex-1"><span className="block truncate font-medium">{item.github_repository || item.name}</span><span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground" title={item.path}>{item.path}</span></SelectItem>)}
    </SelectContent>
  </Select>;
}
