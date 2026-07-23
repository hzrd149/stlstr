import { castEvent, castUser, type EventCast, type User } from 'applesauce-common/casts';
import { castEventStream, castTimelineStream } from 'applesauce-common/observable';
import type { CastConstructor } from 'applesauce-core/casts';
import { EventStore } from 'applesauce-core/event-store';
import { createEventLoaderForStore } from 'applesauce-loaders/loaders';
import { RelayPool } from 'applesauce-relay';
import type { NostrEvent } from 'nostr-tools';

export const NOSTR_LOOKUP_RELAYS = ['wss://purplepag.es', 'wss://index.hzrd149.com'];
export const NOSTR_EXTRA_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];

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
