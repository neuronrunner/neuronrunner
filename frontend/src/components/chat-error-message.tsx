"use client";

import { useTranslation } from "react-i18next";
import { LuTriangleAlert } from "react-icons/lu";

interface ChatErrorMessageProps {
  message: string;
}

export default function ChatErrorMessage({ message }: ChatErrorMessageProps) {
  const { t } = useTranslation(["chat", "common"]);

  return (
    <div className="flex items-start gap-3 p-3.5 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-sm">
      <LuTriangleAlert className="h-5 w-5 shrink-0 mt-0.5" />
      <div className="flex flex-col gap-1.5">
        <h5 className="font-semibold text-xs leading-none tracking-tight">{t("chat:error.requestFailed")}</h5>
        <div className="text-xs opacity-90 whitespace-pre-wrap leading-relaxed">
          {message}
        </div>
      </div>
    </div>
  );
}
