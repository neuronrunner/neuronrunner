# NeuronRunner Docs

This folder is the source of the documentation shown at `/docs` in the NeuronRunner web app.
Every page is a plain Markdown file, so you can read the docs right here on GitHub, too.

## Layout

```text
docs/
├── 01-getting-started/        # one folder per sidebar category
│   ├── _category.json         # category title (per language) and icon
│   ├── 01-introduction.md     # one file per page
│   └── 01-introduction.tr.md  # optional translation of that page
└── ...
```

- **Order** comes from the number prefix on folders and files (`01-`, `02-`, ...).
- **Page URL** is the file name without the number prefix and extension:
  `02-quickstart.md` is served at `/docs/quickstart`. Slugs must be unique across all folders.
- **Translations** sit next to the English file with the language code before `.md`
  (`02-quickstart.tr.md`). When a translation is missing, the English page is shown.
- Files outside a numbered category folder (like this README) are not shown in the app.

## Front matter

Each page starts with a small front matter block:

```markdown
---
title: Quickstart
description: Run NeuronRunner locally with Docker Compose in a few minutes.
badge: 5 min        # optional, small label next to the title
---
```

`_category.json` looks like this:

```json
{ "title": { "en": "Getting Started", "tr": "Başlarken" }, "icon": "book" }
```

Available icons: `book`, `server`, `zap`, `plug`, `git`, `terminal`, `shield`, `layers`.

## Writing

- Use `##` for sections; they appear in the "On this page" list. `###` and below are fine for sub-sections.
- Link to other pages with relative Markdown links such as `[Configuration](../02-self-hosting/01-configuration.md)`.
  They work on GitHub and are rewritten to `/docs/...` in the app.
- Callouts use GitHub's alert syntax:

  ```markdown
  > [!TIP]
  > Build the sandbox image first for a faster start.
  ```

  Supported types: `NOTE`, `TIP`, `IMPORTANT`, `WARNING`, `CAUTION`.
- Tables, task lists and fenced code blocks (with a language) are supported.

## Previewing

```bash
cd frontend
VITE_DOCS_ENABLED=true npm run dev
```

Then open http://localhost:3000/docs. The page reloads when you save a Markdown file.
