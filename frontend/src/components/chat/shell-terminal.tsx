"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCheck, LuCopy, LuTerminal } from "react-icons/lu";
import type { StreamToolCall } from "./stream-types";
import { terminalOutputText, terminalRecord } from "./terminal-output";

export default function ShellTerminal({ tool, command }: { tool: StreamToolCall; command: string }) {
  const { t } = useTranslation("chat");
  const viewport = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [copied, setCopied] = useState(false);
  const result = terminalRecord(tool.result);
  const args = terminalRecord(tool.arguments);
  const output = terminalOutputText(tool.output)
    || [result.stdout, result.stderr, result.error, result.output].map(terminalOutputText).filter(Boolean).join("\n")
    || (!Object.keys(result).length ? terminalOutputText(tool.result) : "");
  // Render terminal text safely; escape sequences must never become HTML.
  const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
  const running = tool.status === "calling" || tool.status === "streaming";
  const failed = tool.status === "error" || Boolean(result.error && !result.command) || (typeof result.exit_code === "number" && result.exit_code < 0);
  const cwd = typeof args?.cwd === "string" ? args.cwd : typeof result.cwd === "string" && result.cwd !== "." ? result.cwd : "/workspace";

  useEffect(() => {
    if (follow.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [text, command]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(timer); }, [copied]);

  return <div data-shell-terminal className="my-3 min-w-0 overflow-hidden rounded-xl border border-border/60 bg-[#08090c] text-zinc-200 animate-in fade-in duration-200 motion-reduce:animate-none">
    <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2 text-[11px]">
      <LuTerminal className="h-3.5 w-3.5 shrink-0 text-emerald-400" /><span className="font-medium">{t("terminal.title")}</span><span className="min-w-0 flex-1 truncate font-mono text-zinc-500" title={cwd}>{cwd}</span>
      <span className={running ? "flex items-center gap-1.5 text-emerald-400" : failed ? "text-red-400" : "text-zinc-500"} role="status">{running && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse motion-reduce:animate-none" />}{running ? t("terminal.running") : typeof result.exit_code === "number" ? t("terminal.exitCode", { code: result.exit_code }) : failed ? t("terminal.failed") : t("terminal.done")}</span>
      <button type="button" aria-label={t("terminal.copyOutput")} className="ml-1 rounded p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => { void navigator.clipboard.writeText(text ? `$ ${command}\n${text}` : `$ ${command}`).then(() => setCopied(true)).catch(() => {}); }}>{copied ? <LuCheck className="h-3.5 w-3.5" /> : <LuCopy className="h-3.5 w-3.5" />}</button>
    </div>
    <div ref={viewport} className="max-h-[300px] min-h-[90px] overflow-auto p-3 font-mono text-[12px] leading-[1.65] [scrollbar-gutter:stable]" onScroll={event => { const element = event.currentTarget; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32; }}>
      <pre className="whitespace-pre-wrap break-words"><span className="select-none text-emerald-400">$ </span>{command}{running && !text && <span aria-hidden="true" className="ml-0.5 inline-block h-3.5 w-1.5 bg-zinc-300 align-middle animate-pulse motion-reduce:animate-none" />}</pre>
      {text ? <pre className="mt-2 whitespace-pre-wrap break-words text-zinc-300" aria-label={t("terminal.outputAriaLabel")}>{text}{running && <span aria-hidden="true" className="ml-0.5 inline-block h-3.5 w-1.5 bg-zinc-300 align-middle animate-pulse motion-reduce:animate-none" />}</pre> : null}
      {!running && !text && <p className="mt-2 text-zinc-600">{t("terminal.noOutput")}</p>}
    </div>
  </div>;
}
