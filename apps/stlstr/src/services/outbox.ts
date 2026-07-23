import type { NappletMessage, NostrEvent, NostrFilter, RelayEventResult } from '@napplet/core';
import type {
  OutboxCloseMessage,
  OutboxGetEventMessage,
  OutboxPublishMessage,
  OutboxQueryMessage,
  OutboxResolveRelaysMessage,
  OutboxSubscribeMessage,
} from '@napplet/nap/outbox/types';
import type { ServiceHandler } from '@kehto/runtime';
import type { User } from 'applesauce-common/casts';
import type { ISigner } from 'applesauce-signers';
import type { NostrEvent as ApplesauceNostrEvent } from 'nostr-tools';
import type { Filter } from 'applesauce-core/helpers/filter';
import { mergeRelaySets } from 'applesauce-core/helpers/relays';
import { eventStore, STLSTR_DEV_MODE, relayPool } from './nostr';
import { getAppRelays } from './settings';

type ObservableLike<T> = {
  subscribe(observer: (value: T) => void): { unsubscribe(): void };
};

type ActiveUserProvider = () => User | null;
type SignerProvider = () => ISigner | null;

type PublishOutcome = {
  ok: boolean;
  relays: Record<string, boolean>;
  error?: string;
};

type TrackedSubscription = {
  unsubscribe(): void;
};

export type OutboxServiceOptions = {
  getActiveUser: ActiveUserProvider;
  getSigner: SignerProvider;
};

const DEFAULT_TIMEOUT_MS = 8_000;

function normalizeFilters(filters: NostrFilter | NostrFilter[]): NostrFilter[] {
  return Array.isArray(filters) ? filters : [filters];
}

function relayResult(event: NostrEvent, relays: string[]): RelayEventResult {
  return { event, sidecar: { relayHints: relays } };
}

function firstDefinedValue<T>(observable: ObservableLike<T | undefined>, timeoutMs = 1_500) {
  return new Promise<T | undefined>((resolve) => {
    let settled = false;
    const subscription = observable.subscribe((value) => {
      if (value === undefined || settled) return;
      settled = true;
      window.clearTimeout(timeout);
      subscription.unsubscribe();
      resolve(value);
    });

    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      subscription.unsubscribe();
      resolve(undefined);
    }, timeoutMs);
  });
}

async function getUserOutboxes(user: User | null): Promise<string[]> {
  if (!user) return [];
  return mergeRelaySets(await firstDefinedValue(user.outboxes$));
}

async function getUserInboxes(user: User | null): Promise<string[]> {
  if (!user) return [];
  return mergeRelaySets(await firstDefinedValue(user.inboxes$));
}

function collectAuthors(filters: NostrFilter[], hints: string[] = []): string[] {
  return [...new Set([...hints, ...filters.flatMap((filter) => filter.authors ?? [])])];
}

async function resolveReadRelays(
  getActiveUser: ActiveUserProvider,
  filters: NostrFilter[],
  options?: { authors?: string[]; relays?: string[] },
) {
  if (STLSTR_DEV_MODE)
    return { relays: getAppRelays(), source: 'policy' as const, missingAuthors: [] };

  const authors = collectAuthors(filters, options?.authors);
  const relays = mergeRelaySets(options?.relays);
  const missingAuthors: string[] = [];

  if (authors.length === 0) {
    return {
      relays: mergeRelaySets(relays, getAppRelays()),
      source: 'fallback' as const,
      missingAuthors,
    };
  }

  for (const author of authors) {
    const outboxes = await getUserOutboxes(
      author === getActiveUser()?.pubkey ? getActiveUser() : null,
    );
    if (outboxes.length === 0) missingAuthors.push(author);
    for (const relay of outboxes) relays.push(relay);
  }

  // The authors' own relay lists are authoritative; app relays only cover authors we
  // could not resolve a list for.
  const unresolved = missingAuthors.length > 0;

  return {
    relays: unresolved ? mergeRelaySets(relays, getAppRelays()) : mergeRelaySets(relays),
    source: missingAuthors.length === authors.length ? ('fallback' as const) : ('nip65' as const),
    missingAuthors,
  };
}

