"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuSparkles } from "react-icons/lu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import useLlmSetupStore from "@/stores/llm-setup";

const SAME_AS_CHAT = "__same_as_chat__";

/** Lets admins pick the cheap model the workspace's own key uses for titles, summaries and memory. */
export default function AuxiliaryModelSetting({ workspaceUuid }: { workspaceUuid: string }) {
  const { t } = useTranslation("settings");
  const status = useLlmSetupStore((s) => (s.workspaceUuid === workspaceUuid ? s.status : null));
  const fetchStatus = useLlmSetupStore((s) => s.fetchStatus);
  const setAuxiliaryModel = useLlmSetupStore((s) => s.setAuxiliaryModel);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void fetchStatus(workspaceUuid, { force: true });
  }, [workspaceUuid, fetchStatus]);

  if (!status || status.usable_models.length === 0) return null;

  const current = status.auxiliary_model?.name ?? SAME_AS_CHAT;
  const onChange = async (value: string) => {
    setSaving(true);
    setError("");
    try {
      await setAuxiliaryModel(workspaceUuid, value === SAME_AS_CHAT ? null : value);
    } catch (err: any) {
      setError(err?.response?.data?.error || t("providerKeys.auxiliary.error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 rounded-xl border border-border/70 bg-muted/10 p-4">
      <div className="flex items-start gap-2">
        <LuSparkles className="mt-0.5 h-4 w-4 shrink-0 text-indigo-400" />
        <div>
          <p className="text-sm font-semibold">{t("providerKeys.auxiliary.title")}</p>
          <p className="text-xs text-muted-foreground">{t("providerKeys.auxiliary.description")}</p>
        </div>
      </div>
      <Select value={current} onValueChange={(value) => void onChange(value)} disabled={saving || !status.can_manage}>
        <SelectTrigger className="w-full text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={SAME_AS_CHAT} className="text-xs">
            {t("providerKeys.auxiliary.sameAsChat")}
          </SelectItem>
          {status.auxiliary_model && !status.usable_models.some((m) => m.name === status.auxiliary_model?.name) && (
            <SelectItem value={status.auxiliary_model.name} className="text-xs">
              {status.auxiliary_model.display_name}
            </SelectItem>
          )}
          {status.usable_models.map((model) => (
            <SelectItem key={model.name} value={model.name} className="text-xs">
              {model.display_name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {status.auxiliary_model && !status.auxiliary_model.usable && (
        <p className="text-xs text-amber-600 dark:text-amber-400">{t("providerKeys.auxiliary.unusable")}</p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
