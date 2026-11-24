// Raw docs content from the repository's top-level `docs/` folder.
// The prerender script (scripts/prerender-pages.cjs) replaces this module with
// one that reads the same files from disk, using the same key format.

export const DOCS_GLOB_PREFIX = "../../../../docs/";

export const rawDocFiles = import.meta.glob("../../../../docs/*/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export const rawCategoryFiles = import.meta.glob("../../../../docs/*/_category.json", {
  import: "default",
  eager: true,
}) as Record<string, unknown>;
