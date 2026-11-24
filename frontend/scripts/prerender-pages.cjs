const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { MemoryRouter, Routes, Route } = require("react-router-dom");

const rootDir = path.resolve(__dirname, "..");
const srcDir = path.join(rootDir, "src");
const distDir = path.join(rootDir, "dist");
const DOCS_ENABLED = process.env.VITE_DOCS_ENABLED === "true";

const cache = new Map();

// The app reads docs with Vite's import.meta.glob; here the same files are read
// from the repository's docs/ folder, keyed the way the glob keys them.
const docsDir = path.resolve(rootDir, "..", "docs");
const docsSourceModule = path.join(srcDir, "app/docs/docs-source");

function loadDocsSourceFromDisk() {
  const prefix = "../../../../docs/";
  const rawDocFiles = {};
  const rawCategoryFiles = {};
  if (fs.existsSync(docsDir)) {
    for (const folder of fs.readdirSync(docsDir, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      for (const file of fs.readdirSync(path.join(docsDir, folder.name))) {
        const fullPath = path.join(docsDir, folder.name, file);
        const key = `${prefix}${folder.name}/${file}`;
        if (file.endsWith(".md")) rawDocFiles[key] = fs.readFileSync(fullPath, "utf8");
        else if (file === "_category.json") rawCategoryFiles[key] = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      }
    }
  }
  return { DOCS_GLOB_PREFIX: prefix, rawDocFiles, rawCategoryFiles };
}

function resolveSourceFile(targetPath) {
  const candidates = [
    targetPath,
    `${targetPath}.tsx`,
    `${targetPath}.ts`,
    `${targetPath}.json`,
    path.join(targetPath, "index.tsx"),
    path.join(targetPath, "index.ts"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  throw new Error(`Unable to resolve source file for: ${targetPath}`);
}

function loadTsModule(filename) {
  if (filename.replace(/\.ts$/, "") === docsSourceModule) {
    if (!cache.has(docsSourceModule)) cache.set(docsSourceModule, { exports: loadDocsSourceFromDisk() });
    return cache.get(docsSourceModule).exports;
  }
  const resolved = resolveSourceFile(filename);
  if (cache.has(resolved)) {
    return cache.get(resolved).exports;
  }
  if (resolved.endsWith(".json")) {
    const json = JSON.parse(fs.readFileSync(resolved, "utf8"));
    cache.set(resolved, { exports: json });
    return json;
  }

  const mod = new Module(resolved, module);
  mod.filename = resolved;
  mod.paths = Module._nodeModulePaths(path.dirname(resolved));
  cache.set(resolved, mod);

  mod.require = (id) => {
    if (id === "@/lib/env") {
      return {
        env: {
          API_URL: "https://api.neuronrunner.com",
          GOOGLE_CLIENT_ID: "",
          ENABLE_STUDIO: false,
          ENABLE_DOCS: DOCS_ENABLED,
        },
      };
    }
    if (id.endsWith(".css")) {
      return {};
    }
    if (id.startsWith("@/")) {
      return loadTsModule(path.join(srcDir, id.slice(2)));
    }
    if (id.startsWith("./") || id.startsWith("../")) {
      return loadTsModule(path.resolve(path.dirname(resolved), id));
    }
    return Module.prototype.require.call(mod, id);
  };

  let source = fs.readFileSync(resolved, "utf8");
  source = source.replace(/import\.meta\.env/g, "process.env");
  const { outputText } = ts.transpileModule(source, {
    fileName: resolved,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  });

  mod._compile(outputText, resolved);
  return mod.exports;
}

const templatePath = path.join(distDir, "index.html");
if (!fs.existsSync(templatePath)) {
  throw new Error(`Build template not found at ${templatePath}. Run "vite build" first.`);
}

const baseHtml = fs.readFileSync(templatePath, "utf8");

// Initialize i18n in English for static SEO pre-rendering
const i18n = loadTsModule(path.join(srcDir, "i18n/index.ts")).default;

// Load doc pages from the Markdown files in docs/, only when docs are enabled.
let ARTICLES_MAP = {};
if (DOCS_ENABLED) {
  const { getDocsIndex } = loadTsModule(path.join(srcDir, "app/docs/use-docs.ts"));
  ARTICLES_MAP = getDocsIndex("en").pages;
}

const pages = [
  {
    route: "/",
    entry: path.join(srcDir, "components/landing-page.tsx"),
    title: "Neuron Runner — Open-Source AI Agent Workspace with Docker Sandboxes",
    description:
      "Self-hosted AI development workspace with isolated Docker containers, interactive browser terminal, Monaco editor, Git/GitHub PR studio, BYOK, and MCP support.",
    outFiles: [path.join(distDir, "index.html")],
  },
  {
    route: "/integrations",
    entry: path.join(srcDir, "components/connectors/connectors-landing.tsx"),
    title: "Integrations & MCP Connectors — Neuron Runner",
    description:
      "Connect your AI agent to GitHub, Slack, Notion, Linear, Postgres, Supabase, and dozens of Model Context Protocol (MCP) servers.",
    outFiles: [
      path.join(distDir, "integrations.html"),
      path.join(distDir, "integrations", "index.html"),
    ],
  },
  {
    route: "/docs",
    entry: path.join(srcDir, "app/docs/client.tsx"),
    title: "Documentation — Neuron Runner",
    description:
      "Guides for installing, configuring and extending NeuronRunner, the open-source self-hosted AI coding workspace.",
    outFiles: [
      path.join(distDir, "docs.html"),
      path.join(distDir, "docs", "index.html"),
    ],
  },
  {
    route: "/terms-of-service",
    entry: path.join(srcDir, "app/terms-of-service/page.tsx"),
    title: "Terms of Service & Acceptable Use Policy — Neuron Runner",
    description:
      "Neuron Runner Terms of Service and Acceptable Use Policy. Strictly prohibits generating sexually explicit, adult, or NSFW content in general, CSAM, non-consensual imagery, and unlawful content.",
    outFiles: [
      path.join(distDir, "terms-of-service.html"),
      path.join(distDir, "terms-of-service", "index.html"),
    ],
  },
  {
    route: "/privacy-policy",
    entry: path.join(srcDir, "app/privacy-policy/page.tsx"),
    title: "Privacy Policy — Neuron Runner",
    description:
      "Neuron Runner Privacy Policy covering data collection, cloud Linux sandboxes, AI model privacy, BYOK credentials, and user rights.",
    outFiles: [
      path.join(distDir, "privacy-policy.html"),
      path.join(distDir, "privacy-policy", "index.html"),
    ],
  },
];

if (!DOCS_ENABLED) {
  const docsPageIndex = pages.findIndex((page) => page.route === "/docs");
  if (docsPageIndex !== -1) pages.splice(docsPageIndex, 1);
}

// Add every doc page to the pre-render queue when docs are enabled.
for (const [slug, article] of Object.entries(ARTICLES_MAP)) {
  const docDescription = article.description || "NeuronRunner documentation.";
  const docSchema = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TechArticle",
        headline: article.title,
        description: docDescription,
        url: `https://neuronrunner.com/docs/${slug}`,
        publisher: {
          "@type": "Organization",
          name: "Neuron Runner",
          url: "https://neuronrunner.com/",
        },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: "Documentation",
            item: "https://neuronrunner.com/docs",
          },
          {
            "@type": "ListItem",
            position: 2,
            name: article.title,
            item: `https://neuronrunner.com/docs/${slug}`,
          },
        ],
      },
    ],
  };

  pages.push({
    route: `/docs/${slug}`,
    entry: path.join(srcDir, "app/docs/client.tsx"),
    title: `${article.title} — Neuron Runner Docs`,
    description: docDescription,
    ogType: "article",
    jsonLd: docSchema,
    outFiles: [
      path.join(distDir, "docs", `${slug}.html`),
      path.join(distDir, "docs", slug, "index.html"),
    ],
  });
}

