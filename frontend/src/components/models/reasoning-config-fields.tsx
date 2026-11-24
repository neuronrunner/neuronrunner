"use client";

import React from "react";
import { useTranslation } from "react-i18next";
import {
  CANONICAL_EFFORT_ORDER,
  normalizeEditableModeChange,
  toggleEffortTierSelection,
  type EditableReasoningMode,
  type ReasoningTier,
} from "@/lib/reasoning";

interface ReasoningConfigFieldsProps {
  reasoningMode: EditableReasoningMode;
  supportedTiers: ReasoningTier[];
  defaultTier: ReasoningTier;
  onChange: (next: {
    mode: EditableReasoningMode;
    tiers: ReasoningTier[];
    defaultTier: ReasoningTier;
  }) => void;
  disabled?: boolean;
}

const MODE_OPTIONS = [
  { value: "effort", labelKey: "composer.reasoningConfig.modeEffort" },
  { value: "toggle", labelKey: "composer.reasoningConfig.modeToggle" },
  { value: "fixed", labelKey: "composer.reasoningConfig.modeFixed" },
] as const;

export function ReasoningConfigFields({
  reasoningMode,
  supportedTiers,
  defaultTier,
  onChange,
  disabled = false,
}: ReasoningConfigFieldsProps) {
  const { t } = useTranslation("chat");

  const handleModeChange = (nextMode: EditableReasoningMode) => {
    if (disabled || nextMode === reasoningMode) return;
    onChange(normalizeEditableModeChange(nextMode, supportedTiers, defaultTier));
  };

  const handleTierToggle = (tier: ReasoningTier) => {
    if (disabled || reasoningMode !== "effort") return;
    const updated = toggleEffortTierSelection(supportedTiers, tier, defaultTier);
    onChange({ mode: "effort", tiers: updated.tiers, defaultTier: updated.defaultTier });
  };

  const selectableDefaultTiers: ReasoningTier[] =
    reasoningMode === "toggle"
      ? ["on", "none"]
      : reasoningMode === "fixed"
        ? ["on"]
        : supportedTiers;

  const tierLabel = (tier: ReasoningTier) =>
    t(`composer.reasoning.${tier}`, {
      defaultValue: tier === "none" ? "Off" : tier === "on" ? "On" : tier,
    });

  return (
    <div className="space-y-3 rounded-lg border border-purple-500/25 bg-purple-500/[0.04] p-3">
      <div>
        <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
          {t("composer.reasoningConfig.modeLabel")}
        </label>
        <div className="grid grid-cols-3 gap-1.5">
          {MODE_OPTIONS.map((opt) => {
            const active = reasoningMode === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                disabled={disabled}
                onClick={() => handleModeChange(opt.value)}
                className={`px-2 py-1.5 rounded-md text-[11px] font-medium border transition-colors cursor-pointer disabled:opacity-50 ${
                  active
                    ? "border-purple-500 bg-purple-500 text-white"
                    : "border-slate-200 dark:border-white/10 bg-white/70 dark:bg-white/5 text-slate-700 dark:text-slate-300 hover:border-purple-400/60"
                }`}
              >
                {t(opt.labelKey)}
              </button>
            );
          })}
        </div>
      </div>

      {reasoningMode === "effort" && (
        <div>
          <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
            {t("composer.reasoningConfig.tiersLabel")}
          </label>
          <div className="flex flex-wrap gap-1.5">
            {CANONICAL_EFFORT_ORDER.map((tier) => {
              const selected = supportedTiers.includes(tier);
              const isOnlyActiveEffort =
                selected &&
                tier !== "none" &&
                supportedTiers.filter((x) => x !== "none").length <= 1;
              return (
                <button
                  key={tier}
                  type="button"
                  disabled={disabled || isOnlyActiveEffort}
                  onClick={() => handleTierToggle(tier)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors cursor-pointer disabled:cursor-not-allowed ${
                    selected
                      ? "border-purple-500 bg-purple-500/15 text-purple-700 dark:text-purple-200"
                      : "border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 hover:border-slate-300 dark:hover:border-white/20"
                  }`}
                >
                  {tierLabel(tier)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {reasoningMode === "toggle" && (
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          {t("composer.reasoningConfig.toggleNote")}
        </p>
      )}

      {reasoningMode === "fixed" ? (
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          {t("composer.reasoningConfig.fixedNote")}
        </p>
      ) : (
        <div>
          <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
            {t("composer.reasoningConfig.defaultTierLabel")}
          </label>
          <select
            disabled={disabled}
            value={selectableDefaultTiers.includes(defaultTier) ? defaultTier : selectableDefaultTiers[0]}
            onChange={(e) =>
              onChange({
                mode: reasoningMode,
                tiers: selectableDefaultTiers,
                defaultTier: e.target.value as ReasoningTier,
              })
            }
            className="w-full h-8 px-2.5 rounded-lg text-xs bg-white dark:bg-[#121218] border border-slate-200 dark:border-white/10 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-purple-500 cursor-pointer disabled:opacity-50"
          >
            {selectableDefaultTiers.map((tier) => (
              <option key={tier} value={tier}>
                {tierLabel(tier)}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
