"use client";

import React, { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LuArrowRight } from "react-icons/lu";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { categoryIcon } from "./docs-icons";
import { useDocs } from "./use-docs";

interface DocsSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const DocsSearchDialog: React.FC<DocsSearchDialogProps> = ({
  open,
  onOpenChange,
}) => {
  const navigate = useNavigate();
  const { t } = useTranslation("docs");
  const { categories } = useDocs();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !["INPUT", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName))) {
        e.preventDefault();
        onOpenChange(true);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onOpenChange]);

  const handleSelect = (articleId: string) => {
    onOpenChange(false);
    navigate(`/docs/${articleId}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 max-w-xl border-border/80 bg-background/95 backdrop-blur-xl shadow-2xl">
        <Command className="rounded-xl border-0">
          <CommandInput
            placeholder={t("searchDialog.placeholder")}
            className="text-sm"
          />

          <CommandList className="max-h-[380px] p-2">
            <CommandEmpty className="py-8 text-center text-xs text-muted-foreground">
              {t("searchDialog.empty")}
            </CommandEmpty>

            {categories.map((cat) => {
              const IconComp = categoryIcon(cat.icon);
              return (
                <CommandGroup
                  key={cat.id}
                  heading={
                    <div className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                      <IconComp className="h-3 w-3 text-indigo-400" />
                      <span>{cat.title}</span>
                    </div>
                  }
                  className="mb-2"
                >
                  {cat.items.map((item) => {
                    return (
                      <CommandItem
                        key={item.slug}
                        value={`${item.slug} ${cat.title} ${item.title} ${item.description} ${item.headings.map((h) => h.title).join(" ")}`}
                        onSelect={() => handleSelect(item.slug)}
                        className="group flex cursor-pointer items-center justify-between rounded-lg px-3 py-2.5 text-xs transition-colors hover:bg-muted/80 data-[selected=true]:bg-indigo-500/10 data-[selected=true]:text-indigo-400"
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className="font-semibold text-foreground group-hover:text-foreground">
                            {item.title}
                          </span>
                          <span className="line-clamp-1 text-[11px] text-muted-foreground">
                            {item.description}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-data-[selected=true]:opacity-100 transition-opacity">
                          <span className="font-mono text-[10px] text-indigo-400">{t("searchDialog.jump")}</span>
                          <LuArrowRight className="h-3 w-3 text-indigo-400" />
                        </div>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              );
            })}
          </CommandList>

          <div className="flex items-center justify-between border-t border-border/50 bg-muted/20 px-3 py-2 text-[11px] font-mono text-muted-foreground">
            <div className="flex items-center gap-2">
              <span className="rounded bg-muted px-1.5 py-0.5">↑↓</span>
              <span>{t("searchDialog.navigate")}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 ml-2">↵</span>
              <span>{t("searchDialog.select")}</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="rounded bg-muted px-1.5 py-0.5">ESC</span>
              <span>{t("searchDialog.close")}</span>
            </div>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
};
