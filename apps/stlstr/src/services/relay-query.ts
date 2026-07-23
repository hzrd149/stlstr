/**
 * Shared one-shot relay reads.
 *
 * The read services (NAP-OUTBOX, NAP-COUNT) and the manifest loader all issue a request,
 * collect what comes back, and stop on EOSE or a timeout. This holds the two pieces that were
 * being copied between them: filter normalization and the request-to-array collection.
 */

import type { NostrFilter } from '@napplet/core';
import type { Filter } from 'applesauce-core/helpers/filter';
import type { NostrEvent } from 'nostr-tools';
import { eventStore, relayPool } from './nostr';

/** Callers may pass one filter or many; downstream code always wants an array. */
export function normalizeFilters(filters: NostrFilter | NostrFilter[]): NostrFilter[] {
  return Array.isArray(filters) ? filters : [filters];
}

/**
 * Runs a one-shot relay request and resolves with every event it collected.
 *
 * `RelayPool.request` completes on EOSE or its own `timeout`, but a relay that sends neither
 * would leave the promise pending; the `+250ms` backstop resolves with whatever arrived by
 * then. Events are added to the shared store as they land, so a later cast read is a cache hit
 * rather than another round trip. Errors reject — the caller decides whether that is fatal.
 */
export function collectRequest(
  relays: string[],
  filters: Filter[],
  timeoutMs: number,
): Promise<NostrEvent[]> {
  const events: NostrEvent[] = [];

  return new Promise((resolve, reject) => {
    const subscription = relayPool
      .request(relays, filters, { timeout: timeoutMs, eventStore })
      .subscribe({
        next: (event) => {
          eventStore.add(event);
          events.push(event);
        },
        error: reject,
        complete: () => resolve(events),
      });

    window.setTimeout(() => {
      subscription.unsubscribe();
      resolve(events);
    }, timeoutMs + 250);
  });
}
