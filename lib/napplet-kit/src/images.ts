/**
 * Image loading through NAP-RESOURCE.
 *
 * A remote image URL is outside a napplet's authority boundary: pointing an `<img>` at one
 * would disclose the reader's IP to whatever host an untrusted author chose, and would
 * bypass the shell's content policy entirely. So every image — cover, thumbnail, avatar —
 * is fetched as bytes by the shell and turned into an object URL here.
 *
 * Loads are gated so a long list does not burst the shell with fetches.
 *
 * `napplets/print-detail/src/lib/images.ts` is an older copy of this and should be
 * migrated onto it once the napplet rename in flight has settled.
 */

import { resource } from '@napplet/sdk';
import { hasDomain } from './capabilities';

const MAX_IN_FLIGHT = 4;

let active = 0;
const waiting: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MAX_IN_FLIGHT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else active -= 1;
}

export function hasResource(): boolean {
  return hasDomain('resource');
}

/** One image from a printable's or make's ordered `imeta` gallery (NIP.md, NIP-92). */
export type PrintableImage = {
  url: string;
  alt: string;
  mime: string;
};

/** NIP-92 packs `key value` pairs across an `imeta` tag's values, in any order. */
function parseImeta(tag: string[]): PrintableImage | null {
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
 * The ordered image gallery from an event's tags. NIP.md is explicit that image `imeta`
 * tags ARE the gallery — clients must not wait for the URLs to also appear in `.content` —
 * and that the first one is the cover. This holds for both `kind:33500` printables and
 * `kind:2351` makes.
 */
export function parseImages(tags: string[][]): PrintableImage[] {
  return tags
    .filter((tag) => tag[0] === 'imeta')
    .map(parseImeta)
    .filter((image): image is PrintableImage => image !== null);
}

/**
 * Fetches an image and returns an object URL, or '' when it cannot be shown.
 *
 * Callers own the URL and MUST revoke it. A refusal is not surfaced as an error: the shell
 * can still reject unsupported or unsafe resources, and a list is usable without art.
 */
export async function loadImageUrl(url: string): Promise<string> {
  if (!url || !hasResource()) return '';

  await acquire();
  try {
    const blob = await resource.bytes(url);
    if (!blob.type.startsWith('image/')) return '';
    return URL.createObjectURL(blob);
  } catch {
    return '';
  } finally {
    release();
  }
}
