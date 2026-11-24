import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGE_CODES } from "./languages";

import enCommon from "@/locales/en/common.json";
import enAuth from "@/locales/en/auth.json";
import enLanding from "@/locales/en/landing.json";
import enChat from "@/locales/en/chat.json";
import enSettings from "@/locales/en/settings.json";
import enConnectors from "@/locales/en/connectors.json";
import enWorkspace from "@/locales/en/workspace.json";
import enGit from "@/locales/en/git.json";
import enDocs from "@/locales/en/docs.json";
import enLegal from "@/locales/en/legal.json";

import zhCNCommon from "@/locales/zh-CN/common.json";
import zhCNAuth from "@/locales/zh-CN/auth.json";
import zhCNLanding from "@/locales/zh-CN/landing.json";
import zhCNChat from "@/locales/zh-CN/chat.json";
import zhCNSettings from "@/locales/zh-CN/settings.json";
import zhCNConnectors from "@/locales/zh-CN/connectors.json";
import zhCNWorkspace from "@/locales/zh-CN/workspace.json";
import zhCNGit from "@/locales/zh-CN/git.json";
import zhCNDocs from "@/locales/zh-CN/docs.json";
import zhCNLegal from "@/locales/zh-CN/legal.json";

import esCommon from "@/locales/es/common.json";
import esAuth from "@/locales/es/auth.json";
import esLanding from "@/locales/es/landing.json";
import esChat from "@/locales/es/chat.json";
import esSettings from "@/locales/es/settings.json";
import esConnectors from "@/locales/es/connectors.json";
import esWorkspace from "@/locales/es/workspace.json";
import esGit from "@/locales/es/git.json";
import esDocs from "@/locales/es/docs.json";
import esLegal from "@/locales/es/legal.json";

import hiCommon from "@/locales/hi/common.json";
import hiAuth from "@/locales/hi/auth.json";
import hiLanding from "@/locales/hi/landing.json";
import hiChat from "@/locales/hi/chat.json";
import hiSettings from "@/locales/hi/settings.json";
import hiConnectors from "@/locales/hi/connectors.json";
import hiWorkspace from "@/locales/hi/workspace.json";
import hiGit from "@/locales/hi/git.json";
import hiDocs from "@/locales/hi/docs.json";
import hiLegal from "@/locales/hi/legal.json";

import ptBRCommon from "@/locales/pt-BR/common.json";
import ptBRAuth from "@/locales/pt-BR/auth.json";
import ptBRLanding from "@/locales/pt-BR/landing.json";
import ptBRChat from "@/locales/pt-BR/chat.json";
import ptBRSettings from "@/locales/pt-BR/settings.json";
import ptBRConnectors from "@/locales/pt-BR/connectors.json";
import ptBRWorkspace from "@/locales/pt-BR/workspace.json";
import ptBRGit from "@/locales/pt-BR/git.json";
import ptBRDocs from "@/locales/pt-BR/docs.json";
import ptBRLegal from "@/locales/pt-BR/legal.json";

import frCommon from "@/locales/fr/common.json";
import frAuth from "@/locales/fr/auth.json";
import frLanding from "@/locales/fr/landing.json";
import frChat from "@/locales/fr/chat.json";
import frSettings from "@/locales/fr/settings.json";
import frConnectors from "@/locales/fr/connectors.json";
import frWorkspace from "@/locales/fr/workspace.json";
import frGit from "@/locales/fr/git.json";
import frDocs from "@/locales/fr/docs.json";
import frLegal from "@/locales/fr/legal.json";

import ruCommon from "@/locales/ru/common.json";
import ruAuth from "@/locales/ru/auth.json";
import ruLanding from "@/locales/ru/landing.json";
import ruChat from "@/locales/ru/chat.json";
import ruSettings from "@/locales/ru/settings.json";
import ruConnectors from "@/locales/ru/connectors.json";
import ruWorkspace from "@/locales/ru/workspace.json";
import ruGit from "@/locales/ru/git.json";
import ruDocs from "@/locales/ru/docs.json";
import ruLegal from "@/locales/ru/legal.json";

import jaCommon from "@/locales/ja/common.json";
import jaAuth from "@/locales/ja/auth.json";
import jaLanding from "@/locales/ja/landing.json";
import jaChat from "@/locales/ja/chat.json";
import jaSettings from "@/locales/ja/settings.json";
import jaConnectors from "@/locales/ja/connectors.json";
import jaWorkspace from "@/locales/ja/workspace.json";
import jaGit from "@/locales/ja/git.json";
import jaDocs from "@/locales/ja/docs.json";
import jaLegal from "@/locales/ja/legal.json";

import deCommon from "@/locales/de/common.json";
import deAuth from "@/locales/de/auth.json";
import deLanding from "@/locales/de/landing.json";
import deChat from "@/locales/de/chat.json";
import deSettings from "@/locales/de/settings.json";
import deConnectors from "@/locales/de/connectors.json";
import deWorkspace from "@/locales/de/workspace.json";
import deGit from "@/locales/de/git.json";
import deDocs from "@/locales/de/docs.json";
import deLegal from "@/locales/de/legal.json";