console.log(`Starting SEO pre-rendering for ${pages.length} public routes...`);

let successCount = 0;
for (const page of pages) {
  try {
    const Component = loadTsModule(page.entry).default;
    const markup = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        { initialEntries: [page.route] },
        page.route.startsWith("/docs/")
          ? // Route wrapper so useParams() sees the page's slug.
            React.createElement(
              Routes,
              null,
              React.createElement(Route, { path: "/docs/:slug", element: React.createElement(Component) })
            )
          : React.createElement(Component)
      )
    );

    const canonicalUrl = `https://neuronrunner.com${page.route === "/" ? "" : page.route}/`;

    let html = baseHtml
      .replace(/<title>[\s\S]*?<\/title>/i, `<title>${page.title}</title>`)
      .replace(
        /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i,
        `<meta name="description" content="${page.description}" />`
      )
      .replace(
        /<link\s+rel="canonical"\s+href="[^"]*"\s*\/?>/i,
        `<link rel="canonical" href="${canonicalUrl}" />`
      )
      .replace(
        /<meta\s+property="og:title"\s+content="[^"]*"\s*\/?>/i,
        `<meta property="og:title" content="${page.title}" />`
      )
      .replace(
        /<meta\s+property="og:description"\s+content="[^"]*"\s*\/?>/i,
        `<meta property="og:description" content="${page.description}" />`
      )
      .replace(
        /<meta\s+property="og:url"\s+content="[^"]*"\s*\/?>/i,
        `<meta property="og:url" content="${canonicalUrl}" />`
      )
      .replace(
        /<meta\s+property="og:type"\s+content="[^"]*"\s*\/?>/i,
        `<meta property="og:type" content="${page.ogType || "website"}" />`
      )
      .replace(
        /<meta\s+name="twitter:title"\s+content="[^"]*"\s*\/?>/i,
        `<meta name="twitter:title" content="${page.title}" />`
      )
      .replace(
        /<meta\s+name="twitter:description"\s+content="[^"]*"\s*\/?>/i,
        `<meta name="twitter:description" content="${page.description}" />`
      );

    if (page.jsonLd) {
      const jsonLdTag = `\n    <script type="application/ld+json">\n    ${JSON.stringify(page.jsonLd, null, 2)}\n    </script>\n  </head>`;
      html = html.replace("</head>", jsonLdTag);
    }

    html = html.replace('<div id="root"></div>', `<div id="root">${markup}</div>`);

    for (const outFile of page.outFiles) {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, html, "utf8");
    }

    successCount++;
    console.log(`✓ Pre-rendered ${page.route} (${(markup.length / 1024).toFixed(1)} KB)`);
  } catch (err) {
    console.error(`✗ Failed to pre-render ${page.route}:`, err.message);
  }
}

