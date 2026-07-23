import { intentTopic, readyTopic, type StlstrIntent } from './intent-map';

/**
 * intent-delivery.ts — hands an intent payload to the napplet that renders the route.
 *
 * NAP-INTENT has no inbound message: `IntentInboundMessage` is only the three `.result`
 * types plus `intent.changed`, so the handling napplet never learns its intent through the
 * intent domain. Delivery is out of band, and the channel is a targeted `inc.event` posted
 * straight at the napplet's iframe — the same seam hyprgate-gui uses.
 *
 * Two constraints make this work, both learned the hard way upstream:
 *
 * - **Targeted, never broadcast.** The runtime's inc fan-out reaches every subscriber on a
 *   topic. Posting directly to one `contentWindow` keeps one route's payload out of the next
 *   route's napplet.
 * - **Readiness handshake.** A freshly mounted napplet has not subscribed yet when the shell
 *   is ready to deliver, so the payload is buffered and flushed when the napplet emits its
 *   ready topic. Delivering eagerly loses the payload to the cold start.
 *
 * stlstr mounts exactly one napplet per route, so unlike hyprgate this needs no cross-window
 * buffer map — one pending payload per frame.
 */

export type IntentDelivery = {
  /** Buffers the intent for this frame. Call before assigning `iframe.srcdoc`. */
  seed(intent: StlstrIntent): void;
  /**
   * Hands a new intent to an already-mounted napplet, re-arming delivery. Safe to call
   * before the napplet has signalled readiness — the payload waits for the signal.
   */
  redeliver(intent: StlstrIntent): void;
  /**
   * Non-consuming observer for the shell's message listener. Returns true when the event
   * was this frame's ready signal; the caller MUST still pass the event to the bridge so
   * normal inc subscribers see it.
   */
  observeReady(event: MessageEvent): boolean;
  /** Drops buffered state when the frame unmounts. */
  dispose(): void;
};

export type IntentDeliveryOptions = {
  /** Resolves the target iframe's window, or null before it exists. */
  getTarget: () => Window | null;
};

type IncEmitMessage = { type?: unknown; topic?: unknown };

/** Strips anything a structured clone would reject, and drops non-string fields. */
function toCloneablePayload(payload: Record<string, unknown>): Record<string, string> {
  const plain: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') plain[key] = value;
  }
  return plain;
}

export function createIntentDelivery({ getTarget }: IntentDeliveryOptions): IntentDelivery {
  let pending: StlstrIntent | null = null;
  let ready = false;
  let delivered = false;
  /**
   * The archetype this frame hosts, remembered across flushes. A napplet emits its ready
   * topic exactly once, at mount — which may be *after* the first payload has already been
   * delivered and cleared `pending`. Reading the archetype from `pending` would then miss
   * the signal, and every later redelivery would wait for a signal that never comes again.
   */
  let archetype = '';

  function flush() {
    if (delivered || !ready || !pending) return;

    const target = getTarget();
    // The iframe is not registered yet; the next readiness signal retries.
    if (!target) return;

    target.postMessage(
      {
        type: 'inc.event',
        topic: intentTopic(pending.archetype, pending.action),
        payload: toCloneablePayload(pending.payload),
        sender: 'shell',
      },
      '*',
    );

    delivered = true;
    pending = null;
  }

  /**
   * Arms delivery with a payload. `ready` is deliberately NOT forced: a frame can be
   * mounted and still not be listening — the napplet subscribes and only then emits its
   * ready topic. Forcing it here posts into a napplet with no subscription and the
   * payload is lost, with `delivered` set so nothing retries.
   */
  function arm(intent: StlstrIntent) {
    pending = intent;
    archetype = intent.archetype;
    delivered = false;
    flush();
  }

  return {
    seed: arm,

    redeliver: arm,

    observeReady(event) {
      const target = getTarget();
      if (!target || event.source !== target) return false;

      const data = event.data as IncEmitMessage | null;
      if (!data || typeof data !== 'object' || data.type !== 'inc.emit') return false;
      if (!archetype || data.topic !== readyTopic(archetype)) return false;

      ready = true;
      flush();
      return true;
    },

    dispose() {
      pending = null;
      archetype = '';
      ready = false;
      delivered = false;
    },
  };
}
