import type { Filter } from 'applesauce-core/helpers/filter';
import { mergeRelaySets } from 'applesauce-core/helpers/relays';
import type { NostrEvent } from 'nostr-tools';
import { nip19 } from 'nostr-tools';
import { accountManager } from './accounts';
import { ARCHETYPES, conventionsFor } from './intent-map';
import { getUser, STLSTR_DEV_MODE, STLSTR_LOCAL_MODE } from './nostr';
import { firstDefinedValue } from './observable';
import { collectRequest } from './relay-query';
import { getLookupRelays, getSettings, type NappletOverride } from './settings';

const NIP5A_KIND = 35129;
const MANIFEST_TIMEOUT_MS = 5_000;

/** The NIP-5A manifest event kind, for callers building addresses to a published napplet. */
export const NAPPLET_MANIFEST_KIND = NIP5A_KIND;

/**
 * The Nostr identity the built-in napplets are published under — the `hzrd149` prod
 * signing key from `.napplet/config.json`, as a raw hex pubkey.
 *
 * This is a static build constant so the Napplets reference page (`/napplets`) can show
 * each napplet's canonical `naddr` to a visiting app developer without a network round
 * trip or anyone being signed in. It is the *publishing* identity, independent of build
 * mode: the address `35129:<this>:<dTag>` is the same one a prod deploy re-signs and
 * publishes. Leave empty in a fork that has not set its own publishing key — the page
 * then omits the copyable address rather than inventing one.
 *
 * Mirrors `signing.pubkey` in `.napplet/config.json` (the `hzrd149` npub
 * `npub1ye5ptcxfyyxl5vjvdjar2ua3f0hynkjzpx552mu5snj3qmx5pzjscpknpr`). Keep the two in sync.
 */
export const NAPPLET_PUBLISHER_PUBKEY =
  '266815e0c9210dfa324c6cba3573b14bee49da4209a9456f9484e5106cd408a5';

/**
 * Relay hints embedded in a published napplet's `naddr`. These mirror the prod deploy
 * targets in `.napplet/config.json`, so a pasted address resolves on the relays the
 * napplets are actually published to.
 */
export const NAPPLET_PUBLISH_RELAYS = [
  'wss://relay.ditto.pub',
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
];

/** The shareable `naddr` for a published built-in napplet, or null if unconfigured. */
export function publishedNappletNaddr(dTag: string): string | null {
  if (!NAPPLET_PUBLISHER_PUBKEY) return null;
  return nip19.naddrEncode({
    identifier: dTag,
    pubkey: NAPPLET_PUBLISHER_PUBKEY,
    kind: NIP5A_KIND,
    relays: NAPPLET_PUBLISH_RELAYS,
  });
}
/** How long to wait for the active user's relay list before falling back. */
const OUTBOX_RESOLVE_TIMEOUT_MS = 2_000;

/**
 * Relays to search for napplet manifests (NIP-5A), outbox-first.
 *
 * A napplet manifest is published to its author's write relays, so the active
 * user's own outboxes are the authoritative place to look for the napplets they
 * publish and use — following the same OUTBOX-first model the shell uses for all
 * other reads. Fall back to the configured lookup relays when nobody is signed
 * in, the user's relay list has not loaded yet, or in local builds where
 * discovery stays on the local relay.
 */
async function getDiscoveryRelays(): Promise<string[]> {
  if (STLSTR_LOCAL_MODE) return getLookupRelays();

  const pubkey = accountManager.active?.pubkey;
  if (pubkey) {
    const outboxes = mergeRelaySets(
      await firstDefinedValue(getUser(pubkey).outboxes$, OUTBOX_RESOLVE_TIMEOUT_MS),
    );
    if (outboxes.length > 0) return outboxes;
  }

  return getLookupRelays();
}

/**
 * Where the shell finds the built-in napplet artifacts it ships as archetype
 * defaults. In dev, the Vite server serves each napplet's live `dist/` at
 * `/napplets.dev/<dTag>/` and generates `/napplets.dev.json`. In a production
 * build, the napplet bundle plugin (apps/stlstr/vite.config.ts) copies each
 * artifact to `/napplets/<dTag>/` and emits `/napplets.json`. The two are
 * symmetric so the same default-resolution code path works in both.
 */
const NAPPLET_ASSET_BASE = STLSTR_DEV_MODE ? '/napplets.dev' : '/napplets';
const NAPPLET_REGISTRY_URL = STLSTR_DEV_MODE ? '/napplets.dev.json' : '/napplets.json';

/** The same-origin URL of a built-in napplet's default artifact for a dTag. */
function defaultArtifactUrl(dTag: string): string {
  return `${NAPPLET_ASSET_BASE}/${dTag}/index.html`;
}

type RegistryNapplet = {
  name: string;
  url: string;
};

type NappletRegistry = {
  napplets?: RegistryNapplet[];
};

