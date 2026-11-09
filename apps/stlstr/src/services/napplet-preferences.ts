import { preferenceDraft } from './napplet-preference-event';
import { NAPPLET_HANDLERS_KIND } from 'applesauce-common/helpers';
import type { NappletHandlers } from 'applesauce-common/casts';
import { onlyEvents } from 'applesauce-relay';
import { firstValueFrom, Subscription, timeout, toArray } from 'rxjs';
import { nip19 } from 'nostr-tools';
import { accountManager, accountManagerReady } from './accounts';
import { ARCHETYPES, conventionsFor, conventionId } from './intent-map';
import { eventStore, getUser, relayPool, STLSTR_LOCAL_MODE } from './nostr';
import {
  getAppRelays,
  getSettings,
  setNappletOverride as setLocal,
  removeNappletOverride as removeLocal,
  type NappletOverride,
} from './settings';
import { resolveNappletNaddr, type ResolvedNapplet } from './napplets';

type Preferences = {
  pubkey?: string;
  loading: boolean;
  saving: boolean;
  error?: string;
  handlers: Record<string, NappletHandlers>;
  resolved: Record<string, ResolvedNapplet>;
};
let state: Preferences = { loading: false, saving: false, handlers: {}, resolved: {} };
const listeners = new Set<() => void>();
export const getNappletPreferences = () => state;
export function subscribeToNappletPreferences(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function update(patch: Partial<Preferences>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

async function userRelays(pubkey: string) {
  if (STLSTR_LOCAL_MODE) return getAppRelays();
  const outboxes = await getUser(pubkey).outboxes$.$first(2000, []);
  return [...new Set([...(outboxes ?? []), ...getAppRelays()])];
}

let generation = 0;
let subscriptions = new Subscription();
export function refreshNappletPreferences() {
  const account = accountManager.active;
  const current = ++generation;
  subscriptions.unsubscribe();
  subscriptions = new Subscription();
  update({
    pubkey: account?.pubkey,
    loading: !!account,
    saving: false,
    error: undefined,
    handlers: {},
    resolved: {},
  });
  if (!account) return;
  const revisions = new Map<string, number>();
  for (const archetype of Object.keys(ARCHETYPES)) {
    subscriptions.add(
      getUser(account.pubkey)
        .nappletHandlers(archetype)
        .subscribe((handlers) => {
          const revision = (revisions.get(archetype) ?? 0) + 1;
          revisions.set(archetype, revision);
          const next = { ...state.handlers };
          if (handlers) next[archetype] = handlers;
          else delete next[archetype];
          update({ handlers: next });
          void (async () => {
            if (handlers?.hasHidden) await handlers.unlock(account);
            const resolved: Record<string, ResolvedNapplet> = {};
            for (const identity of conventionsFor(archetype)) {
              for (const { ref } of handlers?.candidates(identity) ?? []) {
                // The current artifact loader accepts named manifests via naddr.
                if (ref.type !== 'address' || !ref.pointer.identifier) continue;
                try {
                  const napplet = await resolveNappletNaddr(
                    nip19.naddrEncode(ref.pointer),
                    archetype,
                  );
                  // Exact convention match: a napplet is only preferred for verbs it declares.
                  if (!napplet.conventions.includes(identity)) continue;
                  resolved[identity] = napplet;
                  break;
                } catch {
                  /* Try the next handler, then the bundled default. */
                }
              }
            }
            if (current !== generation || revisions.get(archetype) !== revision) return;
            const merged = { ...state.resolved };
            for (const identity of conventionsFor(archetype)) delete merged[identity];
            update({ resolved: { ...merged, ...resolved } });
          })().catch((error: unknown) => {
            if (current === generation) update({ error: String(error) });
          });
        }),
    );
  }
  void (async () => {
    const relays = await userRelays(account.pubkey);
    if (current !== generation) return;
    const filter = { kinds: [NAPPLET_HANDLERS_KIND], authors: [account.pubkey] };
    // Keep receiving changes made by another device after the initial load.
    subscriptions.add(
      relayPool
        .subscription(relays, filter)
        .pipe(onlyEvents())
        .subscribe({
          next: (event) => eventStore.add(event),
          error: (error: unknown) => {
            if (current === generation) update({ error: String(error) });
          },
        }),
    );
    await firstValueFrom(relayPool.request(relays, filter).pipe(timeout(12000), toArray())).then(
      (events) => {
        for (const event of events) eventStore.add(event);
      },
    );
    if (current === generation) update({ loading: false });
  })().catch((error: unknown) => {
    if (current === generation)
      update({ loading: false, error: `Could not load napplet preferences: ${String(error)}` });
  });
}
void accountManagerReady.then(() => {
  accountManager.active$.subscribe(() => refreshNappletPreferences());
});

export function preferredNapplet(archetype: string, action = 'open') {
  return state.pubkey === accountManager.active?.pubkey
    ? state.resolved[conventionId(archetype, action)]
    : undefined;
}

/** One read-modify-sign-publish per page choice, preserving unrelated intent entries. */
export async function setNappletOverride(archetype: string, override?: NappletOverride) {
  const account = accountManager.active;
  if (!account) {
    if (override) setLocal(archetype, override);
    else removeLocal(archetype);
    return;
  }
  if (state.pubkey !== account.pubkey || state.loading || state.saving || state.error)
    throw new Error(state.error ?? 'Please wait for napplet preferences to finish syncing.');
  const current = generation;
  update({ saving: true });
  try {
    const existing = state.handlers[archetype];
    const pointer = override ? nip19.decode(override.naddr) : undefined;
    if (pointer && pointer.type !== 'naddr') throw new Error('Invalid napplet address.');
    const factory = preferenceDraft(
      archetype,
      conventionsFor(archetype),
      existing?.event,
      pointer?.type === 'naddr' ? pointer.data : undefined,
    );
    const event = await factory.sign(account);
    if (current !== generation) throw new Error('Account changed before saving.');
    const relays = await userRelays(account.pubkey);
    if (current !== generation) throw new Error('Account changed before saving.');
    const results = await relayPool.publish(relays, event);
    if (!results.some((result) => result.ok))
      throw new Error('No relay accepted your napplet preferences. Try again.');
    eventStore.add(event);
  } finally {
    if (current === generation) update({ saving: false });
  }
}

export const removeNappletOverride = (archetype: string) => setNappletOverride(archetype);
export async function resetNappletOverrides() {
  const pubkey = accountManager.active?.pubkey;
  const keys = pubkey ? Object.keys(state.handlers) : Object.keys(getSettings().nappletOverrides);
  for (const archetype of keys) {
    if (accountManager.active?.pubkey !== pubkey)
      throw new Error('Account changed before resetting.');
    await removeNappletOverride(archetype);
  }
}
