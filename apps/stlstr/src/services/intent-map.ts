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

/**
 * Presentation groups for the Napplets reference page (`/napplets`), in display order.
 * An archetype that omits a `category` is not shown there — that is the signal for a
 * planned archetype the shell can route to but has no published napplet yet (e.g.
 * `make-create`, which has a route but no `napplets/*` folder to build and deploy).
 */
export const NAPPLET_CATEGORIES = [
  {
    id: 'discover',
    title: 'Discover',
    description: 'Feeds and profiles for finding prints and makers.',
  },
  {
    id: 'printables',
    title: 'Printables',
    description: 'View, publish, and edit 3D printables.',
  },
  { id: 'makes', title: 'Makes', description: 'Share and browse prints people actually made.' },
  {
    id: 'parts',
    title: 'Parts',
    description: 'Reusable NIP-94 part files that printables reference.',
  },
  { id: 'tools', title: 'Tools', description: 'Embeddable utility surfaces other apps can open.' },
] as const;

/** Id of one Napplets-page category. */
export type NappletCategory = (typeof NAPPLET_CATEGORIES)[number]['id'];

/** One field of an intent payload, documented for the archetype reference. */
export type IntentField = {
  /** Payload key the archetype reads. */
  name: string;
  /** Whether the action is meaningful without this field. */
  required: boolean;
  /** What the field carries and any shape constraints on it. */
  description: string;
};

/** What one action (verb) of an archetype does and the payload it reads. */
export type IntentDoc = {
  /** One line on what invoking this action does. */
  summary: string;
  /** The payload fields this action reads, in the order a caller should think about them. */
  fields: IntentField[];
};

