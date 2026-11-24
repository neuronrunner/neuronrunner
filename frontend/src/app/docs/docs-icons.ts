import type React from "react";
import {
  LuBookOpen,
  LuServer,
  LuZap,
  LuPlug,
  LuGitPullRequest,
  LuTerminal,
  LuShieldCheck,
  LuLayers,
} from "react-icons/lu";

/** Icons usable in a docs folder's `_category.json` (`"icon": "server"`). */
const CATEGORY_ICONS: Record<string, React.ElementType> = {
  book: LuBookOpen,
  server: LuServer,
  zap: LuZap,
  plug: LuPlug,
  git: LuGitPullRequest,
  terminal: LuTerminal,
  shield: LuShieldCheck,
  layers: LuLayers,
};

export function categoryIcon(name: string): React.ElementType {
  return CATEGORY_ICONS[name] ?? LuBookOpen;
}
