import { createIdentityService } from '@kehto/services';
import type { ServiceHandler } from '@kehto/runtime';
import type { ISigner } from 'applesauce-signers';
import { getUser } from './nostr';

/**
 * NAP-IDENTITY — the single channel by which napplets learn who the user is.
 *
 * Strictly read-only: napplets learn *about* the user, never act *as* them. There is no
 * signing, encryption, or decryption here; publishing goes through NAP-OUTBOX, where the
 * shell holds the signer.
 *
 * `getPublicKey` and `getRelays` resolve through the signer. Everything else is answered
 * from the shell's own Applesauce event store rather than the signer, for two reasons: a
 * NIP-07 extension only implements the first two, and the shell has already loaded and
 * cached this data, so a napplet asking for it should never cause a relay round trip it
 * cannot see.
 *
 * Identity is a moving target. This service only answers questions; the push that keeps
 * napplets current is `bridge.publishIdentityChanged(pubkey)` in `App.tsx`, sent on every
 * account change. Both halves are required — without the push, a napplet that asked at
 * mount holds a stale answer forever.
 */

export type IdentityServiceOptions = {
  getSigner: () => ISigner | null;
};

/** How long to wait for a cached/loading value before answering with what we have. */
const RESOLVE_TIMEOUT_MS = 2_000;

type ObservableLike<T> = {
  subscribe(observer: (value: T) => void): { unsubscribe(): void };
};

/**
 * Resolves the first defined value from a reactive cast, or undefined on timeout.
 *
 * These observables replay a cached value synchronously when the store already holds the
 * event, so the timeout only applies to a cold lookup that is still in flight.
 */
function firstDefinedValue<T>(
  observable: ObservableLike<T | undefined>,
  timeoutMs = RESOLVE_TIMEOUT_MS,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false;

    const settle = (value: T | undefined) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      subscription.unsubscribe();
      resolve(value);
    };

    const subscription = observable.subscribe((value) => {
      if (value !== undefined) settle(value);
    });
    const timeout = window.setTimeout(() => settle(undefined), timeoutMs);
  });
}

/** Reads a string field off an untyped profile record, dropping blanks. */
function text(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function createStlstrIdentityService({ getSigner }: IdentityServiceOptions): ServiceHandler {
  return createIdentityService({
    // `getRelays` also resolves through the signer, so it only answers for signers that
    // implement NIP-07's getRelays; remote signers generally do not. Backing it from the
    // user's NIP-65 mailboxes needs a hook the service does not expose yet.
    getSigner,

    /**
     * The signed-in user's kind:0, mapped onto NAP-IDENTITY's `ProfileData`.
     *
     * Nostr metadata uses `display_name`; the NAP shape uses `displayName`. Napplets should
     * not have to know that, so the translation happens here.
     */
    getProfile: async (pubkey) => {
      if (!pubkey) return null;

      const profile = await firstDefinedValue(
        getUser(pubkey).profile$ as ObservableLike<Record<string, unknown> | undefined>,
      );
      if (!profile) return null;

      return {
        name: text(profile, 'name'),
        displayName: text(profile, 'displayName', 'display_name'),
        about: text(profile, 'about'),
        picture: text(profile, 'picture'),
        banner: text(profile, 'banner'),
        nip05: text(profile, 'nip05'),
        lud16: text(profile, 'lud16'),
        website: text(profile, 'website'),
      };
    },

    /** The user's follow list (NIP-02), as hex pubkeys. */
    getFollows: async (pubkey) => {
      if (!pubkey) return [];
      const contacts = await firstDefinedValue(
        getUser(pubkey).contacts$ as ObservableLike<{ pubkey: string }[] | undefined>,
      );
      return contacts?.map((contact) => contact.pubkey) ?? [];
    },

    /** Public mutes only. Private mute entries stay with the shell; they need the signer. */
    getMutes: async (pubkey) => {
      if (!pubkey) return [];
      const mutes = await firstDefinedValue(
        getUser(pubkey).mutes$ as ObservableLike<{ pubkeys?: string[] } | undefined>,
      );
      return mutes?.pubkeys ?? [];
    },
  });
}
