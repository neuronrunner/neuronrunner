import React from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LuHash, LuInfo, LuLightbulb, LuShieldAlert, LuTriangleAlert, LuOctagonAlert } from "react-icons/lu";
import { cn } from "@/lib/utils";
import { CodeTabs } from "./code-tabs";
import { createSlugger, slugFromDocLink } from "./docs-data";

/* ------------------------------------------------------------------ */
/* Minimal syntax-tree helpers (mdast / hast share this shape)        */
/* ------------------------------------------------------------------ */

interface TreeNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: TreeNode[];
  data?: Record<string, unknown>;
}

function textContent(node: TreeNode | undefined): string {
  if (!node) return "";
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(textContent).join("");
}

function walk(node: TreeNode, visit: (node: TreeNode) => void) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

type CalloutType = "note" | "tip" | "important" | "warning" | "caution";
const CALLOUT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i;

/** Turns GitHub alert blockquotes (`> [!TIP]`) into callouts. */
function remarkCallouts() {
  return (tree: TreeNode) => {
    walk(tree, (node) => {
      if (node.type !== "blockquote") return;
      const paragraph = node.children?.[0];
      const first = paragraph?.type === "paragraph" ? paragraph.children?.[0] : undefined;
      if (!paragraph || first?.type !== "text" || typeof first.value !== "string") return;
      const match = first.value.match(CALLOUT_MARKER);
      if (!match) return;

      first.value = first.value.slice(match[0].length);
      if (first.value === "") paragraph.children!.shift();
      // Drop a leading line break left behind by the marker line.
      if (paragraph.children![0]?.type === "break") paragraph.children!.shift();
      if (paragraph.children!.length === 0) node.children!.shift();

      node.data = {
        ...node.data,
        hProperties: { ...((node.data?.hProperties as object) ?? {}), "data-callout": match[1].toLowerCase() },
      };
    });
  };
}

/** Gives every heading the same id the table of contents uses. */
function rehypeHeadingIds() {
  return (tree: TreeNode) => {
    const slug = createSlugger();
    walk(tree, (node) => {
      if (node.type === "element" && node.tagName && /^h[1-6]$/.test(node.tagName)) {
        node.properties = { ...node.properties, id: slug(textContent(node)) };
      }
    });
  };
}

/* ------------------------------------------------------------------ */
/* Callout                                                            */
/* ------------------------------------------------------------------ */

const CALLOUT_STYLES: Record<CalloutType, { box: string; icon: React.ElementType; iconClass: string; label: string }> = {
  note: {
    box: "border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
    icon: LuInfo,
    iconClass: "text-indigo-500 dark:text-indigo-400",
    label: "Note",
  },
  tip: {
    box: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    icon: LuLightbulb,
    iconClass: "text-emerald-500 dark:text-emerald-400",
    label: "Tip",
  },
  important: {
    box: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
    icon: LuTriangleAlert,
    iconClass: "text-violet-500 dark:text-violet-400",
    label: "Important",
  },
  warning: {
    box: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    icon: LuShieldAlert,
    iconClass: "text-amber-500 dark:text-amber-400",
    label: "Warning",
  },
  caution: {
    box: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    icon: LuOctagonAlert,
    iconClass: "text-rose-500 dark:text-rose-400",
    label: "Caution",
  },
};

