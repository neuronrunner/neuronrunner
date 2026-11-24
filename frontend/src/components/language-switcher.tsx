"use client";

import { useTranslation } from "react-i18next";
import { LuGlobe } from "react-icons/lu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
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
    <Select value={currentLang} onValueChange={handleChange}>
      <SelectTrigger
        aria-label={t("language.label")}
        className={cn(
          "h-9 w-full sm:w-[220px] rounded-xl bg-muted/40 dark:bg-black/30 border-input dark:border-white/10 text-xs sm:text-sm",
          className
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <LuGlobe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate whitespace-nowrap">{currentLanguage?.nativeName ?? currentLang}</span>
        </div>
      </SelectTrigger>
      <SelectContent>
        {SUPPORTED_LANGUAGES.map((lang) => (
          <SelectItem key={lang.code} value={lang.code}>
            <span className="flex items-center justify-between gap-2">
              <span>{lang.nativeName}</span>
              {lang.nativeName !== lang.englishName && (
                <span className="text-xs text-muted-foreground">
                  {lang.englishName}
                </span>
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
