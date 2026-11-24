export interface ImageViewport {
  width: number;
  height: number;
  pixelRatio: number;
  left: number;
  top: number;
}

export function imagePreviewLayout(
  image: { width: number; height: number },
  viewport: ImageViewport,
  zoom: number | "fit",
) {
  const ratio = Math.max(0.1, viewport.pixelRatio);
  const fitScale = image.width && image.height
    ? Math.min(Math.max(1, viewport.width - 48) * ratio / image.width, Math.max(1, viewport.height - 48) * ratio / image.height, 1)
    : 1;
  const scale = zoom === "fit" ? fitScale : zoom;
  // At 100%, each source pixel occupies one display pixel, including on HiDPI screens.
  const width = Math.floor(image.width * scale) / ratio;
  const height = Math.floor(image.height * scale) / ratio;
  const snap = (offset: number, origin: number) => Math.round((origin + offset) * ratio) / ratio - origin;
  return {
    scale, width, height,
    canvasWidth: Math.max(viewport.width, width + 48),
    canvasHeight: Math.max(viewport.height, height + 48),
    left: snap(Math.max(24, (viewport.width - width) / 2), viewport.left),
    top: snap(Math.max(24, (viewport.height - height) / 2), viewport.top),
  };
}
