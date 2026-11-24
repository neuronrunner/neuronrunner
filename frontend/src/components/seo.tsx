import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

export interface SEOProps {
  title?: string;
  description?: string;
  canonical?: string;
  ogType?: "website" | "article";
  ogImage?: string;
  jsonLd?: Record<string, unknown> | Array<Record<string, unknown>>;
  noindex?: boolean;
}

const SITE_URL = "https://neuronrunner.com";
const DEFAULT_OG_IMAGE = `${SITE_URL}/og-image.png`;

function setMetaTag(selector: string, attribute: string, value: string) {
  if (typeof document === "undefined") return;
  let element = document.querySelector(selector);
  if (!element) {
    element = document.createElement("meta");
    const clean = selector.replace(/^meta\[|\]$/g, "");
    const eqIdx = clean.indexOf("=");
    if (eqIdx !== -1) {
      const attrName = clean.slice(0, eqIdx);
      const attrVal = clean.slice(eqIdx + 1).replace(/['"]/g, "");
      element.setAttribute(attrName, attrVal);
    }
    document.head.appendChild(element);
  }
  element.setAttribute(attribute, value);
}

function setCanonical(href: string) {
  if (typeof document === "undefined") return;
  let element = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
  if (!element) {
    element = document.createElement("link");
    element.setAttribute("rel", "canonical");
    document.head.appendChild(element);
  }
  element.setAttribute("href", href);
}

export function SEO({
  title,
  description,
  canonical,
  ogType = "website",
  ogImage = DEFAULT_OG_IMAGE,
  jsonLd,
  noindex = false,
}: SEOProps) {
  const location = useLocation();
  const { t } = useTranslation("auth");
  const defaultTitle = t("seo.defaultTitle");
  const resolvedDescription = description ?? t("seo.defaultDescription");

  useEffect(() => {
    if (typeof document === "undefined") return;

    // 1. Title
    const fullTitle = title
      ? title.includes("Neuron Runner")
        ? title
        : t("seo.titleWithBrand", { title })
      : defaultTitle;
    document.title = fullTitle;

    // 2. Description
    setMetaTag('meta[name="description"]', "content", resolvedDescription);

    // 3. Robots
    setMetaTag(
      'meta[name="robots"]',
      "content",
      noindex ? "noindex, nofollow" : "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"
    );

    // 4. Canonical URL
    const targetCanonical = canonical || `${SITE_URL}${location.pathname}`;
    setCanonical(targetCanonical);

    // 5. Open Graph
    setMetaTag('meta[property="og:title"]', "content", fullTitle);
    setMetaTag('meta[property="og:description"]', "content", resolvedDescription);
    setMetaTag('meta[property="og:url"]', "content", targetCanonical);
    setMetaTag('meta[property="og:type"]', "content", ogType);
    setMetaTag('meta[property="og:image"]', "content", ogImage);

    // 6. Twitter
    setMetaTag('meta[name="twitter:title"]', "content", fullTitle);
    setMetaTag('meta[name="twitter:description"]', "content", resolvedDescription);
    setMetaTag('meta[name="twitter:image"]', "content", ogImage);

    // 7. Custom JSON-LD if provided
    let scriptTag: HTMLScriptElement | null = null;
    if (jsonLd) {
      const existing = document.getElementById("dynamic-seo-jsonld");
      if (existing) existing.remove();

      scriptTag = document.createElement("script");
      scriptTag.type = "application/ld+json";
      scriptTag.id = "dynamic-seo-jsonld";
      scriptTag.text = JSON.stringify(jsonLd);
      document.head.appendChild(scriptTag);
    }

    return () => {
      if (scriptTag && scriptTag.parentNode) {
        scriptTag.parentNode.removeChild(scriptTag);
      }
    };
  }, [title, resolvedDescription, defaultTitle, t, canonical, ogType, ogImage, jsonLd, noindex, location.pathname]);

  return null;
}

export default SEO;
