"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCircleAlert, LuCircleDot, LuServer } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toaster } from "@/components/ui/toaster";
import { IssueLabelChip, IssueMarkdown, PRIORITY_STYLE } from "@/components/issues/issue-ui";
import { createIssue, ISSUE_PRIORITIES, issuesError, type Issue, type IssuePriority } from "@/lib/issues-api";
import { cn } from "@/lib/utils";

const MAX_LABELS = 20;

interface CreateIssueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
  environmentName: string;
  onCreated: (issue: Issue) => void;
}

function PriorityOption({ priority, label }: { priority: IssuePriority; label: string }) {
  const { icon: Icon, className } = PRIORITY_STYLE[priority];
  return (
    <span className="flex items-center gap-2">
      <Icon aria-hidden className={cn("h-3.5 w-3.5 shrink-0", className)} />
      {label}
    </span>
  );
}

export function CreateIssueDialog({ open, onOpenChange, environmentId, environmentName, onCreated }: CreateIssueDialogProps) {
  const { t } = useTranslation("git");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState(false);
  const [priority, setPriority] = useState<IssuePriority>("none");
  const [labels, setLabels] = useState<string[]>([]);
  const [labelDraft, setLabelDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // Reset when (re)opening so the fields don't visibly clear during the closing animation.
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setBody("");
    setPreview(false);
    setPriority("none");
    setLabels([]);
    setLabelDraft("");
    setError(null);
    setBusy(false);
  }, [open]);

  const commitLabels = (raw: string) => {
    const names = raw
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    if (names.length === 0) return;
    setLabels((current) => {
      const next = [...current];
      for (const name of names) {
        if (next.length >= MAX_LABELS) break;
        if (!next.some((existing) => existing.toLowerCase() === name.toLowerCase())) next.push(name);
      }
      return next;
    });
  };

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (busy || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const pending = labelDraft.trim();
      const allLabels = pending && !labels.some((l) => l.toLowerCase() === pending.toLowerCase()) ? [...labels, pending] : labels;
      const issue = await createIssue(environmentId, {
        title: title.trim(),
        body,
        priority,
        labels: allLabels.map((name) => ({ name, color: "" })),
      });
      toaster.create({ title: t("issues.created", { number: issue.number }), type: "success" });
      onOpenChange(false);
      onCreated(issue);
    } catch (err) {
      setError(issuesError(err, t("issues.createFailed")));
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent
        hideClose={busy}
        className="max-h-[90dvh] w-[calc(100%-2rem)] max-w-xl gap-0 overflow-y-auto rounded-2xl p-0"
        onOpenAutoFocus={(event) => {
          // Land on the title, not the close button.
          event.preventDefault();
          formRef.current?.querySelector<HTMLInputElement>("#issue-title")?.focus();
        }}
      >
        <DialogHeader className="flex-row items-center gap-3 space-y-0 border-b border-border/70 px-5 py-4 text-left">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-500">
            <LuCircleDot aria-hidden className="h-4 w-4" />
          </span>
          <div className="min-w-0 pr-6">
            <DialogTitle className="text-base font-semibold leading-tight">{t("issues.newTitle")}</DialogTitle>
            <DialogDescription className="mt-1 flex items-center gap-1.5 text-xs">
              <LuServer aria-hidden className="h-3 w-3 shrink-0" />
              <span className="truncate">{t("issues.newDesc", { environment: environmentName })}</span>
            </DialogDescription>
          </div>
        </DialogHeader>

        <form
          ref={formRef}
          onSubmit={submit}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
        >
          <div className="space-y-5 px-5 py-5">
            <div className="space-y-1.5">
              <label htmlFor="issue-title" className="sr-only">
                {t("issues.titleLabel")}
              </label>
              <input
                id="issue-title"
                value={title}
                maxLength={300}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t("issues.titlePlaceholder")}
                className="h-11 w-full rounded-xl border border-input bg-background px-3.5 text-[15px] font-medium outline-none transition-colors placeholder:font-normal placeholder:text-muted-foreground focus-visible:border-indigo-500/60 focus-visible:ring-4 focus-visible:ring-indigo-500/10"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label htmlFor="issue-body" className="text-xs font-medium text-muted-foreground">
                  {t("issues.descriptionLabel")}
                </label>
                <div role="group" aria-label={t("issues.descriptionLabel")} className="inline-flex gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5">
                  {([false, true] as const).map((isPreview) => (
                    <button
                      key={String(isPreview)}
                      type="button"
                      aria-pressed={preview === isPreview}
                      onClick={() => setPreview(isPreview)}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                        preview === isPreview ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {isPreview ? t("issues.preview") : t("issues.write")}
                    </button>
                  ))}
                </div>
              </div>
              {preview ? (
                <div className="h-[11rem] overflow-y-auto rounded-xl border border-input bg-background px-3.5 py-3">
                  {body.trim() ? (
                    <IssueMarkdown>{body}</IssueMarkdown>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t("issues.nothingToPreview")}</p>
                  )}
                </div>
              ) : (
                <Textarea
                  id="issue-body"
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  placeholder={t("issues.descriptionPlaceholder")}
                  className="h-[11rem] resize-none rounded-xl px-3.5 py-3 leading-relaxed focus-visible:border-indigo-500/60 focus-visible:ring-4 focus-visible:ring-indigo-500/10 focus-visible:ring-offset-0"
                />
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">{t("issues.priorityLabel")}</span>
                <Select value={priority} onValueChange={(value) => setPriority(value as IssuePriority)}>
                  <SelectTrigger aria-label={t("issues.priorityLabel")} className="h-10 rounded-xl">
                    <SelectValue>
                      <PriorityOption priority={priority} label={t(`issues.priorityNames.${priority}`)} />
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {ISSUE_PRIORITIES.map((value) => (
                      <SelectItem key={value} value={value}>
                        <PriorityOption priority={value} label={t(`issues.priorityNames.${value}`)} />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="issue-labels" className="text-xs font-medium text-muted-foreground">
                  {t("issues.labelsLabel")}
                </label>
                <div
                  onClick={() => formRef.current?.querySelector<HTMLInputElement>("#issue-labels")?.focus()}
                  className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-xl border border-input bg-background px-2.5 py-1.5 transition-colors focus-within:border-indigo-500/60 focus-within:ring-4 focus-within:ring-indigo-500/10"
                >
                  {labels.map((name) => (
                    <IssueLabelChip
                      key={name}
                      label={{ name, color: "" }}
                      onRemove={() => setLabels((current) => current.filter((item) => item !== name))}
                    />
                  ))}
                  <input
                    id="issue-labels"
                    value={labelDraft}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value.includes(",")) {
                        commitLabels(value);
                        setLabelDraft("");
                      } else {
                        setLabelDraft(value);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && labelDraft.trim()) {
                        event.preventDefault();
                        event.stopPropagation();
                        commitLabels(labelDraft);
                        setLabelDraft("");
                      } else if (event.key === "Backspace" && !labelDraft && labels.length > 0) {
                        setLabels((current) => current.slice(0, -1));
                      }
                    }}
                    onBlur={() => {
                      if (labelDraft.trim()) {
                        commitLabels(labelDraft);
                        setLabelDraft("");
                      }
                    }}
                    placeholder={labels.length === 0 ? t("issues.labelsPlaceholder") : ""}
                    className="h-6 min-w-24 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
                  />
                </div>
              </div>
            </div>

            {error && (
              <p role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
                <LuCircleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {error}
              </p>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border/70 bg-muted/15 px-5 py-3">
            <span className="hidden text-[11px] text-muted-foreground sm:block">{t("issues.createShortcut")}</span>
            <div className="ml-auto flex items-center gap-2">
              <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
                {t("issues.cancel")}
              </Button>
              <Button type="submit" loading={busy} disabled={!title.trim()}>
                {busy ? t("issues.creating") : t("issues.create")}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
