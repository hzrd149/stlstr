/**
 * Parsing and collation for printables (`kind:33500`, see NIP.md).
 *
 * Kept free of SDK calls so it stays a pure data layer: events in, view models out.
 */

import type { NostrEvent } from '@napplet/sdk';
import { tagValue } from '@stlstr/napplet-kit/tags';

/** One image from an `imeta` tag. */
export type PrintableImage = {
  url: string;
  alt: string;
  mime: string;
};

/** A printable, reduced to what a result card needs. */
export type PrintableObject = {
  /** `33500:<pubkey>:<d>` — the address the printable-detail intent takes. */
  address: string;
  pubkey: string;
  identifier: string;
  title: string;
  summary: string;
  topics: string[];
  /** The first `imeta` tag, which NIP.md defines as the cover image. */
  cover: PrintableImage | null;
  createdAt: number;
};

export const PRINTABLE_KIND = 33500;

/**
 * Parses one `imeta` tag. NIP-92 packs fields as space-separated `key value` pairs across
 * the tag's values, so `url` may sit in any position.
 */
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
 * Converts an event into a card, or null when it is not a usable printable.
 *
 * `d` and `title` are the two required tags; without a title we would have to fall back to
 * raw identifiers, and showing hex to users is against the product rules in AGENTS.md.
 */
export function toPrintableObject(event: NostrEvent): PrintableObject | null {
  if (event.kind !== PRINTABLE_KIND) return null;

  const identifier = tagValue(event.tags, 'd');
  const title = tagValue(event.tags, 'title');
  if (!identifier || !title) return null;

  const cover = event.tags
    .filter((tag) => tag[0] === 'imeta')
    .map(parseImeta)
    .find((image): image is PrintableImage => image !== null);

  return {
    address: `${PRINTABLE_KIND}:${event.pubkey}:${identifier}`,
    pubkey: event.pubkey,
    identifier,
    title,
    summary: tagValue(event.tags, 'summary'),
    topics: [
      ...new Set(
        event.tags
          .filter((tag) => tag[0] === 't' && typeof tag[1] === 'string')
          .map((tag) => tag[1].trim().toLowerCase())
          .filter(Boolean),
      ),
    ],
    cover: cover ?? null,
    createdAt: event.created_at,
  };
}

/**
 * Folds a printable into an address-keyed collection, keeping the newest revision.
 *
 * Addressable events are replaceable, so the same address arrives repeatedly from
 * different relays; only the latest `created_at` is the printable.
 */
export function collectPrintable(
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

/** Newest first — the home page is a "recently published" feed. */
export function sortByNewest(printables: Iterable<PrintableObject>): PrintableObject[] {
  return [...printables].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Client-side post-filtering over what has streamed in. Relays get NIP-50 search and
 * NIP-91 `&t` filters too, but local filtering keeps results precise when a relay ignores
 * either extension and falls back to broader NIP-01 `#t` semantics.
 */
export function filterPrintables(
  printables: PrintableObject[],
  { query = '', topics = [] }: { query?: string; topics?: string[] },
): PrintableObject[] {
  const needle = query.trim().toLowerCase();
  const wanted = topics.map((topic) => topic.trim().toLowerCase()).filter(Boolean);

  return printables.filter((printable) => {
    if (wanted.some((topic) => !printable.topics.includes(topic))) return false;
    if (!needle) return true;
    return (
      printable.title.toLowerCase().includes(needle) ||
      printable.summary.toLowerCase().includes(needle) ||
      printable.topics.some((entry) => entry.includes(needle))
    );
  });
}
