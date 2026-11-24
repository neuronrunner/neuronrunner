"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  LuCheck,
  LuCopy,
  LuEllipsis,
  LuLink,
  LuLoaderCircle,
  LuPencil,
  LuTrash2,
  LuTriangleAlert,
  LuX,
} from "react-icons/lu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toaster } from "@/components/ui/toaster";
import useSidebarStore from "@/stores/sidebar";
import useChatStore from "@/stores/chat";
import { useRouter } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import FadingText from "@/components/fading-text";

interface ConversationTitleInputProps {
  variant?: "default" | "workspace";
  className?: string;
}

const ConversationTitleInput = ({
  variant = "default",
  className,
}: ConversationTitleInputProps) => {
  const { t } = useTranslation("chat");
  const { conversations, renameConversation, deleteConversation } = useSidebarStore();
  const conversationId = useChatStore((state) => state.conversationId);
  const router = useRouter();

  const currentConversation = conversations.find((c) => c.uuid === conversationId);
  const originalTitle = currentConversation?.title?.trim() ?? "";
  const displayTitle = originalTitle || t("conversation.untitled");

  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [isLinkCopied, setIsLinkCopied] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Sync title from store if not editing
  useEffect(() => {
    if (!isEditing) {
      setEditTitle(originalTitle);
    }
  }, [originalTitle, isEditing]);

  // Focus and select input upon entering edit mode
  useEffect(() => {
    if (isEditing) {
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      });
    }
  }, [isEditing]);

  const handleStartEdit = useCallback(() => {
    setEditTitle(originalTitle || t("conversation.untitled"));
    setIsEditing(true);
  }, [originalTitle, t]);

  const handleCancel = useCallback(() => {
    setEditTitle(originalTitle);
    setIsEditing(false);
  }, [originalTitle]);

  const handleSave = useCallback(async () => {
    const trimmed = editTitle.trim();
    if (!trimmed || trimmed === originalTitle || !conversationId) {
      setIsEditing(false);
      return;
    }
    setIsSaving(true);
    try {
      await renameConversation(conversationId, trimmed);
      setIsEditing(false);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 1800);
    } catch {
      toaster.create({ title: t("conversation.renameFailed"), type: "error" });
    } finally {
      setIsSaving(false);
    }
  }, [editTitle, originalTitle, conversationId, renameConversation, t]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
  };

  const handleBlur = (e: React.FocusEvent) => {
    if (containerRef.current?.contains(e.relatedTarget as Node)) {
      return;
    }
    handleSave();
  };

  const handleCopyTitle = async () => {
    try {
      await navigator.clipboard.writeText(displayTitle);
      setIsCopied(true);
      toaster.create({ title: t("conversation.titleCopied"), type: "success" });
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      toaster.create({ title: t("conversation.copyTitleFailed"), type: "error" });
    }
  };

  const handleCopyLink = async () => {
    if (!conversationId) return;
    try {
      const url = `${window.location.origin}/chat/${conversationId}`;
      await navigator.clipboard.writeText(url);
      setIsLinkCopied(true);
      toaster.create({ title: t("conversation.linkCopied"), type: "success" });
      setTimeout(() => setIsLinkCopied(false), 2000);
    } catch {
      toaster.create({ title: t("conversation.copyLinkFailed"), type: "error" });
    }
  };

  const handleDeleteConfirm = async () => {
    if (!conversationId) return;
    setIsDeleting(true);
    try {
      await deleteConversation(conversationId);
      setDeleteDialogOpen(false);
      toaster.create({ title: t("conversation.deleted"), type: "success" });
      router.push("/new");
    } catch {
      toaster.create({ title: t("conversation.deleteFailed"), type: "error" });
    } finally {
      setIsDeleting(false);
    }
  };

  if (!conversationId) return null;

  return (
    <>
      <div
        ref={containerRef}
        className={cn(
          "group/title relative flex min-w-0 items-center gap-1",
          className
        )}
      >
        {isEditing ? (
          <div className="flex min-w-0 items-center gap-1.5 animate-in fade-in-50 zoom-in-[0.98] duration-150">
            <div className="relative flex items-center min-w-0">
              <input
                ref={inputRef}
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleBlur}
                disabled={isSaving}
                placeholder={t("conversation.untitled")}
                className={cn(
                  "w-[min(420px,calc(100vw-14rem))] min-w-[140px] rounded-lg border border-border bg-background/95 px-2.5 py-1 text-sm font-semibold tracking-[-0.01em] text-foreground shadow-xs outline-none transition-all focus:border-zinc-400 dark:focus:border-zinc-600 focus:ring-0",
                  variant === "workspace" ? "h-7" : "h-8"
                )}
              />
            </div>

            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                onClick={handleSave}
                disabled={isSaving || !editTitle.trim()}
                title={t("conversation.saveShortcut")}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-primary transition-all hover:bg-primary hover:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 disabled:opacity-40"
              >
                {isSaving ? (
                  <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <LuCheck className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                type="button"
                onClick={handleCancel}
                disabled={isSaving}
                title={t("conversation.cancelShortcut")}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-all hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25"
              >
                <LuX className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={handleStartEdit}
              title={t("conversation.clickToRename", { title: displayTitle })}
              className={cn(
                "group/btn relative flex min-w-0 max-w-[min(480px,calc(100vw-8rem))] sm:max-w-[min(480px,calc(100vw-16rem))] items-center gap-1.5 rounded-lg text-left transition-all duration-150 select-none",
                variant === "workspace"
                  ? "h-7 px-1.5 text-sm font-semibold tracking-[-0.01em] text-foreground hover:bg-muted/70 hover:text-foreground active:scale-[0.99]"
                  : "h-8 px-2.5 text-sm font-medium text-foreground hover:bg-muted/70"
              )}
            >
              <FadingText text={displayTitle} />

              <LuPencil
                className="h-3 w-3 shrink-0 text-muted-foreground/50 opacity-0 transition-all duration-150 group-hover/btn:opacity-100 group-hover/btn:text-foreground"
                aria-hidden="true"
              />

              {justSaved && (
                <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-emerald-500 animate-in fade-in zoom-in-90 duration-200">
                  <LuCheck className="h-3 w-3" />
                </span>
              )}
            </button>

            {isSaving && (
              <LuLoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("conversation.actionsAriaLabel")}
                  className={cn(
                    "inline-flex shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-all",
                    "hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25",
                    variant === "workspace"
                      ? "h-6 w-6 opacity-60 group-hover/title:opacity-100"
                      : "h-7 w-7"
                  )}
                >
                  <LuEllipsis className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-52 rounded-xl border border-border bg-popover p-1.5 shadow-xl backdrop-blur-xl"
              >
                <DropdownMenuItem
                  onClick={handleStartEdit}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium"
                >
                  <LuPencil className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>{t("conversation.rename")}</span>
                  <kbd className="ml-auto rounded border border-border/50 bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground/70">
                    ↵
                  </kbd>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={handleCopyTitle}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium"
                >
                  {isCopied ? (
                    <LuCheck className="h-3.5 w-3.5 text-emerald-500" />
                  ) : (
                    <LuCopy className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                  <span>{isCopied ? t("conversation.copiedTitle") : t("conversation.copyTitle")}</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={handleCopyLink}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium"
                >
                  {isLinkCopied ? (
                    <LuCheck className="h-3.5 w-3.5 text-emerald-500" />
                  ) : (
                    <LuLink className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                  <span>{isLinkCopied ? t("conversation.copiedLink") : t("conversation.copyLink")}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => setDeleteDialogOpen(true)}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium text-destructive focus:bg-destructive/10 focus:text-destructive"
                >
                  <LuTrash2 className="h-3.5 w-3.5" />
                  <span>{t("conversation.deleteConversation")}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="max-w-sm rounded-2xl border border-border bg-card p-6 shadow-2xl">
          <div className="flex flex-col items-center gap-3 text-center sm:items-start sm:text-left">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <LuTriangleAlert className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <DialogTitle className="text-base font-semibold">{t("conversation.deleteDialogTitle")}</DialogTitle>
              <DialogDescription className="text-xs leading-relaxed text-muted-foreground">
                <Trans
                  t={t}
                  i18nKey="conversation.deleteDialogDescription"
                  values={{ title: displayTitle }}
                  components={{ bold: <span className="font-semibold text-foreground" /> }}
                />
              </DialogDescription>
            </div>
          </div>
          <DialogFooter className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={isDeleting}
              className="rounded-lg"
            >
              {t("conversation.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleDeleteConfirm}
              loading={isDeleting}
              className="rounded-lg"
            >
              {t("conversation.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default ConversationTitleInput;
