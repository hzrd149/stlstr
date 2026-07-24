import {
  createIntentService,
  type IntentAvailability,
  type IntentCandidate,
  type IntentRequest,
  type IntentResult,
} from '@kehto/services';
import type { ServiceHandler } from '@kehto/runtime';
import {
  ARCHETYPES,
  PREVIEW_ARCHETYPE,
  actionsFor,
  conventionsFor,
  intentToHref,
  normalizePrintablePayload,
  previewHref,
  type IntentPayload,
  type StlstrIntent,
} from './intent-map';
import { resolveConfiguredNapplet } from './napplets';

/**
 * NAP-INTENT lets a napplet hand a job to another napplet without knowing which one handles
 * it. In stlstr the shell owns routing, so an archetype resolves to a shell route rather
 * than a separate window: `intent.open('printable-detail', { address })` navigates the shell,
 * which mounts the handling napplet and delivers the payload (see `intent-delivery.ts`).
 *
 * This is a hand-written resolver rather than `createCatalogIntentResolver` because there is
 * no manifest catalog in dev — the `.nip5a-manifest.json` sidecar is only written when
 * `VITE_DEV_PRIVKEY_HEX` is set. The catalog is shaped so it can be swapped for
 * `manifestToIntentCatalogEntry` once deployed manifests exist.
 */

function asPayload(value: unknown): IntentPayload {
  if (!value || typeof value !== 'object') return {};

  const payload: IntentPayload = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') payload[key] = item;
  }
  return payload;
}

/**
 * Printable-addressing archetypes accept either `{ address }` or `{ pubkey, identifier }`;
 * normalize so everything downstream — href, delivery, napplet — sees one shape.
 */
function normalizePayload(archetype: string, payload: IntentPayload): IntentPayload | null {
  if (archetype !== 'printable-detail' && archetype !== 'printable-edit') return payload;
  return normalizePrintablePayload(payload);
}

function candidateFor(archetype: string): IntentCandidate {
  const entry = ARCHETYPES[archetype];
  const napplet = resolveConfiguredNapplet(archetype);
  return {
    dTag: napplet?.dTag ?? entry.dTag,
    title: napplet?.title ?? entry.title,
    actions: actionsFor(archetype),
    protocols: napplet?.protocols.length ? napplet.protocols : conventionsFor(archetype),
    isDefault: true,
  };
}

function availabilityFor(archetype: string): IntentAvailability {
  if (!ARCHETYPES[archetype]) {
    return { archetype, available: false, candidates: [], hasDefault: false };
  }
  return {
    archetype,
    available: true,
    candidates: [candidateFor(archetype)],
    hasDefault: true,
  };
}

/**
 * The href an intent navigates to.
 *
 * Most archetypes are pages, and `intentToHref` is a pure function of the payload. The
 * STL preview archetype is an *overlay*: it modifies whatever page the user is already on,
 * so its href is only definable relative to the current location. Reading `window.location`
 * here is deliberate — the router's browser history keeps it authoritative, and the
 * alternative is threading a router location through the adapter for a value we can read
 * directly.
 */
function hrefFor(intent: StlstrIntent): string | null {
  if (intent.archetype !== PREVIEW_ARCHETYPE) return intentToHref(intent);

  return previewHref(`${window.location.pathname}${window.location.search}`, intent.payload);
}

function failed(archetype: string, action: string, error: string): IntentResult {
  return { ok: false, archetype, action, handled: false, error };
}

export type IntentServiceOptions = {
  /**
   * Pushes a shell route. Only the href is handed over: the shell re-derives the intent
   * from the URL, so an in-app invocation and a pasted deep link cannot diverge.
   */
  navigate: (href: string) => void;
};

/** Creates the shell's NAP-INTENT handler. */
export function createStlstrIntentService({ navigate }: IntentServiceOptions): ServiceHandler {
  return createIntentService({
    resolver: {
      available: (archetype) => availabilityFor(archetype),

      handlers: () => Object.keys(ARCHETYPES).map(availabilityFor),

      invoke: (request: IntentRequest) => {
        const { archetype } = request;
        const action = request.action ?? 'open';
        const entry = ARCHETYPES[archetype];
        const napplet = resolveConfiguredNapplet(archetype);
        const handlerDTag = napplet?.dTag ?? entry?.dTag;

        if (!entry) return failed(archetype, action, `no handler for ${archetype}`);
        if (!(action in entry.intents)) {
          return failed(archetype, action, `${handlerDTag} does not support "${action}"`);
        }

        // The catalog is a fixed set of built-in napplets, so a caller-supplied handler dTag
        // can only ever name the one candidate. Honour it when it matches and reject
        // otherwise, rather than letting a napplet address some other handler.
        const preference = request.handler;
        if (
          typeof preference === 'string' &&
          preference !== 'default' &&
          preference !== 'choose' &&
          preference !== handlerDTag
        ) {
          return failed(archetype, action, `${preference} does not handle ${archetype}`);
        }

        const protocols = napplet?.protocols.length ? napplet.protocols : conventionsFor(archetype);
        if (request.protocol && !protocols.includes(request.protocol)) {
          return failed(archetype, action, `unsupported protocol ${request.protocol}`);
        }

        const payload = normalizePayload(archetype, asPayload(request.payload));
        if (!payload) return failed(archetype, action, 'payload is not a printable address');

        const intent: StlstrIntent = { archetype, action, payload };
        const href = hrefFor(intent);
        if (!href) {
          return failed(
            archetype,
            action,
            archetype === PREVIEW_ARCHETYPE
              ? 'payload does not name an STL URL to preview'
              : 'payload does not address a page',
          );
        }

        // Navigating unmounts the calling napplet's iframe. Defer it so this result is
        // posted first, otherwise the caller's `await intent.open(...)` never settles.
        // An overlay leaves the caller mounted and so does not strictly need this, but
        // both branches settle in the same order so no napplet learns to tell them apart.
        window.setTimeout(() => navigate(href), 0);

        return {
          ok: true,
          archetype,
          action,
          handled: true,
          handler: handlerDTag,
          windowId: `route-${entry.routeId}-${handlerDTag}`,
          protocol: request.protocol ?? protocols[0],
        };
      },
    },
  });
}
