import { NappletHandlersFactory } from 'applesauce-common/factories';
import { hasHiddenTags } from 'applesauce-core/helpers/hidden-tags';
import type { AddressPointer } from 'applesauce-core/helpers/pointers';
import type { NostrEvent } from 'nostr-tools';

/** A page choice covers its built-in intents without removing other clients' intents. */
export function preferenceDraft(
  archetype: string,
  identities: string[],
  existing?: NostrEvent,
  pointer?: AddressPointer,
) {
  let factory = existing
    ? NappletHandlersFactory.modify(existing)
    : NappletHandlersFactory.create(archetype);
  if (pointer) {
    for (const identity of identities) {
      factory = factory.removeIntentHandler(identity);
      if (existing && hasHiddenTags(existing))
        factory = factory.removeIntentHandler(identity, undefined, true);
      factory = factory.preferIntentHandler(identity, pointer);
    }
  } else {
    factory = factory.clear();
  }
  // Avoid replaceable-event ties when a user selects and resets within one second.
  return factory.created(Math.max(Math.floor(Date.now() / 1000), (existing?.created_at ?? 0) + 1));
}
