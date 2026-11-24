"use client";

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCopy, LuCheck, LuTerminal, LuCode } from "react-icons/lu";
import { cn } from "@/lib/utils";
export interface CodeSnippetTab {
  label: string;
  language: string;
  code: string;
}

interface CodeTabsProps {
  defaultLanguage?: string;
  defaultCode?: string;
  tabs?: CodeSnippetTab[];
  title?: string;
  className?: string;
}

export const CodeTabs: React.FC<CodeTabsProps> = ({
  defaultLanguage = "bash",
  defaultCode = "",
  tabs,
  title,
  className,
}) => {
  const { t } = useTranslation("docs");
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const [copied, setCopied] = useState(false);

  const hasTabs = tabs && tabs.length > 0;
  const currentLanguage = hasTabs ? tabs[activeTabIndex].language : defaultLanguage;
  const currentCode = hasTabs ? tabs[activeTabIndex].code : defaultCode;
  const currentLabel = hasTabs ? tabs[activeTabIndex].label : currentLanguage;

  const handleCopy = () => {
    navigator.clipboard.writeText(currentCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={cn(
        "group relative my-4 overflow-hidden rounded-xl border border-border/80 bg-[#09090f] shadow-lg shadow-black/20",
        className
      )}
    >
      {/* Top Header / Tab Bar */}
      <div className="flex items-center justify-between border-b border-white/10 bg-white/[0.03] px-3 py-1.5 backdrop-blur-xs">
        {/* Left: Tabs or Title */}
        <div className="flex items-center gap-1.5 overflow-x-auto">
          {hasTabs ? (
            tabs.map((tab, idx) => {
              const isActive = idx === activeTabIndex;
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setActiveTabIndex(idx)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-mono transition-all",
                    isActive
                      ? "bg-indigo-500/15 text-indigo-300 font-semibold shadow-xs"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-white/5"
                  )}
                >
                  {tab.language === "bash" || tab.language === "shell" ? (
                    <LuTerminal className="h-3 w-3 text-indigo-400" />
                  ) : (
                    <LuCode className="h-3 w-3 text-indigo-400" />
                  )}
                  <span>{tab.label}</span>
                </button>
              );
            })
          ) : (
            <div className="flex items-center gap-1.5 px-1 py-1 text-xs font-mono text-zinc-400">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-400/80 mr-1" />
              <span>{title || currentLabel}</span>
            </div>
          )}
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2">
          <span className="hidden sm:inline-block font-mono text-[10px] uppercase tracking-wider text-zinc-500">
            {currentLanguage}
          </span>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100"
            title={t("codeTabs.copySnippet")}
          >
            {copied ? (
              <>
                <LuCheck className="h-3.5 w-3.5 text-emerald-400" />
                <span className="text-emerald-400 font-medium">{t("codeTabs.copied")}</span>
              </>
            ) : (
              <>
                <LuCopy className="h-3.5 w-3.5" />
                <span>{t("codeTabs.copy")}</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Code Area */}
      <div className="relative overflow-x-auto p-4 font-mono text-xs leading-relaxed text-zinc-200 selection:bg-indigo-500/30 selection:text-white">
        <pre className="m-0">
          <code>{currentCode}</code>
        </pre>
      </div>
    </div>
  );
};