async function resolvePublishRelays(
  getActiveUser: ActiveUserProvider,
  options?: { relays?: string[]; toOutbox?: boolean; toInboxes?: string[] },
) {
  if (STLSTR_DEV_MODE) return getAppRelays();

  const activeUser = getActiveUser();
  const relays = mergeRelaySets(options?.relays);
  let usedAccountList = false;

  if (options?.toOutbox !== false) {
    const outboxes = await getUserOutboxes(activeUser);
    usedAccountList ||= outboxes.length > 0;
    for (const relay of outboxes) relays.push(relay);
  }

  // V1 only has the active user's reactive cast hydrated. Unknown recipient inboxes
  // fall back to explicit relays and the app's broad relay set until settings/loading expands.
  if ((options?.toInboxes ?? []).includes(activeUser?.pubkey ?? '')) {
    const inboxes = await getUserInboxes(activeUser);
    usedAccountList ||= inboxes.length > 0;
    for (const relay of inboxes) relays.push(relay);
  }

  // Publish to the account's own relays when it has a list; app relays are the fallback.
  if (usedAccountList) return mergeRelaySets(relays);

  return mergeRelaySets(relays, getAppRelays());
}

async function queryRelays(relays: string[], filters: NostrFilter[], timeoutMs: number) {
  const events: RelayEventResult[] = [];

  await new Promise<void>((resolve, reject) => {
    const subscription = relayPool
      .request(relays, filters as Filter[], { timeout: timeoutMs, eventStore })
      .subscribe({
        next: (event) => {
          eventStore.add(event as ApplesauceNostrEvent);
          events.push(relayResult(event as NostrEvent, relays));
        },
        error: reject,
        complete: resolve,
      });

    window.setTimeout(() => {
      subscription.unsubscribe();
      resolve();
    }, timeoutMs + 250);
  });

  return events;
}

async function publishToRelays(event: NostrEvent, relays: string[]): Promise<PublishOutcome> {
  if (relays.length === 0) return { ok: false, relays: {}, error: 'No relays are configured.' };

  try {
    const responses = await relayPool.publish(relays, event as ApplesauceNostrEvent);
    const results = Object.fromEntries(responses.map((response) => [response.from, response.ok]));
    const ok = Object.values(results).some(Boolean);
    eventStore.add(event as ApplesauceNostrEvent);
    return { ok, relays: results, error: ok ? undefined : 'All relays rejected the event.' };
  } catch (cause) {
    return {
      ok: false,
      relays: Object.fromEntries(relays.map((relay) => [relay, false])),
      error: cause instanceof Error ? cause.message : 'Publish failed.',
    };
  }
}

