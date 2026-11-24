"use client";

import React, { useState, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  LuArrowRight,
  LuCheck,
  LuPenLine,
  LuLoaderCircle,
} from "react-icons/lu";
import useChatStore from "@/stores/chat";
import { toaster } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";

export interface OptionItem {
  id?: string;
  label?: string;
  text?: string;
  value?: string;
}

export interface QuestionItem {
  id?: string;
  title?: string;
  question?: string;
  type?: "single" | "multiple" | "radio" | "checkbox" | "checklist";
  options?: (string | OptionItem)[];
  allowCustom?: boolean;
  allow_custom?: boolean;
  customPlaceholder?: string;
  custom_placeholder?: string;
  required?: boolean;
}

export interface InteractiveChoicePayload {
  title?: string;
  questions?: QuestionItem[];
  // Shorthand for single question format
  question?: string;
  type?: "single" | "multiple" | "radio" | "checkbox" | "checklist";
  options?: (string | OptionItem)[];
  allowCustom?: boolean;
  allow_custom?: boolean;
  buttonText?: string;
  button_text?: string;
  submit_button_text?: string;
  submitText?: string;
}

interface NormalizedQuestion {
  id: string;
  title: string;
  isMultiple: boolean;
  options: string[];
  allowCustom: boolean;
  customPlaceholder: string;
}

interface InteractiveChoiceCardProps {
  content: string;
}

