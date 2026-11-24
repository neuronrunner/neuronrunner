import i18n from "@/i18n";

export interface ViewedImage {
  source: string;
  url: string;
}

export function viewedImages(result: unknown): ViewedImage[] {
  if (typeof result === "string") {
    try {
      result = JSON.parse(result);
    } catch {
      return [];
    }
  }
  if (!result || typeof result !== "object") return [];
  const value = result as Record<string, unknown>;
  const images = Array.isArray(value.images) ? value.images : [value];
  return images.flatMap(image => {
    if (!image || typeof image !== "object" || image.status !== "ok" || typeof image.image_url !== "string") return [];
    if (!/^(https?:\/\/|data:image\/)/i.test(image.image_url)) return [];
    return [{ source: typeof image.source === "string" ? image.source : i18n.t("chat:execution.viewImage"), url: image.image_url }];
  });
}
