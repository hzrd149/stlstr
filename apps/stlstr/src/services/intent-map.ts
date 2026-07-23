/**
 * intent-map.ts — the single source of truth for stlstr routing.
 *
 * A route is a materialized intent. `intentFromLocation` parses a URL into an
 * `{ archetype, action, payload }` request; `intentToHref` serializes one back. They are
 * inverses, so a pasted deep link and an in-app `intent.open` hand the handling napplet an
 * identical payload — a napplet that works when clicked into also works on refresh.
 */

/** An intent payload. Every field must survive a structured clone. */
export type IntentPayload = Record<string, string>;

/** A resolved intent: what to show, how, and with what. */
export type StlstrIntent = {
  archetype: string;
  action: string;
  payload: IntentPayload;
};

/** One archetype the shell can route to, and the napplet that fulfills it. */
export type ArchetypeEntry = {
  /** dTag of the napplet that handles this role. */
  dTag: string;
  /** Shell route id, used for the window id and for React keys. */
  routeId: string;
  /** Navigation group this archetype belongs to, when it is a top-level destination. */
  nav?: 'browse' | 'create' | 'settings';
  title: string;
  description: string;
  /** Verbs this archetype accepts. */
  actions: string[];
  /** Builds the shell href for a payload, or null when the payload cannot address a page. */
  toHref(payload: IntentPayload): string | null;
  /** Per-action title override, for pages that read differently by verb. */
  titleFor?(intent: StlstrIntent): string;
};

/**
 * Cross-napplet payload shapes are unnumbered conventions named
 * `napplet:<archetype>/<action>` (naps repo, `01-nap-system.md`). The same vocabulary is
 * used for manifest archetype tags and for the inc topics that carry the payload.
 */
export function conventionId(archetype: string, action: string): string {
  return `napplet:${archetype}/${action}`;
}

/**
 * The inc topic a napplet listens on for its intent payload, `<archetype>:<action>`.
 * This follows hyprgate-gui's `feed:open` shape verbatim; the convention id above names the
 * payload *shape* in the manifest, while this names the *channel* it arrives on.
 */
export function intentTopic(archetype: string, action: string): string {
  return `${archetype}:${action}`;
}

/** The inc topic a napplet emits once it is subscribed and ready to receive. */
export function readyTopic(archetype: string): string {
  return `${archetype}:ready`;
}

/** Address of a printable object: `33500:<pubkey>:<d>`. */
const OBJECT_KIND = '33500';

/**
 * The one archetype the shell renders as a centered dialog over the current page rather
 * than as a page of its own.
 *
 * NAP-INTENT cannot express this: `IntentBehavior` carries `focus` / `newWindow` / `reuse`
 * and nothing about presentation, so modal-versus-route is the shell's decision, taken from
 * the archetype. It is hardcoded to this one archetype deliberately — see
 * `.planning/preview-dialog.md` §9 for the trigger to generalize.
 */
export const PREVIEW_ARCHETYPE = 'part-preview';

/** Query param carrying the open overlay. Orthogonal to a route's own params. */
const PREVIEW_PARAM = 'preview';