function Callout({ type, children }: { type: CalloutType; children: React.ReactNode }) {
  const { t } = useTranslation("docs");
  const style = CALLOUT_STYLES[type] ?? CALLOUT_STYLES.note;
  const Icon = style.icon;
  return (
    <div className={cn("my-5 flex items-start gap-3 rounded-xl border p-4 text-sm leading-relaxed", style.box)}>
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", style.iconClass)} />
      <div className="min-w-0 space-y-2 [&_a]:text-current [&_li]:text-current [&_p]:m-0 [&_p]:text-sm [&_p]:text-current">
        <strong className="block text-[11px] font-semibold uppercase tracking-wider">
          {t(`callouts.${type}`, { defaultValue: style.label })}
        </strong>
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Renderer                                                           */
/* ------------------------------------------------------------------ */

interface DocsMarkdownProps {
  source: string;
  onCopyHeading?: (id: string) => void;
}

export function DocsMarkdown({ source, onCopyHeading }: DocsMarkdownProps) {
  const { t } = useTranslation("docs");

  const components: Components = {
    h1: ({ node: _node, children, ...props }) => (
      <h2 {...props} className="scroll-mt-24 pt-4 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
        {children}
      </h2>
    ),
    h2: ({ node: _node, children, id, ...props }) => (
      <div className="group flex items-center gap-2 pt-6">
        <h2 id={id} {...props} className="scroll-mt-24 text-xl font-bold tracking-tight text-foreground sm:text-2xl">
          {children}
        </h2>
        {id && (
          <button
            type="button"
            onClick={() => onCopyHeading?.(id)}
            className="p-1 text-muted-foreground opacity-0 transition-opacity hover:text-indigo-400 group-hover:opacity-100 focus-visible:opacity-100"
            title={t("article.copyHeadingTitle")}
            aria-label={t("article.copyHeadingTitle")}
          >
            <LuHash className="h-4 w-4" />
          </button>
        )}
      </div>
    ),
    h3: ({ node: _node, ...props }) => (
      <h3 {...props} className="scroll-mt-24 pt-2 text-lg font-semibold tracking-tight text-foreground" />
    ),
    h4: ({ node: _node, ...props }) => (
      <h4 {...props} className="scroll-mt-24 text-base font-semibold text-foreground" />
    ),
    p: ({ node: _node, ...props }) => (
      <p {...props} className="text-sm leading-relaxed text-muted-foreground sm:text-base" />
    ),
    a: ({ node: _node, href = "", children, ...props }) => {
      const docLink = slugFromDocLink(href);
      const className = "font-medium text-indigo-500 underline-offset-4 hover:underline dark:text-indigo-400";
      if (docLink) {
        return (
          <Link to={`/docs/${docLink.slug}${docLink.hash}`} className={className}>
            {children}
          </Link>
        );
      }
      const external = /^https?:\/\//i.test(href);
      return (
        <a
          {...props}
          href={href}
          className={className}
          {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
        >
          {children}
        </a>
      );
    },
    ul: ({ node: _node, className, ...props }) => (
      <ul
        {...props}
        className={cn(
          "space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground sm:text-base",
          className?.includes("contains-task-list") ? "list-none pl-1" : "list-disc marker:text-indigo-400"
        )}
      />
    ),
    ol: ({ node: _node, ...props }) => (
      <ol
        {...props}
        className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground marker:text-indigo-400 sm:text-base"
      />
    ),
    li: ({ node: _node, ...props }) => <li {...props} className="pl-1 [&>p]:inline" />,
    input: ({ node: _node, ...props }) => (
      <input {...props} className="mr-2 h-3.5 w-3.5 translate-y-0.5 accent-indigo-500" />
    ),
    strong: ({ node: _node, ...props }) => <strong {...props} className="font-semibold text-foreground" />,
    hr: () => <hr className="my-8 border-border/60" />,
    img: ({ node: _node, alt, ...props }) => (
      <img {...props} alt={alt ?? ""} loading="lazy" className="my-4 max-w-full rounded-xl border border-border/70" />
    ),
    blockquote: ({ node, children, ...props }) => {
      // remarkCallouts sets this; hast may keep the attribute name as written.
      const props_ = node?.properties as Record<string, unknown> | undefined;
      const type = (props_?.dataCallout ?? props_?.["data-callout"]) as CalloutType | undefined;
      if (type) return <Callout type={type}>{children}</Callout>;
      return (
        <blockquote
          {...props}
          className="my-4 border-l-2 border-indigo-500/50 pl-4 italic text-muted-foreground"
        >
          {children}
        </blockquote>
      );
    },
    code: ({ node: _node, className, ...props }) => (
      <code
        {...props}
        className={cn(
          "rounded-md border border-border/60 bg-muted/60 px-1.5 py-0.5 font-mono text-[0.85em] text-foreground",
          className
        )}
      />
    ),
    pre: ({ node }) => {
      const codeNode = (node as TreeNode | undefined)?.children?.find((child) => child.tagName === "code");
      const classNames = (codeNode?.properties?.className as string[] | undefined) ?? [];
      const language = classNames.find((name) => name.startsWith("language-"))?.slice("language-".length) ?? "text";
      const code = textContent(codeNode).replace(/\n$/, "");
      return <CodeTabs defaultLanguage={language} defaultCode={code} />;
    },
    table: ({ node: _node, ...props }) => (
      <div className="my-4 overflow-hidden rounded-xl border border-border/80 bg-card/40 shadow-xs">
        <div className="overflow-x-auto">
          <table {...props} className="w-full text-left text-xs sm:text-sm" />
        </div>
      </div>
    ),
    thead: ({ node: _node, ...props }) => (
      <thead
        {...props}
        className="border-b border-border/80 bg-muted/40 font-mono text-[11px] uppercase tracking-wider text-muted-foreground"
      />
    ),
    tbody: ({ node: _node, ...props }) => <tbody {...props} className="divide-y divide-border/60" />,
    tr: ({ node: _node, ...props }) => <tr {...props} className="transition-colors hover:bg-muted/30" />,
    th: ({ node: _node, style: _style, ...props }) => <th {...props} className="px-4 py-3 font-semibold" />,
    td: ({ node: _node, style: _style, ...props }) => (
      <td
        {...props}
        className="px-4 py-3 align-top leading-relaxed text-muted-foreground first:font-medium first:text-foreground"
      />
    ),
  };

  return (
    <div className="space-y-4">
      <Markdown
        remarkPlugins={[remarkGfm, remarkCallouts]}
        rehypePlugins={[rehypeHeadingIds]}
        components={components}
      >
        {source}
      </Markdown>
    </div>
  );
}
