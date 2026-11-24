"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuShieldCheck, LuShield, LuUser } from "react-icons/lu";
import { cn } from "@/lib/utils";
import type { WorkspaceRole } from "@/stores/workspaces";

export function WorkspaceAvatar({
  name,
  image,
  blurDataUrl,
  className,
}: {
  name: string;
  image?: string | null;
  blurDataUrl?: string | null;
  className?: string;
}) {
  const [hasError, setHasError] = useState(false);
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "W";

  useEffect(() => {
    setHasError(false);
  }, [image]);

  const showImage = !!image && !hasError;

  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-indigo-500/10 text-xs font-semibold tracking-wide text-indigo-600 dark:text-indigo-300",
        className
      )}
    >
      {showImage ? (
        <img
          src={image}
          alt={name}
          className="h-full w-full object-cover"
          onError={() => setHasError(true)}
        />
      ) : (
        initials
      )}
    </span>
  );
}

export function WorkspaceRoleBadge({ role }: { role: WorkspaceRole }) {
  const { t } = useTranslation("workspace");
  const Icon = role === "owner" ? LuShieldCheck : role === "admin" ? LuShield : LuUser;
  return (
    <span className={cn(
      "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium capitalize border transition-colors",
      role === "owner"
        ? "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/25"
        : role === "admin"
        ? "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/25"
        : "bg-muted/60 text-muted-foreground border-border/40"
    )}>
      <Icon className="h-3.5 w-3.5" />{t(`roles.${role}`)}
    </span>
  );
}
