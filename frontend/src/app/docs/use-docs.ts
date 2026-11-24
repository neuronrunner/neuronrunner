import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { buildDocsIndex, type DocsIndex } from "./docs-data";
import { DOCS_GLOB_PREFIX, rawCategoryFiles, rawDocFiles } from "./docs-source";

export const DOCS_REPO_URL = "https://github.com/neuronrunner/neuronrunner";

export function getDocsIndex(language: string): DocsIndex {
  return buildDocsIndex(rawDocFiles, rawCategoryFiles, language, DOCS_GLOB_PREFIX);
}

export function useDocs(): DocsIndex {
  const { i18n } = useTranslation("docs");
  const language = i18n.resolvedLanguage || i18n.language || "en";
  return useMemo(() => getDocsIndex(language), [language]);
}
