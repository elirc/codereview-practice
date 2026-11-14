type Entry = { value: string; tags: string[] };

const entries = new Map<string, Entry>();

export const revalidatedTags: string[] = [];
export const revalidatedPaths: string[] = [];

/**
 * Tag-aware stand-in for `unstable_cache`. Results are JSON round-tripped like the real data
 * cache, so readers that return Dates or other non-JSON values fail the same way they would in Next.
 */
export function unstableCache<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  keyParts: string[] = [],
  options: { tags?: string[]; revalidate?: number | false } = {},
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const key = JSON.stringify([keyParts, args]);
    const hit = entries.get(key);
    if (hit) return JSON.parse(hit.value) as R;
    const value = JSON.stringify(await fn(...args));
    entries.set(key, { value, tags: options.tags ?? [] });
    return JSON.parse(value) as R;
  };
}

export function revalidateTag(tag: string): void {
  revalidatedTags.push(tag);
  for (const [key, entry] of entries) {
    if (entry.tags.includes(tag)) entries.delete(key);
  }
}

export function revalidatePath(path: string): void {
  revalidatedPaths.push(path);
}

export function clearRevalidations(): void {
  revalidatedTags.length = 0;
  revalidatedPaths.length = 0;
}

export function resetNextCache(): void {
  entries.clear();
  clearRevalidations();
}
