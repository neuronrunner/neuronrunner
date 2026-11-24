"use client";

import React, { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { LuCopy, LuCheck } from "react-icons/lu";
import { cn } from "@/lib/utils";
import MarkdownImage from "@/components/markdown-image";
import { groupMarkdownImages } from "@/lib/markdown-images";
import InteractiveChoiceCard from "@/components/chat/interactive-choice-card";

const KNOWN_LANGS = new Set([
  "tsx", "ts", "js", "scss", "html", "bash", "json", "python", "go", "rust",
  "mermaid", "sql", "yaml", "javascript", "typescript", "jsx", "css", "ruby",
  "php", "java", "c", "cpp", "csharp", "dart", "elixir", "erlang", "graphql",
  "haskell", "kotlin", "lua", "markdown", "objective-c", "perl", "powershell",
  "r", "regex", "shell", "solidity", "swift", "toml", "xml", "zig",
]);

function safeLang(lang: string | undefined): string | undefined {
  if (!lang) return undefined;
  const clean = lang.split(/[^a-zA-Z0-9_#-]/)[0];
  if (!clean || !KNOWN_LANGS.has(clean)) return undefined;
  return clean;
}

function displayLang(lang: string | undefined, fallback: string): string {
  if (!lang) return fallback;
  const clean = safeLang(lang);
  return clean || fallback;
}

const MDCodeBlock = ({ children, lang }: { children: string; lang?: string }) => {
  const { t } = useTranslation("chat");
  const text = String(children).replace(/\n$/, "");
  const [copied, setCopied] = useState(false);

  const isInteractiveChoice = Boolean(
    lang &&
      /^(interactive[-_]?(?:choice|choices|form|poll|options?)|choice|poll|options)$/i.test(
        lang.trim()
      )
  );

  if (isInteractiveChoice) {
    return <InteractiveChoiceCard content={text} />;
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!text.includes("\n") && !lang) {
    return (
      <code className="px-1.5 py-0.5 text-xs sm:text-sm rounded-md bg-muted text-foreground font-mono break-all whitespace-pre-wrap">
        {text}
      </code>
    );
  }

  return (
    <div className="my-3 rounded-xl border border-border/70 dark:border-white/10 bg-card dark:bg-[#07070c] overflow-hidden text-xs sm:text-sm max-w-full shadow-xs">
      <div className="flex items-center justify-between px-3.5 py-1.5 border-b border-border/60 dark:border-white/10 bg-muted/40 dark:bg-white/[0.03]">
        <span className="text-xs font-mono text-muted-foreground uppercase font-medium">
          {displayLang(lang, t("markdown.codeFallback"))}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted dark:hover:bg-white/10 transition-colors"
        >
          {copied ? <LuCheck className="h-3.5 w-3.5 text-emerald-500 dark:text-emerald-400" /> : <LuCopy className="h-3.5 w-3.5" />}
          <span>{copied ? t("markdown.copied") : t("markdown.copy")}</span>
        </button>
      </div>
      <pre className="p-3.5 overflow-x-auto font-mono text-xs sm:text-sm leading-relaxed text-foreground">
        <code>{text}</code>
      </pre>
    </div>
  );
};

const MarkdownRenderer = memo(function MarkdownRenderer({
  markdown,
  style,
  className,
}: {
  markdown: string;
  style?: React.CSSProperties;
  className?: string;
}) {
  return (
    <div style={style} className={cn("w-full min-w-0 overflow-hidden leading-relaxed text-foreground", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[groupMarkdownImages]}
        urlTransform={(url, key, node) => key === "src" && node.tagName === "img" && /^data:image\/(?:png|jpeg|webp|gif|bmp|avif);base64,/i.test(url) ? url : defaultUrlTransform(url)}
        components={{
          h1: ({ children }) => (
            <h1 className="mt-6 mb-3 text-2xl font-bold text-foreground tracking-tight">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-5 mb-2.5 text-xl font-semibold text-foreground tracking-tight">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-4 mb-2 text-lg font-semibold text-foreground">
              {children}
            </h3>
          ),
          p: ({ children, node }) => node?.properties.className?.toString().includes("markdown-image-gallery") ? (
            <div data-markdown-gallery className="my-3 flex min-w-0 flex-wrap items-start gap-3">{children}</div>
          ) : (
            <p className="text-[15px] sm:text-base mb-3 leading-relaxed text-foreground">
              {children}
            </p>
          ),
          code: (props) => (
            <MDCodeBlock
              lang={
                props.className?.startsWith("language-")
                  ? props.className.split("language-")[1]
                  : undefined
              }
            >
              {Array.isArray(props.children) ? props.children.join("") : String(props.children)}
            </MDCodeBlock>
          ),
          img: ({ src, alt, title, node }) => {
            if (!src) return null;
            const srcStr = typeof src === "string" ? src : "";
            return <MarkdownImage source={srcStr} alt={alt} title={title} linked={Boolean(node?.properties["data-linked-image"])} gallery={Boolean(node?.properties["data-gallery-image"])} />;
          },
          a: ({ href, children, node }) => {
            const url = typeof href === "string" ? href : "";
            const isExternal = /^https?:\/\//i.test(url);
            let domain = "";
            try {
              if (isExternal) {
                domain = new URL(url).hostname;
              }
            } catch {
              // invalid url
            }

            if (!url) {
              return <span>{children}</span>;
            }
            if (node?.children.some(child => child.type === "element" && child.tagName === "img")) {
              return <a href={url} target={isExternal ? "_blank" : undefined} rel={isExternal ? "noopener noreferrer" : undefined} className="block min-w-0">{children}</a>;
            }

            return (
              <a
                href={url}
                target={isExternal ? "_blank" : undefined}
                rel={isExternal ? "noopener noreferrer" : undefined}
                className="inline-flex items-center gap-1.5 px-2 py-0.5 mx-0.5 my-0.5 rounded-full border border-border bg-muted/40 hover:bg-muted text-xs sm:text-sm font-medium text-foreground transition-all hover:-translate-y-0.5 shadow-sm"
              >
                {isExternal && domain && (
                  <img
                    src={`https://www.google.com/s2/favicons?domain=${domain}&sz=32`}
                    alt={domain}
                    className="w-3.5 h-3.5 rounded-sm object-contain"
                  />
                )}
                <span>{children}</span>
              </a>
            );
          },
          ul: ({ children }) => (
            <ul className="list-disc pl-5 mb-3 text-[15px] sm:text-base space-y-1.5">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-5 mb-3 text-[15px] sm:text-base space-y-1.5">
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="ml-1 mb-1 text-[15px] sm:text-base">
              {children}
            </li>
          ),
          table: ({ children }) => (
            <div className="w-full overflow-x-auto my-4 border border-border rounded-xl bg-card overflow-hidden">
              <table className="w-full text-xs sm:text-sm text-left border-collapse">
                {children}
              </table>
            </div>
          ),
          thead: (props) => (
            <thead className="bg-muted/50 border-b border-border" {...props} />
          ),
          tbody: (props) => <tbody className="divide-y divide-border/50" {...props} />,
          tr: (props) => (
            <tr className="hover:bg-muted/30 transition-colors" {...props} />
          ),
          th: ({ children }) => (
            <th className="px-4 py-2.5 font-semibold text-xs sm:text-sm text-foreground">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-4 py-2.5 text-xs sm:text-sm align-top text-foreground/90">
              {children}
            </td>
          ),
          hr: () => <hr className="my-6 border-border" />,
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
});

export default MarkdownRenderer;
