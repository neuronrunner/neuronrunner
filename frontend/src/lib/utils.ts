import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatModelIdentifier(model?: string | null, tag?: string | null): string {
  if (!model) return "";
  let cleanModel = model.trim();
  if (cleanModel.includes(":")) {
    const parts = cleanModel.split(":");
    if (parts.length === 2 && parts[0] === parts[1]) {
      cleanModel = parts[0];
    }
  }
  const cleanTag = tag?.trim();
  if (!cleanTag || cleanTag === cleanModel || cleanModel.endsWith(`:${cleanTag}`)) {
    return cleanModel;
  }
  return `${cleanModel}:${cleanTag}`;
}