/** One archetype the shell can route to, and the napplet that fulfills it. */
export type ArchetypeEntry = {
  /** dTag of the napplet that handles this role. */
  dTag: string;
  /** Shell route id, used for the window id and for React keys. */
  routeId: string;
  /** Navigation group this archetype belongs to, when it is a top-level destination. */
  nav?: 'discover' | 'browse' | 'create' | 'parts' | 'settings';
  /**
   * Section this napplet appears under on the `/napplets` reference page. Omitted for
   * archetypes with no published napplet, which keeps them off that page.
   */
  category?: NappletCategory;
  title: string;
  description: string;
  /**
   * The verbs this archetype accepts, keyed by action name, each documenting what it does
   * and the payload it reads. This is the single source for the archetype's supported
   * actions — `actionsFor` derives the verb list from these keys.
   */
  intents: Record<string, IntentDoc>;
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

/** Address of a printable: `33500:<pubkey>:<d>`. */
const PRINTABLE_KIND = '33500';

/**
 * The one archetype the shell renders as a centered dialog over the current page rather
 * than as a page of its own.
 *
 * NAP-INTENT cannot express this: `IntentBehavior` carries `focus` / `newWindow` / `reuse`
 * and nothing about presentation, so modal-versus-route is the shell's decision, taken from
 * the archetype. It is hardcoded deliberately; generalize it when a second archetype
 * needs modal presentation.
 */
export const PREVIEW_ARCHETYPE = 'stl-preview';

/** Query param carrying the open overlay. Orthogonal to a route's own params. */
const PREVIEW_PARAM = 'stl';

/** A kind-1063 file event id. */
function isFileId(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

/** A kind-2351 make event id — same 64-char hex shape as a file id. */
const isEventId = isFileId;

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
  if (kind !== PRINTABLE_KIND || !pubkey || !identifier) return null;
  return `/printables/${encodeURIComponent(pubkey)}/${encodeURIComponent(identifier)}${suffix}`;
}

/**
 * Normalizes the two accepted printable references into one `address` field so napplets
 * only ever parse a single shape.
 */
export function normalizePrintablePayload(payload: IntentPayload): IntentPayload | null {
  const address = payload.address?.trim();
  if (address) return encodeAddressPath(address) ? { address } : null;

  const pubkey = payload.pubkey?.trim();
  const identifier = (payload.identifier ?? payload.d)?.trim();
  if (pubkey && identifier) return { address: `${PRINTABLE_KIND}:${pubkey}:${identifier}` };
  return null;
}

export const ARCHETYPES: Record<string, ArchetypeEntry> = {
  'printable-discovery': {
    dTag: 'print-discvr',
    routeId: 'discovery',
    category: 'discover',
    nav: 'discover',
    title: 'Discover prints',
    description: 'Find new, featured, and friend-adjacent printable models.',
    intents: {
      open: {
        summary: 'Open the discovery home — new, featured, and friend-adjacent printables.',
        fields: [],
      },
    },
    toHref: () => '/',
  },

  'printable-browse': {
    dTag: 'print-browse',
    routeId: 'search',
    category: 'discover',
    nav: 'browse',
    title: 'Search prints',
    description: 'Search printable models published as Nostr events.',
    intents: {
      open: {
        summary: 'Open the search feed, optionally scoped to a text query or a single tag.',
        fields: [
          {
            name: 'query',
            required: false,
            description: 'Free-text search across printable titles, descriptions, and tags.',
          },
          {
            name: 'tag',
            required: false,
            description: 'A single topic tag to filter the feed by. Takes precedence over query.',
          },
        ],
      },
    },
    toHref: (payload) => {
      const tag = payload.tag?.trim();
      if (tag) return `/tags/${encodeURIComponent(tag)}`;
      const query = payload.query?.trim();
      if (query) return `/search?q=${encodeURIComponent(query)}`;
      return '/search';
    },
    titleFor: (intent) => {
      if (intent.payload.tag) return `#${intent.payload.tag}`;
      if (intent.payload.query) return `Search: ${intent.payload.query}`;
      return 'Search prints';
    },
  },

  profile: {
    dTag: 'user-profile',
    routeId: 'user-profile',
    category: 'discover',
    title: 'Maker profile',
    description: 'View a maker, their published prints, and their collections.',
    intents: {
      open: {
        summary: "Show a maker's profile and the printables they have published.",
        fields: [
          {
            name: 'pubkey',
            required: true,
            description: 'Hex public key of the maker to display.',
          },
        ],
      },
    },
    toHref: (payload) => {
      const pubkey = payload.pubkey?.trim();
      return pubkey ? `/profiles/${encodeURIComponent(pubkey)}` : null;
    },
  },

  'printable-detail': {
    dTag: 'print-detail',
    routeId: 'printable-detail',
    category: 'printables',
    title: 'Print details',
    description: 'View images, files, metadata, maker attribution, and print actions.',
    intents: {
      open: {
        summary: 'Show one printable: media, files, maker attribution, and actions.',
        fields: [
          {
            name: 'address',
            required: true,
            description:
              'Printable address 33500:<pubkey>:<d>. Also accepts { pubkey, identifier } instead.',
          },
        ],
      },
    },
    toHref: (payload) => {
      const normalized = normalizePrintablePayload(payload);
      return normalized ? encodeAddressPath(normalized.address) : null;
    },
  },

  'printable-create': {
    dTag: 'print-create',
    routeId: 'create',
    category: 'printables',
    nav: 'create',
    title: 'Create print',
    description: 'Publish a new 3D printable model with images and files.',
    intents: {
      open: {
        summary: 'Open the publisher for a new printable.',
        fields: [
          {
            name: 'remixOf',
            required: false,
            description: 'Address of an existing printable to remix; pre-fills remix attribution.',
          },
        ],
      },
      create: {
        summary: 'Publish a new printable with its images and files.',
        fields: [
          {
            name: 'remixOf',
            required: false,
            description: 'Address of an existing printable to remix; pre-fills remix attribution.',
          },
        ],
      },
    },
    toHref: (payload) => {
      const remixOf = payload.remixOf?.trim();
      if (!remixOf) return '/create';
      return `/create?remix=${encodeURIComponent(remixOf)}`;
    },
  },

  'stl-preview': {
    dTag: 'stl-preview',
    routeId: 'overlay-preview',
    category: 'tools',
    title: 'STL preview',
    description: 'Inspect an STL file in 3D without leaving the page.',
    intents: {
      open: {
        summary: 'Preview an STL file in 3D, usually as an overlay over the current page.',
        fields: [
          {
            name: 'url',
            required: true,
            description: 'URL of the STL resource to load into the viewer.',
          },
          { name: 'name', required: false, description: 'Display name for the file.' },
          { name: 'mime', required: false, description: 'MIME type hint for the resource.' },
          {
            name: 'size',
            required: false,
            description: 'File size in bytes, for progress display.',
          },
        ],
      },
    },
    // An overlay modifies the current page rather than naming one of its own, so it has no
    // standalone href. `services/intent.ts` builds the URL from the ambient location.
    toHref: () => null,
  },

  'part-detail': {
    dTag: 'part-detail',
    routeId: 'part-detail',
    category: 'parts',
    title: 'Part details',
    description: 'View metadata for a published printable part file.',
    intents: {
      open: {
        summary: 'Show metadata for a published NIP-94 part file and its related actions.',
        fields: [
          {
            name: 'fileId',
            required: true,
            description: "Event id (64-char hex) of the part's file event.",
          },
        ],
      },
    },
    toHref: (payload) => {
      const fileId = payload.fileId?.trim();
      return fileId && isFileId(fileId) ? `/part/${encodeURIComponent(fileId)}` : null;
    },
  },

  'part-library': {
    dTag: 'part-library',
    routeId: 'part-library',
    category: 'parts',
    nav: 'parts',
    title: 'Your parts',
    description: 'Manage published part files and see which prints use them.',
    intents: {
      open: {
        summary: "List the signed-in user's own published part files and where they are used.",
        fields: [],
      },
    },
    toHref: () => '/parts',
  },

  'part-upload': {
    dTag: 'part-upload',
    routeId: 'part-upload',
    category: 'parts',
    title: 'Upload parts',
    description: 'Publish reusable file events for printables to reference.',
    intents: {
      open: {
        summary: 'Open the part uploader.',
        fields: [],
      },
      create: {
        summary: 'Publish a new reusable part file event for printables to reference.',
        fields: [],
      },
    },
    toHref: () => '/parts/upload',
  },

  'printable-edit': {
    dTag: 'print-edit',
    routeId: 'printable-edit',
    category: 'printables',
    title: 'Edit print',
    description: 'Load an owned print and publish a replacement event.',
    intents: {
      open: {
        summary: 'Load an owned printable into the editor.',
        fields: [
          {
            name: 'address',
            required: true,
            description:
              'Printable address 33500:<pubkey>:<d> of the printable to edit. Also accepts { pubkey, identifier }.',
          },
        ],
      },
      edit: {
        summary: 'Load an owned printable and publish a replacement event.',
        fields: [
          {
            name: 'address',
            required: true,
            description:
              'Printable address 33500:<pubkey>:<d> of the printable to edit. Also accepts { pubkey, identifier }.',
          },
        ],
      },
    },
    toHref: (payload) => {
      const normalized = normalizePrintablePayload(payload);
      return normalized ? encodeAddressPath(normalized.address, '/edit') : null;
    },
  },

  'make-create': {
    dTag: 'make-create',
    routeId: 'make-create',
    title: 'Post a make',
    description: 'Share photos and notes of a print you made from a printable.',
    intents: {
      open: {
        summary: 'Open the composer to post a make for a printable you printed.',
        fields: [
          {
            name: 'address',
            required: true,
            description:
              'Printable address 33500:<pubkey>:<d> of the printable the make was built from.',
          },
        ],
      },
      create: {
        summary: 'Publish a make — photos and notes — for a printable.',
        fields: [
          {
            name: 'address',
            required: true,
            description:
              'Printable address 33500:<pubkey>:<d> of the printable the make was built from.',
          },
        ],
      },
    },
    toHref: (payload) => {
      const normalized = normalizePrintablePayload(payload);
      return normalized ? encodeAddressPath(normalized.address, '/makes/new') : null;
    },
  },

  'make-detail': {
    dTag: 'make-detail',
    routeId: 'make-detail',
    category: 'makes',
    title: 'Make',
    description: 'View a single make: photos, notes, maker, and the printable it was made from.',
    intents: {
      open: {
        summary: 'Show a single make: photos, notes, maker, and the printable it came from.',
        fields: [
          {
            name: 'eventId',
            required: true,
            description: 'Event id (64-char hex) of the make (kind 2351) event.',
          },
        ],
      },
    },
    toHref: (payload) => {
      const eventId = payload.eventId?.trim();
      return eventId && isEventId(eventId) ? `/makes/${encodeURIComponent(eventId)}` : null;
    },
  },
};

/** The verbs an archetype accepts, derived from its documented intents. */
export function actionsFor(archetype: string): string[] {
  const entry = ARCHETYPES[archetype];
  return entry ? Object.keys(entry.intents) : [];
}

/** Every convention id the shell can route, for manifest and capability reporting. */
export function conventionsFor(archetype: string): string[] {
  return actionsFor(archetype).map((action) => conventionId(archetype, action));
}

/**
 * Serializes an intent to a shell href.
 *
 * Returns null when the archetype is unknown, the action is unsupported, or the payload
 * cannot address a page — the three cases NAP-INTENT reports as a failed invocation.
 */
export function intentToHref(intent: StlstrIntent): string | null {
  const entry = ARCHETYPES[intent.archetype];
  if (!entry || !(intent.action in entry.intents)) return null;
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

  if (path === '/') return intent('printable-discovery', 'open');

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

  if (path === '/parts/upload') return intent('part-upload', 'open');

  if (parts[0] === 'profiles' && parts[1]) {
    return intent('profile', 'open', { pubkey: decodePart(parts[1]) });
  }

  if (parts[0] === 'printables' && parts[1] && parts[2]) {
    const address = `${PRINTABLE_KIND}:${decodePart(parts[1])}:${decodePart(parts[2])}`;
    if (parts[3] === 'edit') return intent('printable-edit', 'edit', { address });
    if (parts[3] === 'makes' && parts[4] === 'new')
      return intent('make-create', 'open', { address });
    if (parts.length === 3) return intent('printable-detail', 'open', { address });
  }

  if (parts[0] === 'makes' && parts[1] && isEventId(decodePart(parts[1]))) {
    return intent('make-detail', 'open', { eventId: decodePart(parts[1]) });
  }

  if (parts[0] === 'part' && parts[1] && isFileId(decodePart(parts[1]))) {
    return intent('part-detail', 'open', { fileId: decodePart(parts[1]) });
  }

  return null;
}
