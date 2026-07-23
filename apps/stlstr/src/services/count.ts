import type { CountResult, NappletMessage, NostrFilter } from '@napplet/core';
import type { CountQueryMessage } from '@napplet/nap/count/types';
import type { ServiceHandler } from '@kehto/runtime';
import type { Filter } from 'applesauce-core/helpers/filter';
import { relayPool } from './nostr';
import { normalizeFilters } from './relay-query';
import { getAppRelays } from './settings';

type RelayCountResponse = {
  count: number;
};

const DEFAULT_TIMEOUT_MS = 8_000;

function countRelays(
  relays: string[],
  filters: NostrFilter[],
  id: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  return new Promise<CountResult>((resolve) => {
    let settled = false;
    let latest: Record<string, RelayCountResponse> | null = null;
    let timeout = 0;
    let subscription: { unsubscribe(): void } | null = null;

    const finish = (result: CountResult) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      subscription?.unsubscribe();
      resolve(result);
    };

    subscription = relayPool.count(relays, filters as Filter[], id).subscribe({
      next: (response) => {
        latest = response;
        finish({
          ok: true,
          count: Object.values(response).reduce((total, relay) => total + relay.count, 0),
          relays: Object.keys(response),
        });
      },
      error: (cause) => {
        finish({
          ok: false,
          error: 'count-failed',
          reason: cause instanceof Error ? cause.message : 'Count query failed.',
          relays,
        });
      },
      complete: () => {
        finish({
          ok: true,
          count: latest
            ? Object.values(latest).reduce((total, relay) => total + relay.count, 0)
            : 0,
          relays: latest ? Object.keys(latest) : relays,
        });
      },
    });

    timeout = window.setTimeout(() => {
      finish({
        ok: false,
        error: 'timeout',
        reason: 'Count query timed out.',
        relays,
      });
    }, timeoutMs);
  });
}

export function createCountService(): ServiceHandler {
  async function handleQuery(message: CountQueryMessage, send: (msg: NappletMessage) => void) {
    const relays = getAppRelays();

    if (relays.length === 0) {
      send({
        type: 'count.query.result',
        id: message.id,
        ok: false,
        error: 'no-relays',
        reason: 'No relays are configured.',
      } as NappletMessage);
      return;
    }

    const result = await countRelays(relays, normalizeFilters(message.filters), message.id);

    send({
      type: 'count.query.result',
      id: message.id,
      ...result,
    } as NappletMessage);
  }

  return {
    descriptor: {
      name: 'count',
      version: '0.1.0',
      description: 'stlstr Applesauce count routing',
    },
    handleMessage(_windowId, message, send) {
      if (message.type === 'count.query') void handleQuery(message as CountQueryMessage, send);
    },
  };
}
