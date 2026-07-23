/**
 * Parsing and collation for printable objects (`kind:33500`, see NIP.md).
 *
 * Kept free of SDK calls so it stays a pure data layer: events in, view models out.
 */

import type { NostrEvent } from '@napplet/sdk';
import { tagValue } from '@stlstr/napplet-kit/tags';

/** One image from an `imeta` tag. */
export type ObjectImage = {
  url: string;
  alt: string;
  mime: string;
};

/** A printable object, reduced to what a result card needs. */
export type PrintableObject = {
  /** `33500:<pubkey>:<d>` — the address the printable-detail intent takes. */
  address: string;
  pubkey: string;
  identifier: string;
  title: string;
  summary: string;
  /** The first `imeta` tag, which NIP.md defines as the cover image. */
  cover: ObjectImage | null;
  createdAt: number;
};

export const OBJECT_KIND = 33500;

/**
 * Parses one `imeta` tag. NIP-92 packs fields as space-separated `key value` pairs across
 * the tag's values, so `url` may sit in any position.
 */
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
 * Converts an event into a card, or null when it is not a usable object.
 *
 * `d` and `title` are the two required tags; without a title we would have to fall back to
 * raw identifiers, and showing hex to users is against the product rules in AGENTS.md.
 */
export function toPrintableObject(event: NostrEvent): PrintableObject | null {
  if (event.kind !== OBJECT_KIND) return null;

  const identifier = tagValue(event.tags, 'd');
  const title = tagValue(event.tags, 'title');
  if (!identifier || !title) return null;

  const cover = event.tags
    .filter((tag) => tag[0] === 'imeta')
    .map(parseImeta)
    .find((image): image is ObjectImage => image !== null);

  return {
    address: `${OBJECT_KIND}:${event.pubkey}:${identifier}`,
    pubkey: event.pubkey,
    identifier,
    title,
    summary: tagValue(event.tags, 'summary'),
    cover: cover ?? null,
    createdAt: event.created_at,
  };
}

/**
 * Folds an object into an address-keyed collection, keeping the newest revision.
 *
 * Addressable events are replaceable, so the same address arrives repeatedly from
 * different relays; only the latest `created_at` is the object.
 */
export function collectObject(
  known: Map<string, PrintableObject>,
  next: PrintableObject,
): Map<string, PrintableObject> {
  const current = known.get(next.address);
  if (current && current.createdAt >= next.createdAt) return known;

  // A new Map identity is what makes Svelte's `$state` see the change.
  const merged = new Map(known);
  merged.set(next.address, next);
  return merged;
}

/** Newest first — a maker's page reads as "what they published most recently". */
export function sortByNewest(objects: Iterable<PrintableObject>): PrintableObject[] {
  return [...objects].sort((a, b) => b.createdAt - a.createdAt);
}