/** A kind-1063 file event id. */
function isFileId(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function parseUrl(currentUrl: string): URL {
  // The base is a placeholder: only pathname and search are ever read back out.
  return new URL(currentUrl, 'http://shell.invalid');
}

function serializeUrl(url: URL): string {
  return `${url.pathname}${url.search}`;
}

/**
 * The overlay intent a URL carries, independent of the base route beneath it.
 *
 * This is the companion to `intentFromLocation`: together they are the `{ base, overlay }`
 * split of a location. `intentFromLocation` ignores `preview` entirely, so the two compose
 * without either needing to know about the other.
 */
export function overlayFromLocation(location: { search: string }): StlstrIntent | null {
  const fileId = new URLSearchParams(location.search).get(PREVIEW_PARAM)?.trim() ?? '';
  if (!isFileId(fileId)) return null;
  return { archetype: PREVIEW_ARCHETYPE, action: 'open', payload: { fileId } };
}

/** True when this href or query string carries an open preview. */
export function hasPreview(currentUrl: string): boolean {
  return Boolean(parseUrl(currentUrl).searchParams.get(PREVIEW_PARAM));
}

/** Opens the preview over the current page, preserving the path and its other params. */
export function previewHref(currentUrl: string, fileId: string): string | null {
  if (!isFileId(fileId)) return null;

  const url = parseUrl(currentUrl);
  url.searchParams.set(PREVIEW_PARAM, fileId);
  return serializeUrl(url);
}

/**
 * The page beneath the overlay. Used to dismiss a preview that was deep-linked into, where
 * there is no prior history entry to go back to.
 */
export function baseHref(currentUrl: string): string {
  const url = parseUrl(currentUrl);
  url.searchParams.delete(PREVIEW_PARAM);
  return serializeUrl(url);
}

function encodeAddressPath(address: string, suffix = ''): string | null {
  const [kind, pubkey, ...rest] = address.split(':');
  const identifier = rest.join(':');
  if (kind !== OBJECT_KIND || !pubkey || !identifier) return null;
  return `/objects/${encodeURIComponent(pubkey)}/${encodeURIComponent(identifier)}${suffix}`;
}

/**
 * Normalizes the two accepted object references into one `address` field so napplets
 * only ever parse a single shape.
 */
export function normalizeObjectPayload(payload: IntentPayload): IntentPayload | null {
  const address = payload.address?.trim();
  if (address) return encodeAddressPath(address) ? { address } : null;

  const pubkey = payload.pubkey?.trim();
  const identifier = (payload.identifier ?? payload.d)?.trim();
  if (pubkey && identifier) return { address: `${OBJECT_KIND}:${pubkey}:${identifier}` };
  return null;
}

export const ARCHETYPES: Record<string, ArchetypeEntry> = {
  'browse': {
    dTag: 'browse',
    routeId: 'browse',
    nav: 'browse',
    title: 'Browse objects',
    description: 'Find printable objects published as Nostr events.',
    actions: ['open'],
    toHref: (payload) => {
      const tag = payload.tag?.trim();
      if (tag) return `/tags/${encodeURIComponent(tag)}`;
      const query = payload.query?.trim();
      if (query) return `/search?q=${encodeURIComponent(query)}`;
      return '/';
    },
    titleFor: (intent) => {
      if (intent.payload.tag) return `#${intent.payload.tag}`;
      if (intent.payload.query) return `Search: ${intent.payload.query}`;
      return 'Browse objects';
    },
  },

  'user-profile': {
    dTag: 'user-profile',
    routeId: 'user-profile',
    title: 'Maker profile',
    description: 'View a maker, their published objects, and their collections.',
    actions: ['open'],
    toHref: (payload) => {
      const pubkey = payload.pubkey?.trim();
      return pubkey ? `/profiles/${encodeURIComponent(pubkey)}` : null;
    },
  },

  'object-detail': {
    dTag: 'object-detail',
    routeId: 'object-detail',
    title: 'Object details',
    description: 'View images, files, metadata, maker attribution, and object actions.',
    actions: ['open'],
    toHref: (payload) => {
      const normalized = normalizeObjectPayload(payload);
      return normalized ? encodeAddressPath(normalized.address) : null;
    },
  },

  'create-object': {
    dTag: 'create-object',
    routeId: 'create',
    nav: 'create',
    title: 'Create object',
    description: 'Publish a new 3D printable object with images and files.',
    actions: ['open', 'create'],
    toHref: (payload) => {
      const remixOf = payload.remixOf?.trim();
      if (!remixOf) return '/create';
      return `/create?remix=${encodeURIComponent(remixOf)}`;
    },
  },

  'part-preview': {
    dTag: 'part-preview',
    routeId: 'overlay-preview',
    title: 'Part preview',
    description: 'Inspect a printable part in 3D without leaving the page.',
    actions: ['open'],
    // An overlay modifies the current page rather than naming one of its own, so it has no
    // standalone href. `services/intent.ts` builds the URL from the ambient location.
    toHref: () => null,
  },

  'edit-object': {
    dTag: 'edit-object',
    routeId: 'object-edit',
    title: 'Edit object',
    description: 'Load an owned printable object and publish a replacement event.',
    actions: ['open', 'edit'],
    toHref: (payload) => {
      const normalized = normalizeObjectPayload(payload);
      return normalized ? encodeAddressPath(normalized.address, '/edit') : null;
    },
  },
};

/** Every convention id the shell can route, for manifest and capability reporting. */
export function conventionsFor(archetype: string): string[] {
  const entry = ARCHETYPES[archetype];
  return entry ? entry.actions.map((action) => conventionId(archetype, action)) : [];
}

/**
 * Serializes an intent to a shell href.
 *
 * Returns null when the archetype is unknown, the action is unsupported, or the payload
 * cannot address a page — the three cases NAP-INTENT reports as a failed invocation.
 */
export function intentToHref(intent: StlstrIntent): string | null {
  const entry = ARCHETYPES[intent.archetype];
  if (!entry || !entry.actions.includes(intent.action)) return null;
  return entry.toHref(intent.payload);
}

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname || '/';
}

function decodePart(value: string | undefined): string {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function intent(archetype: string, action: string, payload: IntentPayload = {}): StlstrIntent {
  return { archetype, action, payload };
}

/**
 * Parses a location into the intent it represents, or null for shell-native routes
 * (settings) and unknown paths.
 */
export function intentFromLocation(location: {
  pathname: string;
  search: string;
}): StlstrIntent | null {
  const path = normalizePath(location.pathname);
  const parts = path.split('/').filter(Boolean);
  const search = new URLSearchParams(location.search);

  if (path === '/') return intent('browse', 'open');

  if (path === '/search') {
    const query = search.get('q')?.trim() ?? '';
    return intent('browse', 'open', query ? { query } : {});
  }

  if (parts[0] === 'tags' && parts[1]) {
    return intent('browse', 'open', { tag: decodePart(parts[1]) });
  }

  if (path === '/create') {
    const remixOf = search.get('remix')?.trim() ?? '';
    return intent('create-object', 'open', remixOf ? { remixOf } : {});
  }

  if (parts[0] === 'profiles' && parts[1]) {
    return intent('user-profile', 'open', { pubkey: decodePart(parts[1]) });
  }

  if (parts[0] === 'objects' && parts[1] && parts[2]) {
    const address = `${OBJECT_KIND}:${decodePart(parts[1])}:${decodePart(parts[2])}`;
    if (parts[3] === 'edit') return intent('edit-object', 'edit', { address });
    if (parts.length === 3) return intent('object-detail', 'open', { address });
  }

  return null;
}