export function createOutboxService({
  getActiveUser,
  getSigner,
}: OutboxServiceOptions): ServiceHandler {
  const subscriptions = new Map<string, TrackedSubscription>();

  async function handleGetEvent(
    message: OutboxGetEventMessage,
    send: (msg: NappletMessage) => void,
  ) {
    const filters: NostrFilter[] = [
      {
        ids: [message.eventId],
        authors: message.options?.author ? [message.options.author] : undefined,
        limit: 1,
      },
    ];
    const plan = await resolveReadRelays(getActiveUser, filters, {
      authors: message.options?.author ? [message.options.author] : [],
      relays: message.options?.relays,
    });
    const events = await queryRelays(
      plan.relays,
      filters,
      message.options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    send({
      type: 'outbox.getEvent.result',
      id: message.id,
      result: events[0],
      incomplete: false,
    } as NappletMessage);
  }

  async function handleQuery(message: OutboxQueryMessage, send: (msg: NappletMessage) => void) {
    const filters = normalizeFilters(message.filters);
    const plan = await resolveReadRelays(getActiveUser, filters, message.options);
    const events = await queryRelays(
      plan.relays,
      filters,
      message.options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    send({
      type: 'outbox.query.result',
      id: message.id,
      events:
        typeof message.options?.limit === 'number'
          ? events.slice(0, message.options.limit)
          : events,
      incomplete: false,
    } as NappletMessage);
  }

  async function handleSubscribe(
    windowId: string,
    message: OutboxSubscribeMessage,
    send: (msg: NappletMessage) => void,
  ) {
    const filters = normalizeFilters(message.filters);
    const plan = await resolveReadRelays(getActiveUser, filters, message.options);
    const key = `${windowId}:${message.subId}`;
    subscriptions.get(key)?.unsubscribe();

    const subscription = relayPool
      .subscription(plan.relays, filters as Filter[], { eventStore, id: message.subId })
      .subscribe({
        next: (event) => {
          eventStore.add(event as ApplesauceNostrEvent);
          send({
            type: 'outbox.event',
            subId: message.subId,
            result: relayResult(event as NostrEvent, plan.relays),
          } as NappletMessage);
        },
        error: (cause) => {
          subscriptions.delete(key);
          send({
            type: 'outbox.closed',
            subId: message.subId,
            reason: cause instanceof Error ? cause.message : 'Subscription failed.',
          } as NappletMessage);
        },
        complete: () => {
          subscriptions.delete(key);
          send({ type: 'outbox.closed', subId: message.subId } as NappletMessage);
        },
      });

    subscriptions.set(key, subscription);
  }

  async function handlePublish(message: OutboxPublishMessage, send: (msg: NappletMessage) => void) {
    const signer = getSigner();
    if (!signer) {
      send({
        type: 'outbox.publish.result',
        id: message.id,
        ok: false,
        error: 'Login required to publish.',
      } as NappletMessage);
      return;
    }

    try {
      const event = (await signer.signEvent(message.event)) as NostrEvent;
      const relays = await resolvePublishRelays(getActiveUser, message.options);
      const result = await publishToRelays(event, relays);
      send({
        type: 'outbox.publish.result',
        id: message.id,
        ok: result.ok,
        event,
        eventId: event.id,
        relays: result.relays,
        error: result.error,
      } as NappletMessage);
    } catch (cause) {
      send({
        type: 'outbox.publish.result',
        id: message.id,
        ok: false,
        error: cause instanceof Error ? cause.message : 'Signing failed.',
      } as NappletMessage);
    }
  }

  async function handleResolveRelays(
    message: OutboxResolveRelaysMessage,
    send: (msg: NappletMessage) => void,
  ) {
    const targetAuthors =
      message.target.authors ?? (message.target.pubkey ? [message.target.pubkey] : []);
    const plan = await resolveReadRelays(getActiveUser, [{ authors: targetAuthors }], {
      authors: targetAuthors,
    });
    send({ type: 'outbox.resolveRelays.result', id: message.id, plan } as NappletMessage);
  }

  return {
    descriptor: {
      name: 'outbox',
      version: '0.1.0',
      description: 'stlstr Applesauce outbox routing',
    },
    handleMessage(windowId, message, send) {
      if (message.type === 'outbox.getEvent')
        void handleGetEvent(message as OutboxGetEventMessage, send);
      else if (message.type === 'outbox.query')
        void handleQuery(message as OutboxQueryMessage, send);
      else if (message.type === 'outbox.subscribe')
        void handleSubscribe(windowId, message as OutboxSubscribeMessage, send);
      else if (message.type === 'outbox.close') {
        const close = message as OutboxCloseMessage;
        subscriptions.get(`${windowId}:${close.subId}`)?.unsubscribe();
        subscriptions.delete(`${windowId}:${close.subId}`);
      } else if (message.type === 'outbox.publish')
        void handlePublish(message as OutboxPublishMessage, send);
      else if (message.type === 'outbox.resolveRelays')
        void handleResolveRelays(message as OutboxResolveRelaysMessage, send);
    },
    onWindowDestroyed(windowId) {
      for (const [key, subscription] of subscriptions) {
        if (!key.startsWith(`${windowId}:`)) continue;
        subscription.unsubscribe();
        subscriptions.delete(key);
      }
    },
  };
}
