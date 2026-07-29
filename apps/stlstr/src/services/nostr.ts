import { castEvent, castUser, type EventCast, type User } from 'applesauce-common/casts';
import { castEventStream, castTimelineStream } from 'applesauce-common/observable';
import type { CastConstructor } from 'applesauce-core/casts';
import { EventStore } from 'applesauce-core/event-store';
import { createEventLoaderForStore } from 'applesauce-loaders/loaders';
import { RelayPool } from 'applesauce-relay';
import type { NostrEvent } from 'nostr-tools';

/** True for any dev-server build: enables the live napplet registry, no artifact caching, etc. */
export const STLSTR_DEV_MODE = import.meta.env.DEV;

/**
 * True only for `pnpm local`, which pins the shell to the local relay instead of the
 * production ones. `pnpm dev` is a dev build that talks to production.
 *
 * Gated on `DEV` as well so a production build can never be pointed at a local relay by a
 * stray environment variable.
 */
export const STLSTR_LOCAL_MODE = STLSTR_DEV_MODE && import.meta.env.VITE_STLSTR_LOCAL === '1';

/**
 * The local relay `pnpm local` reads from. Overridable so the browser tests can stand up their
 * own fixture relay on a free port instead of fighting a running dev relay for 4869.
 */
export const STLSTR_LOCAL_RELAY = import.meta.env.VITE_STLSTR_LOCAL_RELAY || 'ws://localhost:4869';

export const PRODUCTION_LOOKUP_RELAYS = ['wss://purplepag.es', 'wss://index.hzrd149.com'];
export const PRODUCTION_EXTRA_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
];
export const PRODUCTION_BLOSSOM_SERVERS = ['https://blossom.primal.net'];

export const NOSTR_LOOKUP_RELAYS = STLSTR_LOCAL_MODE
  ? [STLSTR_LOCAL_RELAY]
  : PRODUCTION_LOOKUP_RELAYS;
export const NOSTR_EXTRA_RELAYS = STLSTR_LOCAL_MODE
  ? [STLSTR_LOCAL_RELAY]
  : PRODUCTION_EXTRA_RELAYS;

export const eventStore = new EventStore();
export const relayPool = new RelayPool();

createEventLoaderForStore(eventStore, relayPool, {
  lookupRelays: NOSTR_LOOKUP_RELAYS,
  extraRelays: NOSTR_EXTRA_RELAYS,
});

export function getUser(pubkey: string): User {
  return castUser(pubkey, eventStore);
}

export function castStoredEvent<C extends EventCast<NostrEvent>>(
  event: NostrEvent,
  cast: CastConstructor<C>,
) {
  return castEvent(event, cast, eventStore);
}

export { castEventStream, castTimelineStream };
