import { mergeBlossomServers, normalizeBlossomServer } from 'applesauce-common/helpers/blossom';
import { mergeRelaySets, normalizeRelayUrl } from 'applesauce-core/helpers/relays';
import {
  NOSTR_EXTRA_RELAYS,
  NOSTR_LOOKUP_RELAYS,
  PRODUCTION_BLOSSOM_SERVERS,
  PRODUCTION_EXTRA_RELAYS,
  PRODUCTION_LOOKUP_RELAYS,
  STLSTR_DEV_BLOSSOM_SERVER,
  STLSTR_DEV_MODE,
} from './nostr';

const SETTINGS_STORAGE_KEY = 'stlstr.settings.v1';

/**
 * Dev builds are pinned to the local relay and Blossom server, so the relay and media
 * server settings are read-only there.
 */
export const NETWORK_SETTINGS_LOCKED = STLSTR_DEV_MODE;

export type ThemePreference = 'system' | 'light' | 'dark';
export type NappletUpdateBehavior = 'banner' | 'auto-grant' | 'silent-reprompt';

export type NappletOverride = {
  naddr: string;
  pubkey: string;
  identifier: string;
  dTag: string;
  title?: string;
  description?: string;
  aggregateHash?: string;
  artifactUrl?: string;
  relays?: string[];
};

export type StlstrSettings = {
  /** Which daisyUI theme to render the shell with. */
  theme: ThemePreference;
  /** Relays used when the account publishes no relay list of its own. */
  appRelays: string[];
  /** Relays used to look up profiles and relay lists. */
  lookupRelays: string[];
  /** Media servers used when the account publishes no Blossom server list. */
  blossomServers: string[];
  /** What the shell does when a napplet asks for new permissions. */
  nappletUpdateBehavior: NappletUpdateBehavior;
  /** User-selected NIP-5A manifest overrides keyed by archetype. */
  nappletOverrides: Record<string, NappletOverride>;
};

export const DEFAULT_SETTINGS: StlstrSettings = {
  theme: 'system',
  appRelays: [...PRODUCTION_EXTRA_RELAYS],
  lookupRelays: [...PRODUCTION_LOOKUP_RELAYS],
  blossomServers: [...PRODUCTION_BLOSSOM_SERVERS],
  nappletUpdateBehavior: 'banner',
  nappletOverrides: {},
};

/** Parses user input into a relay URL, or null when it is not usable. */
export function parseRelayUrl(value: string): string | null {
  try {
    return normalizeRelayUrl(value.trim());
  } catch {
    return null;
  }
}

/** Parses user input into a media server URL, or null when it is not usable. */
export function parseServerUrl(value: string): string | null {
  try {
    return normalizeBlossomServer(value.trim()).toString();
  } catch {
    return null;
  }
}

function isTheme(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

function isUpdateBehavior(value: unknown): value is NappletUpdateBehavior {
  return value === 'banner' || value === 'auto-grant' || value === 'silent-reprompt';
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNappletOverrides(value: unknown): Record<string, NappletOverride> {
  if (!value || typeof value !== 'object') return {};

  const overrides: Record<string, NappletOverride> = {};
  for (const [archetype, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!archetype || !raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const naddr = text(item.naddr);
    const pubkey = text(item.pubkey);
    const identifier = text(item.identifier);
    const dTag = text(item.dTag);
    if (!naddr || !pubkey || !identifier || !dTag) continue;

    const relays = Array.isArray(item.relays)
      ? mergeRelaySets(item.relays.filter((relay): relay is string => typeof relay === 'string'))
      : undefined;

    overrides[archetype] = {
      naddr,
      pubkey,
      identifier,
      dTag,
      title: text(item.title),
      description: text(item.description),
      aggregateHash: text(item.aggregateHash),
      artifactUrl: text(item.artifactUrl),
      relays,
    };
  }

  return overrides;
}

function readStoredSettings(): StlstrSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };

    const stored = JSON.parse(raw) as Partial<StlstrSettings>;

    return {
      theme: isTheme(stored.theme) ? stored.theme : DEFAULT_SETTINGS.theme,
      // Empty saved lists are meaningful (the user removed everything), but a list that
      // was never saved should still fall back to the shipped defaults.
      appRelays: stored.appRelays ? mergeRelaySets(stored.appRelays) : DEFAULT_SETTINGS.appRelays,
      lookupRelays: stored.lookupRelays
        ? mergeRelaySets(stored.lookupRelays)
        : DEFAULT_SETTINGS.lookupRelays,
      blossomServers: stored.blossomServers
        ? mergeBlossomServers(stored.blossomServers)
        : DEFAULT_SETTINGS.blossomServers,
      nappletUpdateBehavior: isUpdateBehavior(stored.nappletUpdateBehavior)
        ? stored.nappletUpdateBehavior
        : DEFAULT_SETTINGS.nappletUpdateBehavior,
      nappletOverrides: readNappletOverrides(stored.nappletOverrides),
    };
  } catch (cause) {
    console.warn('[stlstr] failed to read saved settings', cause);
    return { ...DEFAULT_SETTINGS };
  }
}

