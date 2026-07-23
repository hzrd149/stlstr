import { castEvent, castUser, type EventCast, type User } from 'applesauce-common/casts';
import { castEventStream, castTimelineStream } from 'applesauce-common/observable';
import type { CastConstructor } from 'applesauce-core/casts';
import { EventStore } from 'applesauce-core/event-store';
import { createEventLoaderForStore } from 'applesauce-loaders/loaders';
import { RelayPool } from 'applesauce-relay';
import type { NostrEvent } from 'nostr-tools';

export const STLSTR_DEV_MODE = import.meta.env.DEV;
/**
 * The local relay dev builds read from. Overridable so the browser tests can stand up their
 * own fixture relay on a free port instead of fighting a running dev relay for 4869.
 */
export const STLSTR_DEV_RELAY = import.meta.env.VITE_STLSTR_DEV_RELAY || 'ws://localhost:4869';
export const STLSTR_DEV_BLOSSOM_SERVER = 'http://localhost:24242';

export const PRODUCTION_LOOKUP_RELAYS = ['wss://purplepag.es', 'wss://index.hzrd149.com'];
export const PRODUCTION_EXTRA_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
];
export const PRODUCTION_BLOSSOM_SERVERS = ['https://blossom.primal.net'];

export const NOSTR_LOOKUP_RELAYS = STLSTR_DEV_MODE ? [STLSTR_DEV_RELAY] : PRODUCTION_LOOKUP_RELAYS;
export const NOSTR_EXTRA_RELAYS = STLSTR_DEV_MODE ? [STLSTR_DEV_RELAY] : PRODUCTION_EXTRA_RELAYS;

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
