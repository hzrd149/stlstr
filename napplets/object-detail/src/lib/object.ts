/**
 * Image parsing for a printable object (`kind:33500`, see NIP.md).
 */

export type ObjectImage = {
  url: string;
  alt: string;
  mime: string;
};

/** NIP-92 packs `key value` pairs across an `imeta` tag's values, in any order. */
function parseImeta(tag: string[]): ObjectImage | null {
  const fields: Record<string, string> = {};

  for (const entry of tag.slice(1)) {
    const separator = entry.indexOf(' ');
    if (separator < 1) continue;
    const key = entry.slice(0, separator);
    // First occurrence wins; NIP-92 does not define repeated keys within one tag.
    if (!(key in fields)) fields[key] = entry.slice(separator + 1).trim();
  }

  if (!fields.url) return null;
  return { url: fields.url, alt: fields.alt ?? '', mime: fields.m ?? '' };
}

/**
 * The object's ordered image gallery. NIP.md is explicit that image `imeta` tags ARE the
 * gallery — clients must not wait for the URLs to also appear in `.content` — and that the
 * first one is the cover.
 */
export function parseImages(tags: string[][]): ObjectImage[] {
  return tags
    .filter((tag) => tag[0] === 'imeta')
    .map(parseImeta)
    .filter((image): image is ObjectImage => image !== null);
}