function parseChoicePayload(raw: string): InteractiveChoicePayload | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Strip possible markdown code-fence wrapper if nested
  let clean = trimmed;
  if (clean.startsWith("```")) {
    clean = clean.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n?```$/, "");
  }

  try {
    return JSON.parse(clean) as InteractiveChoicePayload;
  } catch {
    // If invalid JSON (e.g. streaming in progress or slight syntax error), try lax parsing
    try {
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) {
        return JSON.parse(match[0]) as InteractiveChoicePayload;
      }
    } catch {
      return null;
    }
    return null;
  }
}

export default function InteractiveChoiceCard({ content }: InteractiveChoiceCardProps) {
  const { t } = useTranslation("chat");
  const isChatStreaming = useChatStore((state) => state.isStreaming);
  const sendMessage = useChatStore((state) => state.sendMessage);

  const payload = useMemo(() => parseChoicePayload(content), [content]);

  // Normalize questions array
  const questions: NormalizedQuestion[] = useMemo(() => {
    if (!payload) return [];

    const rawQuestions: QuestionItem[] = Array.isArray(payload.questions)
      ? payload.questions
      : payload.question || payload.options
      ? [
          {
            id: "q_0",
            title: payload.question || payload.title || t("interactiveChoice.defaultTitle"),
            type: payload.type,
            options: payload.options,
            allowCustom: payload.allowCustom ?? payload.allow_custom,
          },
        ]
      : [];

    return rawQuestions.map((q, idx) => {
      const rawOptions = Array.isArray(q.options) ? q.options : [];
      const options = rawOptions
        .map((opt) => {
          if (typeof opt === "string") return opt.trim();
          if (typeof opt === "object" && opt) {
            return (opt.label || opt.text || opt.value || "").trim();
          }
          return "";
        })
        .filter(Boolean);

      const qType = (q.type || "single").toLowerCase();
      const isMultiple =
        qType === "multiple" || qType === "checkbox" || qType === "checklist";

      const title = (q.title || q.question || t("interactiveChoice.questionNumber", { number: idx + 1 })).trim();
      const allowCustom = Boolean(q.allowCustom ?? q.allow_custom ?? false);
      const customPlaceholder =
        q.customPlaceholder ||
        q.custom_placeholder ||
        t("interactiveChoice.customPlaceholder");

      return {
        id: q.id || `q_${idx}`,
        title,
        isMultiple,
        options,
        allowCustom,
        customPlaceholder,
      };
    });
  }, [payload, t]);

  const buttonLabel = useMemo(() => {
    if (!payload) return t("interactiveChoice.continueButton");
    return (
      payload.buttonText ||
      payload.button_text ||
      payload.submit_button_text ||
      payload.submitText ||
      t("interactiveChoice.continueButton")
    );
  }, [payload, t]);

  // Selections state: questionId -> array of selected options
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  // Custom text per question
  const [customText, setCustomText] = useState<Record<string, string>>({});
  // Whether custom input is toggled on per question
  const [customActive, setCustomActive] = useState<Record<string, boolean>>({});
  // Submitted state
  const [submitted, setSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Toggle regular option
  const handleToggleOption = useCallback(
    (q: NormalizedQuestion, opt: string) => {
      if (submitted) return;

      setSelected((prev) => {
        const current = prev[q.id] || [];
        if (q.isMultiple) {
          // Checkbox toggle
          if (current.includes(opt)) {
            return { ...prev, [q.id]: current.filter((item) => item !== opt) };
          } else {
            return { ...prev, [q.id]: [...current, opt] };
          }
        } else {
          // Radio toggle: deactivates custom option if selected
          setCustomActive((cPrev) => ({ ...cPrev, [q.id]: false }));
          return { ...prev, [q.id]: [opt] };
        }
      });
    },
    [submitted]
  );

  // Toggle custom "Diğer" option
  const handleToggleCustom = useCallback(
    (q: NormalizedQuestion) => {
      if (submitted) return;

      setCustomActive((cPrev) => {
        const nextActive = !cPrev[q.id];
        if (nextActive && !q.isMultiple) {
          // If single select, uncheck standard options when custom is activated
          setSelected((prev) => ({ ...prev, [q.id]: [] }));
        }
        return { ...cPrev, [q.id]: nextActive };
      });
    },
    [submitted]
  );

  // Submit selections
  const handleSubmit = useCallback(async () => {
    if (submitted || isSubmitting || isChatStreaming) return;

    // Collect all answers
    const answers: { question: string; answers: string[] }[] = [];

    for (const q of questions) {
      const qSelected = [...(selected[q.id] || [])];
      if (customActive[q.id] && customText[q.id]?.trim()) {
        qSelected.push(t("interactiveChoice.otherPrefix", { text: customText[q.id].trim() }));
      }

      if (qSelected.length > 0) {
        answers.push({
          question: q.title,
          answers: qSelected,
        });
      }
    }

    if (answers.length === 0) {
      toaster.create({
        title: t("interactiveChoice.selectAtLeastOne"),
        type: "info",
      });
      return;
    }

    // Format human-friendly message for chat
    let messageText = "";
    if (answers.length === 1 && questions.length === 1) {
      messageText = t("interactiveChoice.singleSelectionMessage", {
        question: answers[0].question,
        answers: answers[0].answers.join(", "),
      });
    } else {
      messageText =
        t("interactiveChoice.multipleSelectionHeader") +
        answers
          .map((a) => `• ${a.question}: ${a.answers.join(", ")}`)
          .join("\n");
    }

    try {
      setIsSubmitting(true);
      await sendMessage(messageText);
      setSubmitted(true);
      toaster.create({
        title: t("interactiveChoice.submittedToast"),
        type: "success",
      });
    } catch {
      toaster.create({
        title: t("interactiveChoice.submitFailed"),
        description: t("interactiveChoice.tryAgain"),
        type: "error",
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [
    submitted,
    isSubmitting,
    isChatStreaming,
    questions,
    selected,
    customActive,
    customText,
    sendMessage,
    t,
  ]);

  // If payload could not be parsed yet (e.g. still streaming code block)
  if (!payload || questions.length === 0) {
    return (
      <div className="my-3 p-4 rounded-2xl border border-zinc-200/60 dark:border-zinc-800/80 bg-zinc-50/50 dark:bg-zinc-900/40 backdrop-blur-sm animate-pulse space-y-3 max-w-full">
        <div className="h-4 w-48 bg-zinc-200 dark:bg-zinc-800 rounded" />
        <div className="space-y-2">
          <div className="h-3 w-36 bg-zinc-200/70 dark:bg-zinc-800/70 rounded" />
          <div className="h-3 w-40 bg-zinc-200/70 dark:bg-zinc-800/70 rounded" />
        </div>
        <div className="h-9 w-full bg-zinc-200/50 dark:bg-zinc-800/50 rounded-full" />
      </div>
    );
  }

  const hasAnySelection =
    Object.values(selected).some((arr) => arr.length > 0) ||
    Object.entries(customActive).some(
      ([qId, active]) => active && Boolean(customText[qId]?.trim())
    );

  return (
    <div
      className={cn(
        "my-4 p-4 sm:p-5 rounded-2xl border transition-all max-w-full",
        "bg-white/80 dark:bg-zinc-950/70 backdrop-blur-md shadow-sm",
        submitted
          ? "border-emerald-500/30 bg-emerald-500/[0.02]"
          : "border-zinc-200 dark:border-zinc-800/90"
      )}
    >
      {/* Optional Card Title */}
      {payload.title && questions.length > 1 && (
        <div className="mb-4 pb-2 border-b border-zinc-200/60 dark:border-zinc-800/60 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-foreground tracking-tight">
            {payload.title}
          </h4>
          {submitted && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
              <LuCheck className="h-3 w-3" /> {t("interactiveChoice.answered")}
            </span>
          )}
        </div>
      )}

      {/* Question Groups */}
      <div className="space-y-6">
        {questions.map((q) => {
          const currentSelected = selected[q.id] || [];
          const isCustomOn = Boolean(customActive[q.id]);

          return (
            <div key={q.id} className="space-y-2.5">
              {/* Question Header */}
              <div className="flex items-center justify-between gap-2">
                <h5 className="text-sm sm:text-[15px] font-semibold text-foreground tracking-tight">
                  {q.title}
                </h5>
                <span className="text-[11px] text-muted-foreground font-mono">
                  {q.isMultiple ? t("interactiveChoice.multipleChoice") : t("interactiveChoice.singleChoice")}
                </span>
              </div>

              {/* Options List */}
              <div className="space-y-1.5 pt-0.5">
                {q.options.map((opt) => {
                  const isChecked = currentSelected.includes(opt);

                  return (
                    <button
                      key={opt}
                      type="button"
                      disabled={submitted}
                      onClick={() => handleToggleOption(q, opt)}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-all",
                        "hover:bg-zinc-100 dark:hover:bg-white/[0.04]",
                        isChecked &&
                          "bg-zinc-100/80 dark:bg-white/[0.06] text-foreground font-medium",
                        !isChecked && "text-muted-foreground hover:text-foreground",
                        submitted && "cursor-default opacity-85"
                      )}
                    >
                      {/* Indicator Icon */}
                      {q.isMultiple ? (
                        // Checkbox style
                        <div
                          className={cn(
                            "h-4 w-4 shrink-0 rounded-md border flex items-center justify-center transition-all",
                            isChecked
                              ? "bg-foreground text-background border-foreground shadow-xs"
                              : "border-zinc-400/80 dark:border-zinc-600 bg-transparent"
                          )}
                        >
                          {isChecked && <LuCheck className="h-3 w-3 stroke-[3]" />}
                        </div>
                      ) : (
                        // Radio button style (matching screenshot)
                        <div
                          className={cn(
                            "h-4 w-4 shrink-0 rounded-full border flex items-center justify-center transition-all",
                            isChecked
                              ? "border-foreground bg-transparent"
                              : "border-zinc-400/80 dark:border-zinc-600 bg-transparent"
                          )}
                        >
                          {isChecked && (
                            <div className="h-2 w-2 rounded-full bg-foreground" />
                          )}
                        </div>
                      )}

                      {/* Option Label */}
                      <span className="text-sm leading-snug flex-1 select-none">
                        {opt}
                      </span>
                    </button>
                  );
                })}

                {/* Custom Option ("Diğer") if allowed */}
                {q.allowCustom && (
                  <div className="pt-0.5 space-y-2">
                    <button
                      type="button"
                      disabled={submitted}
                      onClick={() => handleToggleCustom(q)}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-all",
                        "hover:bg-zinc-100 dark:hover:bg-white/[0.04]",
                        isCustomOn &&
                          "bg-zinc-100/80 dark:bg-white/[0.06] text-foreground font-medium",
                        !isCustomOn && "text-muted-foreground hover:text-foreground",
                        submitted && "cursor-default opacity-85"
                      )}
                    >
                      {q.isMultiple ? (
                        <div
                          className={cn(
                            "h-4 w-4 shrink-0 rounded-md border flex items-center justify-center transition-all",
                            isCustomOn
                              ? "bg-foreground text-background border-foreground shadow-xs"
                              : "border-zinc-400/80 dark:border-zinc-600 bg-transparent"
                          )}
                        >
                          {isCustomOn && <LuCheck className="h-3 w-3 stroke-[3]" />}
                        </div>
                      ) : (
                        <div
                          className={cn(
                            "h-4 w-4 shrink-0 rounded-full border flex items-center justify-center transition-all",
                            isCustomOn
                              ? "border-foreground bg-transparent"
                              : "border-zinc-400/80 dark:border-zinc-600 bg-transparent"
                          )}
                        >
                          {isCustomOn && (
                            <div className="h-2 w-2 rounded-full bg-foreground" />
                          )}
                        </div>
                      )}

                      <span className="text-sm leading-snug flex-1 select-none flex items-center gap-1.5">
                        <LuPenLine className="h-3.5 w-3.5 opacity-70" />
                        <span>{t("interactiveChoice.otherCustomOption")}</span>
                      </span>
                    </button>

                    {/* Inline Input when Custom is selected */}
                    {isCustomOn && (
                      <div className="pl-7 pr-1">
                        <input
                          type="text"
                          disabled={submitted}
                          value={customText[q.id] || ""}
                          placeholder={q.customPlaceholder}
                          onChange={(e) =>
                            setCustomText((prev) => ({
                              ...prev,
                              [q.id]: e.target.value,
                            }))
                          }
                          className={cn(
                            "w-full px-3 py-2 text-xs rounded-xl border transition-colors outline-hidden",
                            "bg-zinc-50 dark:bg-zinc-900/90 border-zinc-200 dark:border-zinc-800",
                            "focus:border-foreground/40 text-foreground placeholder:text-muted-foreground/60",
                            submitted && "opacity-75 cursor-default"
                          )}
                          autoFocus={!submitted}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Submit Action Button (Pill button like screenshot) */}
      <div className="mt-6 pt-2">
        <button
          type="button"
          disabled={submitted || isSubmitting || !hasAnySelection || isChatStreaming}
          onClick={handleSubmit}
          className={cn(
            "w-full py-2.5 px-4 rounded-full font-medium text-sm transition-all shadow-sm",
            "flex items-center justify-center gap-2",
            submitted
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 cursor-default"
              : "bg-foreground text-background hover:opacity-90 active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:opacity-40"
          )}
        >
          {isSubmitting ? (
            <>
              <LuLoaderCircle className="h-4 w-4 animate-spin" />
              <span>{t("interactiveChoice.submitting")}</span>
            </>
          ) : submitted ? (
            <>
              <LuCheck className="h-4 w-4" />
              <span>{t("interactiveChoice.submittedButton")}</span>
            </>
          ) : (
            <>
              <span>{buttonLabel}</span>
              <LuArrowRight className="h-4 w-4" />
            </>
          )}
        </button>
      </div>
    </div>
  );
}
