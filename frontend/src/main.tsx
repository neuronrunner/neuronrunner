import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource-variable/geist";
import "@xterm/xterm/css/xterm.css";
import "./i18n";
import "./app/globals.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(<BrowserRouter><App /></BrowserRouter>);
document.documentElement.removeAttribute("data-hide-prerender");
