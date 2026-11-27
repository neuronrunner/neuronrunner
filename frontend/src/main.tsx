import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource-variable/geist";
import "@xterm/xterm/css/xterm.css";
import "./i18n";
import "./app/globals.css";
import App from "./App";

const CHUNK_RELOAD_KEY = "nr_chunk_reload_at";

function reloadOnceOnStaleChunk() {
  try {
    const last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) || "0");
    if (Date.now() - last < 15_000) return;
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  } catch {
    // ignore storage errors
  }
  window.location.reload();
}

window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  reloadOnceOnStaleChunk();
});

window.addEventListener("unhandledrejection", (event) => {
  const msg = String((event.reason as { message?: string } | null)?.message || event.reason || "");
  if (
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("Importing a module script failed") ||
    msg.includes("Loading chunk")
  ) {
    event.preventDefault();
    reloadOnceOnStaleChunk();
  }
});

createRoot(document.getElementById("root")!).render(<BrowserRouter><App /></BrowserRouter>);
document.documentElement.removeAttribute("data-hide-prerender");