let settings = readStoredSettings();
const listeners = new Set<() => void>();

export function getSettings(): StlstrSettings {
  return settings;
}

export function subscribeToSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateSettings(patch: Partial<StlstrSettings>): StlstrSettings {
  settings = { ...settings, ...patch };
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (cause) {
    console.warn('[stlstr] failed to save settings', cause);
  }
  applyTheme(settings.theme);
  for (const listener of listeners) listener();
  return settings;
}

export function resetSettings(): StlstrSettings {
  return updateSettings({ ...DEFAULT_SETTINGS });
}

/** Adds a relay to one of the relay lists. Returns false if the URL is invalid or already listed. */
export function addRelay(key: 'appRelays' | 'lookupRelays', value: string): boolean {
  if (NETWORK_SETTINGS_LOCKED) return false;
  const normalized = parseRelayUrl(value);
  if (!normalized || settings[key].includes(normalized)) return false;
  updateSettings({ [key]: [...settings[key], normalized] });
  return true;
}

export function removeRelay(key: 'appRelays' | 'lookupRelays', value: string): void {
  if (NETWORK_SETTINGS_LOCKED) return;
  updateSettings({ [key]: settings[key].filter((relay) => relay !== value) });
}

/** Adds a media server. Returns false if the URL is invalid or already listed. */
export function addBlossomServer(value: string): boolean {
  if (NETWORK_SETTINGS_LOCKED) return false;
  const normalized = parseServerUrl(value);
  if (!normalized || settings.blossomServers.includes(normalized)) return false;
  updateSettings({ blossomServers: [...settings.blossomServers, normalized] });
  return true;
}

export function removeBlossomServer(value: string): void {
  if (NETWORK_SETTINGS_LOCKED) return;
  updateSettings({
    blossomServers: settings.blossomServers.filter((server) => server !== value),
  });
}

export function setNappletOverride(archetype: string, override: NappletOverride): void {
  updateSettings({
    nappletOverrides: { ...settings.nappletOverrides, [archetype]: override },
  });
}

export function removeNappletOverride(archetype: string): void {
  const next = { ...settings.nappletOverrides };
  delete next[archetype];
  updateSettings({ nappletOverrides: next });
}

export function resetNappletOverrides(): void {
  updateSettings({ nappletOverrides: {} });
}

/**
 * Relays the shell falls back to when the account has no relay list of its own.
 * Dev builds always use the local relay.
 */
export function getAppRelays(): string[] {
  if (NETWORK_SETTINGS_LOCKED) return NOSTR_EXTRA_RELAYS;
  return settings.appRelays.length > 0 ? settings.appRelays : DEFAULT_SETTINGS.appRelays;
}

/** Relays used to resolve profiles and relay lists. Dev builds always use the local relay. */
export function getLookupRelays(): string[] {
  if (NETWORK_SETTINGS_LOCKED) return NOSTR_LOOKUP_RELAYS;
  return settings.lookupRelays.length > 0 ? settings.lookupRelays : DEFAULT_SETTINGS.lookupRelays;
}

/**
 * Media servers used when the signed-in account publishes no Blossom server list.
 * Dev builds always use the local Blossom server.
 */
export function getFallbackBlossomServers(): string[] {
  if (NETWORK_SETTINGS_LOCKED) return [STLSTR_DEV_BLOSSOM_SERVER];
  return settings.blossomServers;
}

const darkMediaQuery =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

export function applyTheme(theme: ThemePreference = settings.theme): void {
  if (typeof document === 'undefined') return;
  const resolved = theme === 'system' ? (darkMediaQuery?.matches ? 'dark' : 'light') : theme;
  document.documentElement.setAttribute('data-theme', resolved);
}

darkMediaQuery?.addEventListener('change', () => {
  if (settings.theme === 'system') applyTheme('system');
});

applyTheme();