import trCommon from "@/locales/tr/common.json";
import trAuth from "@/locales/tr/auth.json";
import trLanding from "@/locales/tr/landing.json";
import trChat from "@/locales/tr/chat.json";
import trSettings from "@/locales/tr/settings.json";
import trConnectors from "@/locales/tr/connectors.json";
import trWorkspace from "@/locales/tr/workspace.json";
import trGit from "@/locales/tr/git.json";
import trDocs from "@/locales/tr/docs.json";
import trLegal from "@/locales/tr/legal.json";

export const resources = {
  en: {
    common: enCommon,
    auth: enAuth,
    landing: enLanding,
    chat: enChat,
    settings: enSettings,
    connectors: enConnectors,
    workspace: enWorkspace,
    git: enGit,
    docs: enDocs,
    legal: enLegal,
  },
  "zh-CN": {
    common: zhCNCommon,
    auth: zhCNAuth,
    landing: zhCNLanding,
    chat: zhCNChat,
    settings: zhCNSettings,
    connectors: zhCNConnectors,
    workspace: zhCNWorkspace,
    git: zhCNGit,
    docs: zhCNDocs,
    legal: zhCNLegal,
  },
  es: {
    common: esCommon,
    auth: esAuth,
    landing: esLanding,
    chat: esChat,
    settings: esSettings,
    connectors: esConnectors,
    workspace: esWorkspace,
    git: esGit,
    docs: esDocs,
    legal: esLegal,
  },
  hi: {
    common: hiCommon,
    auth: hiAuth,
    landing: hiLanding,
    chat: hiChat,
    settings: hiSettings,
    connectors: hiConnectors,
    workspace: hiWorkspace,
    git: hiGit,
    docs: hiDocs,
    legal: hiLegal,
  },
  "pt-BR": {
    common: ptBRCommon,
    auth: ptBRAuth,
    landing: ptBRLanding,
    chat: ptBRChat,
    settings: ptBRSettings,
    connectors: ptBRConnectors,
    workspace: ptBRWorkspace,
    git: ptBRGit,
    docs: ptBRDocs,
    legal: ptBRLegal,
  },
  fr: {
    common: frCommon,
    auth: frAuth,
    landing: frLanding,
    chat: frChat,
    settings: frSettings,
    connectors: frConnectors,
    workspace: frWorkspace,
    git: frGit,
    docs: frDocs,
    legal: frLegal,
  },
  ru: {
    common: ruCommon,
    auth: ruAuth,
    landing: ruLanding,
    chat: ruChat,
    settings: ruSettings,
    connectors: ruConnectors,
    workspace: ruWorkspace,
    git: ruGit,
    docs: ruDocs,
    legal: ruLegal,
  },
  ja: {
    common: jaCommon,
    auth: jaAuth,
    landing: jaLanding,
    chat: jaChat,
    settings: jaSettings,
    connectors: jaConnectors,
    workspace: jaWorkspace,
    git: jaGit,
    docs: jaDocs,
    legal: jaLegal,
  },
  de: {
    common: deCommon,
    auth: deAuth,
    landing: deLanding,
    chat: deChat,
    settings: deSettings,
    connectors: deConnectors,
    workspace: deWorkspace,
    git: deGit,
    docs: deDocs,
    legal: deLegal,
  },
  tr: {
    common: trCommon,
    auth: trAuth,
    landing: trLanding,
    chat: trChat,
    settings: trSettings,
    connectors: trConnectors,
    workspace: trWorkspace,
    git: trGit,
    docs: trDocs,
    legal: trLegal,
  },
} as const;

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: (typeof resources)["en"];
  }
}

function syncDocumentLanguage(lng: string) {
  if (typeof document !== "undefined") {
    document.documentElement.lang = lng;
    document.documentElement.dir = "ltr";
  }
}

const isBrowser =
  typeof window !== "undefined" &&
  typeof navigator !== "undefined" &&
  typeof window.location !== "undefined";

if (isBrowser) {
  i18n.use(LanguageDetector);
}

i18n.use(initReactI18next).init({
  resources,
  ...(isBrowser ? {} : { lng: DEFAULT_LANGUAGE }),
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: [...SUPPORTED_LANGUAGE_CODES],
  defaultNS: "common",
  ns: [
    "common",
    "auth",
    "landing",
    "chat",
    "settings",
    "connectors",
    "workspace",
    "git",
    "docs",
    "legal",
  ],
  interpolation: {
    escapeValue: false,
  },
  detection: {
    order: ["localStorage", "navigator", "htmlTag"],
    lookupLocalStorage: "nr-language",
    caches: ["localStorage"],
    convertDetectedLanguage: (lng: string) => {
      const lower = lng.toLowerCase();
      if (lower.startsWith("zh")) return "zh-CN";
      if (lower.startsWith("pt")) return "pt-BR";
      const base = lower.split("-")[0];
      if ((SUPPORTED_LANGUAGE_CODES as readonly string[]).includes(base)) {
        return base;
      }
      return lng;
    },
  },
});

syncDocumentLanguage(i18n.resolvedLanguage || DEFAULT_LANGUAGE);
i18n.on("languageChanged", syncDocumentLanguage);

export default i18n;
