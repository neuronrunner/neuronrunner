"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { importIssues, issuesError, type ImportIssuesResult, type ImportProvider } from "@/lib/issues-api";

type ImportState = "open" | "closed" | "all";

export function detectImportProvider(repoUrl?: string | null): ImportProvider {
  return /gitlab/i.test(repoUrl || "") ? "gitlab" : "github";
}

interface ImportIssuesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
  environmentName: string;
  repoUrl?: string | null;
  repoName?: string | null;
  onImported: (result: ImportIssuesResult) => void;
}

export function ImportIssuesDialog({
  open,
  onOpenChange,
  environmentId,
  environmentName,
  repoUrl,
  repoName,
  onImported,
}: ImportIssuesDialogProps) {
  const { t } = useTranslation("git");
  const [provider, setProvider] = useState<ImportProvider>(detectImportProvider(repoUrl));
  const [state, setState] = useState<ImportState>("open");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportIssuesResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setProvider(detectImportProvider(repoUrl));
    setState("open");
    setBusy(false);
    setError(null);
    setResult(null);
  }, [open, repoUrl, environmentId]);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const imported = await importIssues(environmentId, { provider, state });
      setResult(imported);
      onImported(imported);
    } catch (err) {
      setError(issuesError(err, t("issues.importFailed")));
    } finally {
      setBusy(false);
    }
  };

  const providerName = provider === "github" ? "GitHub" : "GitLab";

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-md">
        <DialogHeader className="text-left">
          <DialogTitle>{t("issues.importTitle")}</DialogTitle>
          <DialogDescription>
            {t("issues.importDesc", { environment: environmentName, repository: repoName || providerName })}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div role="status" className="space-y-1 rounded-lg border border-border bg-muted/20 p-4 text-sm">
            <p className="font-medium">{t("issues.importDone", { count: result.imported, source: providerName })}</p>
            {result.skipped > 0 && (
              <p className="text-xs text-muted-foreground">{t("issues.importSkipped", { count: result.skipped })}</p>
            )}
            {result.truncated && <p className="text-xs text-muted-foreground">{t("issues.importTruncated")}</p>}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <span className="text-xs font-medium">{t("issues.importSource")}</span>
                <Select value={provider} onValueChange={(value) => setProvider(value as ImportProvider)}>
                  <SelectTrigger aria-label={t("issues.importSource")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="github">GitHub</SelectItem>
                    <SelectItem value="gitlab">GitLab</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <span className="text-xs font-medium">{t("issues.importWhich")}</span>
                <Select value={state} onValueChange={(value) => setState(value as ImportState)}>
                  <SelectTrigger aria-label={t("issues.importWhich")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">{t("issues.importOpen")}</SelectItem>
                    <SelectItem value="closed">{t("issues.importClosed")}</SelectItem>
                    <SelectItem value="all">{t("issues.importAll")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{t("issues.importNote")}</p>
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {result ? (
            <Button onClick={() => onOpenChange(false)}>{t("issues.done")}</Button>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                {t("issues.cancel")}
              </Button>
              <Button loading={busy} onClick={() => void run()}>
                {busy ? t("issues.importing") : t("issues.importAction", { source: providerName })}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
