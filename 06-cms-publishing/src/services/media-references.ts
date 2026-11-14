export const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Media ids a revision refers to: its cover plus every `media:<uuid>` in the body, de-duplicated. */
export function extractMediaIds(body: string, coverMediaId: string | null): string[] {
  const ids = new Set<string>();
  if (coverMediaId) ids.add(coverMediaId.toLowerCase());
  for (const match of body.matchAll(new RegExp(`media:(${UUID_SOURCE})`, "gi"))) {
    ids.add(match[1].toLowerCase());
  }
  return [...ids];
}
