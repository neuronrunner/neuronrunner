"use client";

import { useTranslation } from "react-i18next";
import { LuCheck, LuChevronDown, LuGlobe } from "react-icons/lu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } from "@/i18n/languages";
import { cn } from "@/lib/utils";

interface LanguageSwitcherProps {
  className?: string;
}

export function LanguageSwitcher({ className }: LanguageSwitcherProps) {
  const { i18n, t } = useTranslation();
  const currentLang = i18n.resolvedLanguage || DEFAULT_LANGUAGE;
  const currentLanguage = SUPPORTED_LANGUAGES.find((language) => language.code === currentLang);

  const handleChange = (value: string) => {
    void i18n.changeLanguage(value);
  };

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("language.label")}
          className={cn(
            "flex h-9 w-full sm:w-[220px] items-center justify-between gap-2 rounded-xl border border-input dark:border-white/10 bg-muted/40 dark:bg-black/30 px-3 py-2 text-xs sm:text-sm text-foreground shadow-xs outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
            className
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            <LuGlobe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate whitespace-nowrap">
              {currentLanguage?.nativeName ?? currentLang}
            </span>
          </div>
          <LuChevronDown className="h-4 w-4 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        {SUPPORTED_LANGUAGES.map((lang) => {
          const isSelected = lang.code === currentLang;
          return (
            <DropdownMenuItem
              key={lang.code}
              onSelect={() => handleChange(lang.code)}
              className="justify-between gap-3"
            >
              <span className="flex items-center gap-2">
                <span>{lang.nativeName}</span>
                {lang.nativeName !== lang.englishName && (
                  <span className="text-xs text-muted-foreground">
                    {lang.englishName}
                  </span>
                )}
              </span>
              {isSelected && <LuCheck className="h-4 w-4 shrink-0 text-foreground" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
