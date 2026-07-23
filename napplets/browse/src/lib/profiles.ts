/**
 * Maker names for feed cards.
 *
 * Cards must never show a raw pubkey (AGENTS.md), so an author whose `kind:0` has not
 * resolved yet is rendered as "Unknown maker" rather than hex.
 */

import { outbox } from '@napplet/sdk';

export type MakerProfile = {
  pubkey: string;
  name: string;
};

const MAX_AUTHORS_PER_QUERY = 100;

function parseName(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return '';
    const metadata = parsed as { name?: unknown; display_name?: unknown };
    const display = typeof metadata.display_name === 'string' ? metadata.display_name.trim() : '';
    const handle = typeof metadata.name === 'string' ? metadata.name.trim() : '';
    return display || handle;
  } catch {
    return '';
  }
}

/**
 * Resolves display names for a batch of authors.
 *
 * Authors with no readable profile are returned with an empty name so callers can cache
 * the miss and stop re-requesting them every time a new card streams in.
 */
export async function fetchMakers(pubkeys: string[]): Promise<MakerProfile[]> {
  const authors = [...new Set(pubkeys)].slice(0, MAX_AUTHORS_PER_QUERY);
  if (authors.length === 0) return [];

  const resolved = new Map(authors.map((pubkey) => [pubkey, { pubkey, name: '' }]));

  try {
    const { events } = await outbox.query([{ kinds: [0], authors }], { timeoutMs: 4000 });

    // Profiles are replaceable; relays may return several revisions of the same author.
    const newest = new Map<string, { created_at: number; content: string }>();
    for (const { event } of events) {
      const current = newest.get(event.pubkey);
      if (current && current.created_at >= event.created_at) continue;
      newest.set(event.pubkey, { created_at: event.created_at, content: event.content });
    }

    for (const [pubkey, event] of newest) {
      resolved.set(pubkey, { pubkey, name: parseName(event.content) });
    }
  } catch {
    // Names are decorative; a failed lookup leaves the cached misses in place.
  }

  return [...resolved.values()];
}
