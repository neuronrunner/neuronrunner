"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { LuCheck, LuCircleAlert, LuLoaderCircle, LuX } from "react-icons/lu";

export interface FileOperation {
  kind: "upload" | "delete";
  status: "running" | "success" | "error";
  label: string;
  detail: string;
  paths: string[];
  progress?: number;
}

export default function FileOperationProgress({ operation, onDismiss }: { operation: FileOperation; onDismiss: () => void }) {
  const { t } = useTranslation("git");
  const reducedMotion = useReducedMotion();
  const running = operation.status === "running";
  const Icon = running ? LuLoaderCircle : operation.status === "error" ? LuCircleAlert : LuCheck;
  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.2 }} className="shrink-0 overflow-hidden border-t bg-muted/25" data-file-operation={operation.kind}>
      <div className="space-y-2.5 px-3 py-3">
        <div className="flex items-start gap-2" role="status" aria-live="polite" aria-atomic="true">
          <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${running ? "animate-spin motion-reduce:animate-none text-sky-500" : operation.status === "error" ? "text-destructive" : "text-emerald-500"}`} />
          <div className="min-w-0 flex-1"><p className="text-xs font-medium">{operation.label}</p><p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={operation.detail}>{operation.detail}</p></div>
          {!running && <button type="button" aria-label={t("fileOperation.dismissAriaLabel")} onClick={onDismiss} className="rounded p-0.5 text-muted-foreground hover:bg-muted"><LuX className="h-3.5 w-3.5" /></button>}
        </div>
        {running && <div role="progressbar" aria-label={operation.kind === "upload" ? t("fileOperation.uploadProgress") : t("fileOperation.deletionProgress")}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={operation.progress === undefined ? undefined : Math.round(operation.progress * 100)}
          className="relative h-1 overflow-hidden rounded-full bg-muted">
          {operation.progress === undefined ? <motion.div className="absolute h-full w-1/3 rounded-full bg-sky-500" initial={{ left: "-33%" }} animate={{ left: reducedMotion ? "33%" : "100%" }} transition={{ duration: 1.2, repeat: reducedMotion ? 0 : Infinity, ease: "linear" }} />
            : <motion.div className="h-full rounded-full bg-sky-500" initial={false} animate={{ width: `${Math.max(0, Math.min(1, operation.progress)) * 100}%` }} transition={{ duration: reducedMotion ? 0 : 0.15 }} />}
        </div>}
      </div>
    </motion.div>
  );
}
