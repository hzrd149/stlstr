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
  intentToHref,
  isAdvertised,
  normalizePrintablePayload,
  previewHref,
  type IntentNavigation,
  type IntentPayload,
  type StlstrIntent,
} from './intent-map';
import { catalogIdFor, resolveConfiguredNapplet, type ResolvedNapplet } from './napplets';
import { subscribeToNappletPreferences } from './napplet-preferences';
import { subscribeToSettings } from './settings';

/**
 * NAP-INTENT lets a napplet hand a job to another napplet without knowing which one handles
 * it. In stlstr the shell owns routing, so an archetype resolves to a shell route rather
 * than a separate window: `intent.open('napplet:printable-detail/open', { payload })`
 * navigates the shell, which mounts the handling napplet and delivers an `IntentDelivery`
 * to it (see `intent-delivery.ts`).
 *
 * Each archetype has exactly one candidate — the napplet the user configured for it, or the
 * built-in default — identified by its opaque manifest catalog id. This is a hand-written
 * resolver rather than `createCatalogIntentResolver` because acceptance is a navigation, and
 * the route, not the resolver, mounts the target and delivers to it.
 */

/** NAP-INTENT's common error strings. Detail goes to the console, not to the caller. */
type IntentError = 'no handler' | 'unsupported convention' | 'invoke rejected';

function failed(error: IntentError, detail: string): IntentResult {
  console.warn(`[stlstr] intent ${error}: ${detail}`);
  return { ok: false, error };
}

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
  if (!['printable-detail', 'printable-edit', 'make-create'].includes(archetype)) return payload;
  return normalizePrintablePayload(payload);
}

/**
 * The napplet that would handle this archetype, when the shell advertises it. Conventions
 * come from the napplet's own manifest when one is loaded, so a user-chosen napplet is only
 * offered for the verbs it actually declares.
 */
function handlerFor(archetype: string, action = 'open'): ResolvedNapplet | null {
  if (!isAdvertised(archetype)) return null;
  return resolveConfiguredNapplet(archetype, action);
}

async function candidateFor(archetype: string): Promise<IntentCandidate | null> {
  const napplet = handlerFor(archetype);
  if (!napplet) return null;

  let id: string;
  try {
    id = await catalogIdFor(napplet);
  } catch (error) {
    console.warn(`[stlstr] ${archetype} handler is unavailable`, error);
    return null;
  }

  const conventions = napplet.conventions;
  return {
    id,
    title: napplet.title,
    actions: actionsFor(archetype).filter((action) =>
      conventions.includes(`napplet:${archetype}/${action}`),
    ),
    conventions,
    contracts: [],
    isDefault: true,
  };
}

async function availabilityFor(archetype: string): Promise<IntentAvailability> {
  const candidate = await candidateFor(archetype);
  return candidate
    ? { archetype, available: true, candidates: [candidate], hasDefault: true }
    : { archetype, available: false, candidates: [], hasDefault: false };
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

export type IntentServiceOptions = {
  /**
   * Pushes a shell route. The href carries the payload; `navigation` carries the verb and
   * the attested sender, which the shell keeps in history state so the route can deliver
   * them to the target.
   */
  navigate: (href: string, navigation: IntentNavigation) => void;
  resolveSender: (windowId: string) => string | undefined;
};

/** Creates the shell's NAP-INTENT handler. */
export function createStlstrIntentService({
  navigate,
  resolveSender,
}: IntentServiceOptions): ServiceHandler {
  return createIntentService({
    resolveSender,
    resolver: {
      available: (archetype) => availabilityFor(archetype),

      handlers: async () => {
        const all = await Promise.all(
          Object.keys(ARCHETYPES).filter(isAdvertised).map(availabilityFor),
        );
        return all.filter((entry) => entry.available);
      },

      // A changed napplet choice changes which candidate (and catalog id) answers.
      onChanged: (listener) => {
        const publish = () => {
          for (const archetype of Object.keys(ARCHETYPES).filter(isAdvertised)) {
            void availabilityFor(archetype).then(listener);
          }
        };
        const stopSettings = subscribeToSettings(publish);
        const stopPreferences = subscribeToNappletPreferences(publish);
        return () => {
          stopSettings();
          stopPreferences();
        };
      },

      invoke: async (request: IntentRequest, { sender }) => {
        // `createIntentService` has already checked that `convention` is
        // `napplet:<archetype>/<action>` and that the sender is attested.
        const { archetype, action, convention } = request;
        const entry = ARCHETYPES[archetype];
        const napplet = handlerFor(archetype, action);
        if (!entry || !napplet) return failed('no handler', `nothing handles ${archetype}`);

        if (!(action in entry.intents) || !napplet.conventions.includes(convention)) {
          return failed('unsupported convention', `${napplet.title} does not accept ${convention}`);
        }

        let handler: string;
        try {
          handler = await catalogIdFor(napplet);
        } catch (error) {
          return failed('no handler', `${napplet.title} could not be resolved: ${String(error)}`);
        }

        // One candidate per archetype, so `default` and `choose` both select it. An explicit
        // catalog id must name that candidate — a napplet cannot address some other handler.
        const preference = request.handler;
        if (preference !== undefined && preference !== 'default' && preference !== 'choose') {
          if (preference !== handler) {
            return failed('invoke rejected', `${preference} does not handle ${archetype}`);
          }
        }

        const payload = normalizePayload(archetype, asPayload(request.payload));
        if (!payload) return failed('invoke rejected', `payload is not a printable address`);

        const href = hrefFor({ archetype, action, payload });
        if (!href) {
          return failed(
            'invoke rejected',
            archetype === PREVIEW_ARCHETYPE
              ? 'payload does not name an STL URL to preview'
              : `payload does not address a ${archetype} page`,
          );
        }

        // Navigating unmounts the calling napplet's iframe. Defer it so this result is
        // posted first, otherwise the caller's `await intent.open(...)` never settles.
        // An overlay leaves the caller mounted and so does not strictly need this, but
        // both branches settle in the same order so no napplet learns to tell them apart.
        window.setTimeout(() => navigate(href, { archetype, action, sender }), 0);

        return { ok: true, archetype, action, convention, handler };
      },
    },
  });
}
