"use client";

import { useEffect, useRef } from "react";
import { useTheme } from "next-themes";
import { useTranslation } from "react-i18next";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { LuCheck, LuCircleAlert, LuLoaderCircle } from "react-icons/lu";
import { cn } from "@/lib/utils";

interface Props {
  log: string;
  status: "cloning" | "creating" | "success" | "error";
  repository?: string;
  destination?: string;
}

export default function GitCloneProgress({ log, status, repository, destination }: Props) {
  const { t } = useTranslation("git");
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const written = useRef("");
  const logRef = useRef(log); logRef.current = log;
  const { resolvedTheme } = useTheme();
  const isLight = resolvedTheme === "light";
  const lightRef = useRef(isLight); lightRef.current = isLight;
  const theme = (light: boolean) => ({ background: light ? "#ffffff" : "#0c0c0e", foreground: light ? "#1f2937" : "#e4e4e7", cursor: "#00000000", selectionBackground: light ? "#dbeafe" : "#292943", scrollbarSliderBackground: "#80808030", scrollbarSliderHoverBackground: "#80808060", overviewRulerBorder: "#00000000" });
  const write = (output: string) => {
    const term = terminal.current;
    if (!term) return;
    if (output.startsWith(written.current)) term.write(output.slice(written.current.length));
    else { term.reset(); term.write("\x1b[?25l" + output); }
    written.current = output;
  };
  const writeRef = useRef(write); writeRef.current = write;

  useEffect(() => {
    if (!container.current) return;
    const term = new Terminal({ fontFamily: "SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace", fontSize: 11, convertEol: true, disableStdin: true, cursorBlink: false, scrollback: 2000, overviewRuler: { width: 0 }, theme: theme(lightRef.current) });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(container.current);
    terminal.current = term; written.current = ""; term.write("\x1b[?25l"); writeRef.current(logRef.current);
    const resize = () => { try { fit.fit(); } catch {} };
    const observer = new ResizeObserver(resize); observer.observe(container.current);
    const frame = requestAnimationFrame(resize);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); terminal.current = null; term.dispose(); };
  }, []);
  useEffect(() => { writeRef.current(log); }, [log]);
  useEffect(() => { if (terminal.current) terminal.current.options.theme = theme(isLight); }, [isLight]);

  const label = status === "error" ? t("cloneProgress.status.error") : status === "success" ? t("cloneProgress.status.success") : status === "creating" ? t("cloneProgress.status.creating") : log ? t("cloneProgress.status.cloning") : t("cloneProgress.status.starting");
  const Icon = status === "error" ? LuCircleAlert : status === "success" ? LuCheck : LuLoaderCircle;
  return <section aria-label={t("cloneProgress.ariaLabel")} className="space-y-3">
    {repository && <div className="min-w-0"><p className="truncate text-sm font-medium">{repository}</p>{destination && <p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={destination}>{destination}</p>}</div>}
    <div className="overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/20 px-3 py-2"><span aria-live="polite" className="flex min-w-0 items-center gap-2 text-xs font-medium"><Icon className={cn("h-3.5 w-3.5 shrink-0", status === "error" ? "text-destructive" : status === "success" ? "text-emerald-500" : "animate-spin text-violet-500")} /><span className="truncate">{label}</span></span><span className="shrink-0 font-mono text-[10px] text-muted-foreground">git-clone.log</span></div>
      <div ref={container} role="log" aria-label={t("cloneProgress.terminalAriaLabel")} className="h-60 overflow-hidden bg-[#0c0c0e] p-2 dark:bg-[#0c0c0e]" style={{ background: isLight ? "#ffffff" : "#0c0c0e" }} />
      <pre aria-label={t("cloneProgress.outputAriaLabel")} className="sr-only">{log}</pre>
    </div>
  </section>;
}
