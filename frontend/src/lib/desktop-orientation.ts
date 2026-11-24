export type DesktopOrientation = "portrait" | "landscape";

export const DESKTOP_RESOLUTIONS: Record<DesktopOrientation, { width: number; height: number }> = {
  portrait: { width: 540, height: 960 },
  landscape: { width: 1920, height: 1080 },
};

export const MIN_DESKTOP_WIDTH = 320;
export const MAX_DESKTOP_WIDTH = 4096;
export const MIN_DESKTOP_HEIGHT = 200;
export const MAX_DESKTOP_HEIGHT = 2160;

/**
 * Pick a preset for the desktop panel. Narrow, tall panels (the normal
 * right-hand workspace pane) use portrait; fullscreen and wide panels use
 * landscape.
 */
export function desiredDesktopOrientation(width: number, height: number): DesktopOrientation {
  if (!width || !height) return "portrait";
  return width >= 1000 || width > height * 1.2 ? "landscape" : "portrait";
}

/**
 * Compute the exact VM desktop resolution that fills the panel cleanly.
 * Clamped to the backend's supported bounds and rounded to even integers
 * for X11/xrandr compatibility.
 */
export function desiredDesktopResolution(width: number, height: number): { width: number; height: number } {
  if (!width || !height) return DESKTOP_RESOLUTIONS.portrait;
  const even = (n: number) => Math.round(n / 2) * 2;
  return {
    width: Math.max(MIN_DESKTOP_WIDTH, Math.min(MAX_DESKTOP_WIDTH, even(width))),
    height: Math.max(MIN_DESKTOP_HEIGHT, Math.min(MAX_DESKTOP_HEIGHT, even(height))),
  };
}
