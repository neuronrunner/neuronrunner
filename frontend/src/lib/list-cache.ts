/**
 * Last good result per list view (issues, pull requests, their counts).
 *
 * Pages paint from here the moment they mount and then refresh in the background, so moving between
 * pages never shows a loading placeholder for data we already have. Lives for the browser session only.
 */
const MAX_ENTRIES = 100;
const cache = new Map<string, unknown>();

export function readListCache<T>(key: string | null | undefined): T | undefined {
  return key ? (cache.get(key) as T | undefined) : undefined;
}

export function writeListCache<T>(key: string | null | undefined, value: T): void {
  if (!key) return;
  cache.delete(key); // re-insert so the oldest entry is always first
  cache.set(key, value);
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export function clearListCache(): void {
  cache.clear();
}
