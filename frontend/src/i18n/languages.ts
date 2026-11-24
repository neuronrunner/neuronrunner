export interface LanguageOption {
  code: string;
  nativeName: string;
  englishName: string;
}

export const SUPPORTED_LANGUAGES: readonly LanguageOption[] = [
  { code: "en", nativeName: "English", englishName: "English" },
  { code: "zh-CN", nativeName: "简体中文", englishName: "Chinese (Simplified)" },
  { code: "es", nativeName: "Español", englishName: "Spanish" },
  { code: "hi", nativeName: "हिन्दी", englishName: "Hindi" },
  { code: "pt-BR", nativeName: "Português (Brasil)", englishName: "Portuguese (Brazil)" },
  { code: "fr", nativeName: "Français", englishName: "French" },
  { code: "ru", nativeName: "Русский", englishName: "Russian" },
  { code: "ja", nativeName: "日本語", englishName: "Japanese" },
  { code: "de", nativeName: "Deutsch", englishName: "German" },
  { code: "tr", nativeName: "Türkçe", englishName: "Turkish" },
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]["code"];

export const SUPPORTED_LANGUAGE_CODES: readonly SupportedLanguage[] =
  SUPPORTED_LANGUAGES.map((l) => l.code);

export const DEFAULT_LANGUAGE: SupportedLanguage = "en";