export type ResolvedNapplet = {
  archetype: string;
  dTag: string;
  title: string;
  description?: string;
  aggregateHash: string;
  artifactUrl: string;
  protocols: string[];
  source: 'default' | 'override';
  naddr?: string;
  pubkey?: string;
  identifier?: string;
  relays?: string[];
  compatibleWithArchetype?: boolean;
};

export type LoadedNapplet = ResolvedNapplet & {
  html: string;
  domains: string[];
};

const defaultArtifactCache = new Map<string, Promise<LoadedNapplet>>();

function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name && tag[1])?.[1]?.trim() || undefined;
}

function hasCompatibleArchetype(event: NostrEvent, archetype: string): boolean {
  const protocols = conventionsFor(archetype);
  return event.tags.some(
    (tag) =>
      tag[0] === 'archetype' && tag[1] === archetype && protocols.some((p) => tag.includes(p)),
  );
}

function artifactUrlFrom(event: NostrEvent): string | undefined {
  const direct = tagValue(event, 'url') || tagValue(event, 'artifact') || tagValue(event, 'html');
  if (direct) return allowedArtifactUrl(direct);

  const indexHash = event.tags.find(
    (tag) => tag[0] === 'path' && tag[1] === '/index.html' && tag[2],
  )?.[2];
  if (!indexHash) return undefined;

  for (const server of event.tags
    .filter((tag) => tag[0] === 'server' && tag[1])
    .map((tag) => tag[1])) {
    const url = allowedArtifactUrl(server);
    if (!url) continue;
    const base = new URL(url);
    base.pathname = `${base.pathname.replace(/\/$/, '')}/${indexHash}`;
    return base.toString();
  }

  return undefined;
}

function allowedArtifactUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    // Plain http artifact URLs are only trusted against local infrastructure.
    if (url.protocol === 'https:' || (STLSTR_LOCAL_MODE && url.protocol === 'http:')) {
      return url.toString();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function resolvedFromManifest(
  manifest: NostrEvent,
  archetype: string,
  naddr: string,
  relays: string[],
): ResolvedNapplet {
  const dTag = tagValue(manifest, 'd');
  const aggregateHash =
    manifest.tags.find((tag) => tag[0] === 'x' && tag[2] === 'aggregate')?.[1] ??
    tagValue(manifest, 'x');
  const artifactUrl = artifactUrlFrom(manifest);
  if (!dTag) throw new Error('That napplet manifest does not include a d tag.');
  if (!aggregateHash) throw new Error('That napplet manifest does not include an aggregate hash.');
  if (!artifactUrl)
    throw new Error('That napplet manifest does not include a loadable artifact URL.');

  return {
    archetype,
    dTag,
    title: tagValue(manifest, 'title') ?? dTag,
    description: tagValue(manifest, 'description'),
    aggregateHash,
    artifactUrl,
    protocols: conventionsFor(archetype),
    source: 'override',
    naddr,
    pubkey: manifest.pubkey,
    identifier: dTag,
    relays,
    compatibleWithArchetype: hasCompatibleArchetype(manifest, archetype),
  };
}

async function resolveRegistryNappletUrl(name: string, fallbackUrl: string): Promise<string> {
  try {
    const response = await fetch(NAPPLET_REGISTRY_URL, { cache: 'no-store' });
    if (!response.ok) return fallbackUrl;

    const registry = (await response.json()) as NappletRegistry;
    return registry.napplets?.find((napplet) => napplet.name === name)?.url ?? fallbackUrl;
  } catch {
    return fallbackUrl;
  }
}

function readNappletDomains(html: string): string[] {
  const content = new DOMParser()
    .parseFromString(html, 'text/html')
    .querySelector('meta[name="napplet-requires"]')
    ?.getAttribute('content');

  if (!content) return [];

  return content
    .split(',')
    .map((domain) => domain.trim())
    .filter(Boolean);
}

async function fetchManifest(
  pubkey: string,
  identifier: string,
  relays: string[],
): Promise<NostrEvent | null> {
  const filters: Filter[] = [
    { kinds: [NIP5A_KIND], authors: [pubkey], '#d': [identifier], limit: 1 },
  ];
  const candidates = await collectRequest(relays, filters, MANIFEST_TIMEOUT_MS);

  return candidates.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
}

export function defaultNappletForArchetype(archetype: string): ResolvedNapplet | null {
  const entry = ARCHETYPES[archetype];
  if (!entry) return null;

  return {
    archetype,
    dTag: entry.dTag,
    title: entry.title,
    description: entry.description,
    aggregateHash: `dev-${entry.dTag}-build`,
    artifactUrl: defaultArtifactUrl(entry.dTag),
    protocols: conventionsFor(archetype),
    source: 'default',
  };
}

export function overrideFromResolved(napplet: ResolvedNapplet): NappletOverride | null {
  if (napplet.source !== 'override' || !napplet.naddr || !napplet.pubkey || !napplet.identifier) {
    return null;
  }
  return {
    naddr: napplet.naddr,
    pubkey: napplet.pubkey,
    identifier: napplet.identifier,
    dTag: napplet.dTag,
    title: napplet.title,
    description: napplet.description,
    aggregateHash: napplet.aggregateHash,
    artifactUrl: napplet.artifactUrl,
    relays: napplet.relays,
  };
}

export async function resolveNappletNaddr(
  naddr: string,
  archetype: string,
): Promise<ResolvedNapplet> {
  const decoded = nip19.decode(naddr.trim());
  if (decoded.type !== 'naddr') throw new Error('Paste a Nostr naddr for a napplet manifest.');

  const pointer = decoded.data;
  if (pointer.kind !== NIP5A_KIND)
    throw new Error('That naddr does not point to a NIP-5A napplet.');

  const relays = mergeRelaySets([...(pointer.relays ?? []), ...(await getDiscoveryRelays())]);
  const manifest = await fetchManifest(pointer.pubkey, pointer.identifier, relays);
  if (!manifest) throw new Error('Could not find that napplet manifest on your relays.');
  return resolvedFromManifest(manifest, archetype, naddr.trim(), relays);
}

export async function discoverCompatibleNapplets(archetype: string): Promise<ResolvedNapplet[]> {
  const relays = await getDiscoveryRelays();
  const filters: Filter[] = [{ kinds: [NIP5A_KIND], limit: 80 }];
  const events = await collectRequest(relays, filters, MANIFEST_TIMEOUT_MS);

  const seen = new Set<string>();
  const resolved: ResolvedNapplet[] = [];
  for (const event of events.sort((a, b) => b.created_at - a.created_at)) {
    const dTag = tagValue(event, 'd');
    if (!dTag) continue;
    const key = `${event.pubkey}:${dTag}`;
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      const naddr = nip19.naddrEncode({
        identifier: dTag,
        pubkey: event.pubkey,
        kind: NIP5A_KIND,
        relays,
      });
      resolved.push(resolvedFromManifest(event, archetype, naddr, relays));
    } catch {
      // Skip incomplete or not-yet-loadable manifests in discovery results.
    }
  }

  return resolved;
}

