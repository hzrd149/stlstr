/**
 * Receiving NAP-INTENT deliveries.
 *
 * The shell routes `intent.open('napplet:<archetype>/<action>', { payload })` to the napplet
 * that handles the archetype and hands it an `IntentDelivery` through `intent.onDelivery`.
 * The runtime buffers a delivery until a handler registers, so there is no readiness handshake
 * to perform: register once at mount and every delivery — the first and any later redelivery —
 * arrives through the same callback.
 *
 * `sender` is attested by the shell (a catalog id, or `shell` for a deep link); treat it as
 * provenance, never as identity. The payload is untrusted input and every handler must
 * validate the fields it reads.
 */
import { intent, type IntentDelivery } from '@napplet/sdk';
import { hasMethods } from './capabilities';

export type { IntentDelivery };

/** A delivered payload reduced to its text fields — the only shape stlstr conventions use. */
export type IntentPayload = Record<string, string>;

/** Handle returned by `onIntent`. Released with `close()`, like every SDK subscription. */
export type IntentSubscription = { close(): void };

/** One handler per action this napplet accepts for its archetype. */
export type IntentHandlers = Partial<
  Record<string, (payload: IntentPayload, delivery: IntentDelivery) => void>
>;

/** True when the shell can deliver intents to this napplet. */
export function canReceiveIntents(): boolean {
  return hasMethods('intent', 'onDelivery');
}

function textFields(payload: unknown): IntentPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};

  const fields: IntentPayload = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof value === 'string') fields[key] = value;
  }
  return fields;
}

/**
 * Subscribes to deliveries for one archetype. A delivery is dispatched only when its
 * convention is exactly `napplet:<archetype>/<action>` for an action listed in `handlers`;
 * anything else is ignored. Returns null when the shell cannot deliver intents.
 */
export function onIntent(archetype: string, handlers: IntentHandlers): IntentSubscription | null {
  if (!canReceiveIntents()) return null;

  return intent.onDelivery((delivery) => {
    if (delivery.archetype !== archetype) return;
    if (delivery.convention !== `napplet:${archetype}/${delivery.action}`) return;

    const handler = handlers[delivery.action];
    handler?.(textFields(delivery.payload), delivery);
  });
}
