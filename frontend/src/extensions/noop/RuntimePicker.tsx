"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { LuPlay, LuPlus, LuServer, LuSquare, LuTrash2 } from "react-icons/lu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import useWorkspacesStore from "@/stores/workspaces";
import { DEFAULT_RUNTIME, normalizeRuntimeName, useLocalRuntimesStore, type LocalRuntime } from "./index";

const isUp = (runtime: LocalRuntime) => runtime.status === "running" || runtime.status === "starting";

function StatusDot({ runtime }: { runtime: LocalRuntime | undefined }) {
  const up = runtime ? isUp(runtime) : false;
  return (
    <span
      aria-hidden
      className={cn("h-1.5 w-1.5 shrink-0 rounded-full", up ? "bg-emerald-500" : "bg-muted-foreground/40")}
    />
  );
}

/** Toolbar control to launch, pick and stop the workspace's local Docker runtimes. */
export default function RuntimePicker() {
  const { t } = useTranslation("workspace");
  const workspaceUuid = useWorkspacesStore((state) => state.currentWorkspaceUuid);
  const { items, maxConcurrent, running, supported, pending, error, loading } = useLocalRuntimesStore();
  const selectedName = useLocalRuntimesStore((state) =>
    workspaceUuid ? state.selected[workspaceUuid] || DEFAULT_RUNTIME : DEFAULT_RUNTIME
  );
  const { fetch, select, launch, stop } = useLocalRuntimesStore.getState();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (workspaceUuid) void fetch(workspaceUuid);
  }, [workspaceUuid, fetch]);

  useEffect(() => {
    if (open && workspaceUuid) void fetch(workspaceUuid);
  }, [open, workspaceUuid, fetch]);

  if (!workspaceUuid || !supported) return null;

  const selected = items.find((item) => item.name === selectedName);
  const atLimit = maxConcurrent !== null && running >= maxConcurrent;
  const draftName = normalizeRuntimeName(draft);
  const draftExists = Boolean(draftName && items.some((item) => item.name === draftName));

  const pick = async (runtime: LocalRuntime) => {
    if (isUp(runtime)) {
      select(workspaceUuid, runtime.name);
      return;
    }
    await launch(workspaceUuid, runtime.name);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draftName) return;
    if (await launch(workspaceUuid, draftName)) setDraft("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("runtimes.trigger", { name: selectedName })}
          title={t("runtimes.trigger", { name: selectedName })}
          data-testid="runtime-picker"
          className="inline-flex h-7 max-w-[10rem] items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-all hover:bg-background/60 hover:text-foreground"
        >
          <LuServer className="h-3.5 w-3.5 shrink-0 text-violet-500" />
          <span className="truncate">{selectedName}</span>
          <StatusDot runtime={selected} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <div className="flex items-baseline justify-between px-2 pb-1.5 pt-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("runtimes.title")}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {maxConcurrent === null
              ? t("runtimes.runningUnlimited", { count: running })
              : t("runtimes.running", { count: running, max: maxConcurrent })}
          </span>
        </div>

        <ul className="flex flex-col gap-0.5" role="listbox" aria-label={t("runtimes.title")}>
          {items.map((runtime) => {
            const active = runtime.name === selectedName;
            const busy = pending === runtime.name;
            return (
              <li
                key={runtime.name}
                role="option"
                aria-selected={active}
                className={cn(
                  "group flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs",
                  active ? "bg-accent text-accent-foreground" : "hover:bg-muted"
                )}
              >
                <button
                  type="button"
                  disabled={busy || (!isUp(runtime) && atLimit)}
                  onClick={() => void pick(runtime)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-60"
                  title={!isUp(runtime) && atLimit ? t("runtimes.limitReached") : undefined}
                >
                  <StatusDot runtime={runtime} />
                  <span className="truncate font-medium">{runtime.name}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                    {busy ? t("runtimes.working") : t(`runtimes.status.${runtime.status}`)}
                  </span>
                </button>
                {isUp(runtime) ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void stop(workspaceUuid, runtime.name)}
                    aria-label={t("runtimes.stop", { name: runtime.name })}
                    title={t("runtimes.stop", { name: runtime.name })}
                    className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-50"
                  >
                    <LuSquare className="h-3 w-3" />
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy || atLimit}
                    onClick={() => void launch(workspaceUuid, runtime.name)}
                    aria-label={t("runtimes.start", { name: runtime.name })}
                    title={atLimit ? t("runtimes.limitReached") : t("runtimes.start", { name: runtime.name })}
                    className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-50"
                  >
                    <LuPlay className="h-3 w-3" />
                  </button>
                )}
                {!runtime.is_default && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void stop(workspaceUuid, runtime.name, { remove: true })}
                    aria-label={t("runtimes.remove", { name: runtime.name })}
                    title={t("runtimes.remove", { name: runtime.name })}
                    className="rounded p-1 text-muted-foreground hover:bg-background hover:text-destructive disabled:opacity-50"
                  >
                    <LuTrash2 className="h-3 w-3" />
                  </button>
                )}
              </li>
            );
          })}
          {loading && items.length === 0 && (
            <li className="px-2 py-1.5 text-xs text-muted-foreground">{t("runtimes.loading")}</li>
          )}
        </ul>

        <form onSubmit={submit} className="mt-2 flex items-center gap-1.5 border-t border-border/60 px-1 pt-2">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t("runtimes.namePlaceholder")}
            aria-label={t("runtimes.namePlaceholder")}
            maxLength={24}
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-ring"
          />
          <button
            type="submit"
            disabled={!draftName || draftExists || atLimit || pending !== null}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            <LuPlus className="h-3.5 w-3.5" />
            {t("runtimes.launch")}
          </button>
        </form>
        {(error || (draft && !draftName) || atLimit) && (
          <p className="px-2 pt-1.5 text-[11px] text-muted-foreground" role={error ? "alert" : undefined}>
            {error || (draft && !draftName ? t("runtimes.invalidName") : t("runtimes.limitReached"))}
          </p>
        )}
        <p className="px-2 pt-1.5 text-[10px] leading-snug text-muted-foreground/80">{t("runtimes.hint")}</p>
      </PopoverContent>
    </Popover>
  );
}