function resolvedFromOverride(archetype: string, override: NappletOverride): ResolvedNapplet {
  const fallback = defaultNappletForArchetype(archetype);
  return {
    archetype,
    dTag: override.dTag,
    title: override.title ?? fallback?.title ?? override.dTag,
    description: override.description ?? fallback?.description,
    aggregateHash: override.aggregateHash ?? `override-${override.dTag}`,
    artifactUrl: override.artifactUrl ?? '',
    protocols: conventionsFor(archetype),
    source: 'override',
    naddr: override.naddr,
    pubkey: override.pubkey,
    identifier: override.identifier,
    relays: override.relays,
  };
}

export function resolveConfiguredNapplet(archetype: string): ResolvedNapplet | null {
  const override = getSettings().nappletOverrides[archetype];
  if (override) return resolvedFromOverride(archetype, override);
  return defaultNappletForArchetype(archetype);
}

export async function loadNappletArtifact(napplet: ResolvedNapplet): Promise<LoadedNapplet> {
  const fallbackUrl = defaultArtifactUrl(napplet.dTag);
  const url =
    napplet.source === 'default'
      ? await resolveRegistryNappletUrl(napplet.dTag, fallbackUrl)
      : napplet.artifactUrl;
  if (!url) throw new Error(`${napplet.title} does not have a loadable artifact URL.`);

  const cacheKey = `${napplet.dTag}:${napplet.aggregateHash}:${url}`;
  const shouldCache = napplet.source === 'default' && !STLSTR_DEV_MODE;
  if (shouldCache) {
    const cached = defaultArtifactCache.get(cacheKey);
    if (cached) return cached;
  }

  const loaded = fetchNappletArtifact(napplet, url);
  if (shouldCache) defaultArtifactCache.set(cacheKey, loaded);

  try {
    return await loaded;
  } catch (error) {
    if (shouldCache && defaultArtifactCache.get(cacheKey) === loaded) {
      defaultArtifactCache.delete(cacheKey);
    }
    throw error;
  }
}

async function fetchNappletArtifact(napplet: ResolvedNapplet, url: string): Promise<LoadedNapplet> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(
      napplet.source === 'default'
        ? STLSTR_DEV_MODE
          ? `Build ${napplet.dTag} first: ${response.status} ${response.statusText}`
          : `Built-in napplet ${napplet.dTag} is missing from this deployment: ${response.status} ${response.statusText}`
        : `Could not load ${napplet.title}: ${response.status} ${response.statusText}`,
    );
  }

  const html = await response.text();
  return { ...napplet, artifactUrl: url, html, domains: readNappletDomains(html) };
}
