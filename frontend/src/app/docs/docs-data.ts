// Builds the docs navigation and pages from the Markdown files in the
// repository's `docs/` folder. See docs/README.md for the file conventions.

export interface DocHeading {
  id: string;
  title: string;
}

export interface DocPage {
  slug: string;
  title: string;
  description: string;
  badge?: string;
  body: string;
  headings: DocHeading[];
  categoryId: string;
  categoryTitle: string;
  /** Path of the Markdown file relative to `docs/`, e.g. `01-getting-started/02-quickstart.md`. */
  sourcePath: string;
}

export interface DocCategory {
  id: string;
  title: string;
  icon: string;
  items: DocPage[];
}

export interface DocsIndex {
  categories: DocCategory[];
  pages: Record<string, DocPage>;
  ordered: DocPage[];
}

interface CategoryMeta {
  title?: string | Record<string, string>;
  icon?: string;
}

const DEFAULT_LANGUAGE = "en";
const ORDER_PREFIX = /^(\d+)-/;
const FILE_NAME = /^(?:\d+-)?([^.]+?)(?:\.([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)?))?\.md$/;

/** Normalizes keys like `../../../../docs/01-a/02-b.md` to `01-a/02-b.md`. */
function relativeDocPath(key: string, prefix: string): string {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

function stripOrder(name: string): string {
  return name.replace(ORDER_PREFIX, "");
}

function orderOf(name: string): number {
  const match = name.match(ORDER_PREFIX);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/, "");
}

/** Parses a minimal `key: value` front matter block. */
export function parseFrontMatter(source: string): { data: Record<string, string>; body: string } {
  const normalized = source.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { data: {}, body: normalized };

  const data: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) data[kv[1]] = unquote(kv[2]);
  }
  return { data, body: normalized.slice(match[0].length) };
}

/** Plain text of a Markdown heading line (inline code, links and emphasis removed). */
export function headingText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/\s+#+\s*$/, "")
    .trim();
}

export function slugifyHeading(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-") || "section"
  );
}

/** Returns a function that hands out unique ids in order, like GitHub does (`a`, `a-1`, ...). */
export function createSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text: string) => {
    const base = slugifyHeading(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

/** Level-2 headings outside fenced code blocks, used for the table of contents. */
export function extractHeadings(body: string): DocHeading[] {
  const headings: DocHeading[] = [];
  const slug = createSlugger();
  let fence: string | null = null;

  for (const line of body.split("\n")) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (!heading) continue;
    const title = headingText(heading[2]);
    const id = slug(title);
    if (heading[1].length === 2) headings.push({ id, title });
  }
  return headings;
}

/** Picks the best entry for `language`: exact match, then base language, then English. */
function pickLanguage<T>(variants: Record<string, T>, language: string): T | undefined {
  const base = language.split("-")[0];
  return variants[language] ?? variants[base] ?? variants[DEFAULT_LANGUAGE] ?? Object.values(variants)[0];
}

function categoryTitle(meta: CategoryMeta | undefined, folder: string, language: string): string {
  const title = meta?.title;
  if (typeof title === "string") return title;
  if (title && typeof title === "object") {
    const picked = pickLanguage(title, language);
    if (picked) return picked;
  }
  return stripOrder(folder)
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Maps a relative `.md` link (as written in a docs page) to its slug, if it is one. */
export function slugFromDocLink(href: string): { slug: string; hash: string } | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/") || href.startsWith("#")) return null;
  const [pathPart, hash = ""] = href.split("#");
  const fileName = pathPart.split("/").pop() ?? "";
  const match = fileName.match(FILE_NAME);
  if (!match) return null;
  return { slug: match[1], hash: hash ? `#${hash}` : "" };
}

export function buildDocsIndex(
  files: Record<string, string>,
  categoryFiles: Record<string, unknown>,
  language: string,
  prefix = "",
): DocsIndex {
  // folder -> slug -> language -> { fileName, source }
  const tree = new Map<string, Map<string, Record<string, { fileName: string; source: string }>>>();

  for (const [key, source] of Object.entries(files)) {
    const path = relativeDocPath(key, prefix);
    const parts = path.split("/");
    if (parts.length !== 2) continue;
    const [folder, fileName] = parts;
    const match = fileName.match(FILE_NAME);
    if (!match) continue;
    const [, slug, lang = DEFAULT_LANGUAGE] = match;

    if (!tree.has(folder)) tree.set(folder, new Map());
    const pagesInFolder = tree.get(folder)!;
    if (!pagesInFolder.has(slug)) pagesInFolder.set(slug, {});
    pagesInFolder.get(slug)![lang] = { fileName, source };
  }

  const categoryMeta = new Map<string, CategoryMeta>();
  for (const [key, value] of Object.entries(categoryFiles)) {
    const folder = relativeDocPath(key, prefix).split("/")[0];
    if (value && typeof value === "object") categoryMeta.set(folder, value as CategoryMeta);
  }

  const categories: DocCategory[] = [];
  const pages: Record<string, DocPage> = {};

  const folders = [...tree.keys()].sort((a, b) => orderOf(a) - orderOf(b) || a.localeCompare(b));
  for (const folder of folders) {
    const meta = categoryMeta.get(folder);
    const category: DocCategory = {
      id: stripOrder(folder),
      title: categoryTitle(meta, folder, language),
      icon: meta?.icon ?? "book",
      items: [],
    };

    const entries = [...tree.get(folder)!.entries()]
      .map(([slug, variants]) => ({ slug, variants, english: variants[DEFAULT_LANGUAGE] ?? Object.values(variants)[0] }))
      .sort((a, b) => orderOf(a.english.fileName) - orderOf(b.english.fileName) || a.slug.localeCompare(b.slug));

    for (const { slug, variants } of entries) {
      if (pages[slug]) {
        console.warn(`[docs] Duplicate page slug "${slug}" in ${folder}; skipping it.`);
        continue;
      }
      const chosen = pickLanguage(variants, language)!;
      const { data, body } = parseFrontMatter(chosen.source);
      const page: DocPage = {
        slug,
        title: data.title || headingText(body.match(/^#\s+(.+)$/m)?.[1] ?? slug),
        description: data.description ?? "",
        badge: data.badge || undefined,
        body,
        headings: extractHeadings(body),
        categoryId: category.id,
        categoryTitle: category.title,
        sourcePath: `${folder}/${chosen.fileName}`,
      };
      pages[slug] = page;
      category.items.push(page);
    }

    if (category.items.length > 0) categories.push(category);
  }

  return { categories, pages, ordered: categories.flatMap((cat) => cat.items) };
}
