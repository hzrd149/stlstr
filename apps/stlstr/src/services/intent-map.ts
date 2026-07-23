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
  nav?: 'browse' | 'create' | 'parts' | 'settings';
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
export const PREVIEW_ARCHETYPE = 'stl-preview';

/** Query param carrying the open overlay. Orthogonal to a route's own params. */
const PREVIEW_PARAM = 'stl';

/** A kind-1063 file event id. */
function isFileId(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function isPreviewPayload(payload: IntentPayload): boolean {
  return Boolean(payload.url?.trim());
}

function encodePreviewPayload(payload: IntentPayload): string {
  return encodeURIComponent(JSON.stringify(payload));
}

function decodePreviewPayload(value: string): IntentPayload | null {
  try {
    const decoded = JSON.parse(decodeURIComponent(value)) as unknown;
    if (!decoded || typeof decoded !== 'object') return null;

    const payload: IntentPayload = {};
    for (const [key, item] of Object.entries(decoded as Record<string, unknown>)) {
      if (typeof item === 'string') payload[key] = item;
    }
    return isPreviewPayload(payload) ? payload : null;
  } catch {
    return null;
  }
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
  const raw = new URLSearchParams(location.search).get(PREVIEW_PARAM)?.trim() ?? '';
  if (!raw) return null;

  const payload = decodePreviewPayload(raw);
  return payload ? { archetype: PREVIEW_ARCHETYPE, action: 'open', payload } : null;
}

/** True when this href or query string carries an open preview. */
export function hasPreview(currentUrl: string): boolean {
  return Boolean(parseUrl(currentUrl).searchParams.get(PREVIEW_PARAM));
}

/** Opens the preview over the current page, preserving the path and its other params. */
export function previewHref(currentUrl: string, payload: IntentPayload): string | null {
  if (!isPreviewPayload(payload)) return null;

  const url = parseUrl(currentUrl);
  url.searchParams.set(PREVIEW_PARAM, encodePreviewPayload(payload));
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
  'printable-browse': {
    dTag: 'print-browse',
    routeId: 'browse',
    nav: 'browse',
    title: 'Browse prints',
    description: 'Find printable models published as Nostr events.',
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
      return 'Browse prints';
    },
  },

  profile: {
    dTag: 'user-profile',
    routeId: 'user-profile',
    title: 'Maker profile',
    description: 'View a maker, their published prints, and their collections.',
    actions: ['open'],
    toHref: (payload) => {
      const pubkey = payload.pubkey?.trim();
      return pubkey ? `/profiles/${encodeURIComponent(pubkey)}` : null;
    },
  },

  'printable-detail': {
    dTag: 'print-detail',
    routeId: 'printable-detail',
    title: 'Print details',
    description: 'View images, files, metadata, maker attribution, and print actions.',
    actions: ['open'],
    toHref: (payload) => {
      const normalized = normalizeObjectPayload(payload);
      return normalized ? encodeAddressPath(normalized.address) : null;
    },
  },

  'printable-create': {
    dTag: 'print-create',
    routeId: 'create',
    nav: 'create',
    title: 'Create print',
    description: 'Publish a new 3D printable model with images and files.',
    actions: ['open', 'create'],
    toHref: (payload) => {
      const remixOf = payload.remixOf?.trim();
      if (!remixOf) return '/create';
      return `/create?remix=${encodeURIComponent(remixOf)}`;
    },
  },

  'stl-preview': {
    dTag: 'stl-preview',
    routeId: 'overlay-preview',
    title: 'STL preview',
    description: 'Inspect an STL file in 3D without leaving the page.',
    actions: ['open'],
    // An overlay modifies the current page rather than naming one of its own, so it has no
    // standalone href. `services/intent.ts` builds the URL from the ambient location.
    toHref: () => null,
  },

  'part-detail': {
    dTag: 'part-detail',
    routeId: 'part-detail',
    title: 'Part details',
    description: 'View metadata for a published printable part file.',
    actions: ['open'],
    toHref: (payload) => {
      const fileId = payload.fileId?.trim();
      return fileId && isFileId(fileId) ? `/part/${encodeURIComponent(fileId)}` : null;
    },
  },

  'part-library': {
    dTag: 'part-library',
    routeId: 'part-library',
    nav: 'parts',
    title: 'Your parts',
    description: 'Manage published part files and see which prints use them.',
    actions: ['open'],
    toHref: () => '/parts',
  },

  'printable-edit': {
    dTag: 'print-edit',
    routeId: 'printable-edit',
    title: 'Edit print',
    description: 'Load an owned print and publish a replacement event.',
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

  if (path === '/') return intent('printable-browse', 'open');

  if (path === '/search') {
    const query = search.get('q')?.trim() ?? '';
    return intent('printable-browse', 'open', query ? { query } : {});
  }

  if (parts[0] === 'tags' && parts[1]) {
    return intent('printable-browse', 'open', { tag: decodePart(parts[1]) });
  }

  if (path === '/create') {
    const remixOf = search.get('remix')?.trim() ?? '';
    return intent('printable-create', 'open', remixOf ? { remixOf } : {});
  }

  if (path === '/parts') return intent('part-library', 'open');

  if (parts[0] === 'profiles' && parts[1]) {
    return intent('profile', 'open', { pubkey: decodePart(parts[1]) });
  }

  if (parts[0] === 'objects' && parts[1] && parts[2]) {
    const address = `${OBJECT_KIND}:${decodePart(parts[1])}:${decodePart(parts[2])}`;
    if (parts[3] === 'edit') return intent('printable-edit', 'edit', { address });
    if (parts.length === 3) return intent('printable-detail', 'open', { address });
  }

  if (parts[0] === 'part' && parts[1] && isFileId(decodePart(parts[1]))) {
    return intent('part-detail', 'open', { fileId: decodePart(parts[1]) });
  }

  return null;
}
