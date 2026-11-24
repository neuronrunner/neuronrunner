export const customScrollbarCss = {
  scrollbarGutter: "stable",
  scrollbarWidth: "thin" as const,
  scrollbarColor: "color-mix(in srgb, var(--muted-foreground) 24%, transparent) transparent",
  "&::-webkit-scrollbar": {
    width: "5px",
    height: "5px",
  },
  "&::-webkit-scrollbar-track": {
    background: "transparent",
  },
  "&::-webkit-scrollbar-thumb": {
    background: "color-mix(in srgb, var(--muted-foreground) 22%, transparent)",
    borderRadius: "9999px",
    border: "1px solid transparent",
    backgroundClip: "content-box",
    transition: "background 0.15s ease",
  },
  "&:hover": {
    scrollbarColor: "color-mix(in srgb, var(--muted-foreground) 45%, transparent) transparent",
  },
  "&:hover::-webkit-scrollbar-thumb": {
    background: "color-mix(in srgb, var(--muted-foreground) 45%, transparent)",
    backgroundClip: "content-box",
  },
  "&:hover::-webkit-scrollbar-thumb:hover": {
    background: "color-mix(in srgb, var(--muted-foreground) 65%, transparent)",
  },
  "&::-webkit-scrollbar-thumb:active": {
    background: "color-mix(in srgb, var(--muted-foreground) 80%, transparent)",
  },
};