console.log(`Successfully pre-rendered ${successCount}/${pages.length} pages for production SEO!`);

if (!DOCS_ENABLED) {
  // Keep the docs source intact for the CLI launch, but keep docs out of the
  // deployed build: no sitemap entries, no crawling, and redirect direct hits.
  const sitemapPath = path.join(distDir, "sitemap.xml");
  if (fs.existsSync(sitemapPath)) {
    const sitemap = fs.readFileSync(sitemapPath, "utf8")
      .replace(/\s*<!-- Documentation Overview -->/g, "")
      .replace(/\s*<!-- Documentation Articles -->/g, "")
      .replace(/\s*<url>\s*<loc>https:\/\/neuronrunner\.com\/docs[^<]*<\/loc>[\s\S]*?<\/url>/g, "");
    fs.writeFileSync(sitemapPath, sitemap);
  }

  const robotsPath = path.join(distDir, "robots.txt");
  if (fs.existsSync(robotsPath)) {
    let robots = fs.readFileSync(robotsPath, "utf8");
    if (!robots.includes("Disallow: /docs/")) {
      robots = robots.replace(/Sitemap:/, "Disallow: /docs/\n\nSitemap:");
      fs.writeFileSync(robotsPath, robots);
    }
  }

  const redirectsPath = path.join(distDir, "_redirects");
  let redirects = fs.existsSync(redirectsPath) ? fs.readFileSync(redirectsPath, "utf8").trimEnd() : "";
  if (!redirects.split("\n").some((line) => line.startsWith("/docs "))) {
    redirects += `${redirects ? "\n" : ""}/docs / 302\n/docs/* / 302\n`;
    fs.writeFileSync(redirectsPath, redirects);
  }

  console.log("Docs are disabled: removed docs pages from sitemap, added robots rules and redirects.");
}
