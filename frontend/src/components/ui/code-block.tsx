"use client";

import React, { useState } from "react";
import { LuCopy, LuCheck } from "react-icons/lu";
import { cn } from "@/lib/utils";

interface CodeBlockProps {
  code: string;
  language?: string;
  className?: string;
}

export const CodeBlock: React.FC<CodeBlockProps> = ({ code, language, className }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={cn("rounded-xl border border-border/70 dark:border-white/10 bg-card dark:bg-[#09090f] overflow-hidden text-xs max-w-full shadow-xs", className)}>
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/60 dark:border-white/10 bg-muted/40 dark:bg-white/[0.03]">
        <span className="text-[11px] font-mono text-muted-foreground uppercase font-medium">
          {language || "code"}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted dark:hover:bg-white/10 transition-colors"
        >
          {copied ? <LuCheck className="h-3.5 w-3.5 text-emerald-500 dark:text-emerald-400" /> : <LuCopy className="h-3.5 w-3.5" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <div className="p-4 overflow-x-auto">
        <pre className="font-mono text-sm leading-relaxed text-foreground/90 whitespace-pre">
          <code>{code}</code>
        </pre>
      </div>
    </div>
  );
};
