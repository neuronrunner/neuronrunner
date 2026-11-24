/** Public configuration is compiled into the static frontend at build time. */
export const env = {
  API_URL: (import.meta.env.VITE_API_URL || "http://localhost:8000").replace(/\/+$/, ""),
  GOOGLE_CLIENT_ID: import.meta.env.VITE_GOOGLE_CLIENT_ID || "",
  TURNSTILE_SITE_KEY: import.meta.env.VITE_TURNSTILE_SITE_KEY || "",
  ENABLE_STUDIO: import.meta.env.VITE_ENABLE_STUDIO === "true",
  ENABLE_DOCS: import.meta.env.VITE_DOCS_ENABLED === "true",
};
