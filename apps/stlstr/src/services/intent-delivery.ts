import { conventionId, SHELL_SENDER, type StlstrIntent } from './intent-map';

/**
 * intent-delivery.ts — hands an intent to the napplet that renders the route.
 *
 * Delivery is native NAP-INTENT: the shell posts `intent.deliver` with an `IntentDelivery`
 * (`sender`, `archetype`, `action`, `convention`, `payload`) on the target frame's bound Kehto
 * MessagePort, and the napplet receives it through `intent.onDelivery`.
 *
 * Two rules from the spec shape this:
 *
 * - **Targeted, never broadcast.** Each frame owns its delivery and sends only on its own
 *   port, so a payload never reaches any napplet other than the resolved target.
 * - **Only after the target is ready.** The port exists once the frame finishes the shell
 *   handshake, which the host observes as `shell.ready` and reports through `markReady`.
 *   Kehto's runtime binding then retains the delivery until the napplet registers its
 *   `onDelivery` handler, so no application-level readiness signal is needed.
 */

export type IntentDelivery = {
  /** Buffers the intent for this frame. Call before assigning `iframe.srcdoc`. */
  seed(intent: StlstrIntent): void;
  /**
   * Hands a new intent to an already-mounted napplet. Safe to call before the frame is
   * ready — the delivery waits for `markReady`.
   */
  redeliver(intent: StlstrIntent): void;
  /** The frame completed the shell handshake; flushes any buffered delivery. */
  markReady(): void;
  /** Drops buffered state when the frame unmounts. */
  dispose(): void;
};

export type IntentDeliveryOptions = {
  /** Sends one envelope on the frame's bound port. */
  send: (message: unknown) => void;
};

/** Strips anything a structured clone would reject, and drops non-string fields. */
function toCloneablePayload(payload: Record<string, unknown>): Record<string, string> {
  const plain: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') plain[key] = value;
  }
  return plain;
}

/** The `intent.deliver` envelope for an intent. */
export function deliveryMessage(intent: StlstrIntent) {
  return {
    type: 'intent.deliver',
    delivery: {
      sender: intent.sender ?? SHELL_SENDER,
      archetype: intent.archetype,
      action: intent.action,
      convention: conventionId(intent.archetype, intent.action),
      payload: toCloneablePayload(intent.payload),
    },
  };
}

export function createIntentDelivery({ send }: IntentDeliveryOptions): IntentDelivery {
  let pending: StlstrIntent | null = null;
  let ready = false;

  function flush() {
    if (!ready || !pending) return;
    send(deliveryMessage(pending));
    pending = null;
  }

  function arm(intent: StlstrIntent) {
    pending = intent;
    flush();
  }

  return {
    seed: arm,
    redeliver: arm,
    markReady() {
      ready = true;
      flush();
    },
    dispose() {
      pending = null;
      ready = false;
    },
  };
}
