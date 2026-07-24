import { WebSocket } from 'ws';

/**
 * Seeds fixture events into the local dev relay for browser tests.
 *
 * Browser tests run against `STLSTR_DEV_MODE`, which pins every read to the local dev relay
 * — the same one that is expected to be running for `pnpm dev`. Rather than stand up a
 * second relay, the fixtures are published into that one, so tests and manual development
 * see the same printables.
 *
 * Seeding is idempotent: fixture keys and timestamps are fixed, so republishing produces
 * the same event ids rather than accumulating duplicates.
 */

const PUBLISH_TIMEOUT_MS = 10_000;

/**
 * Publishes the fixture events and resolves once the relay has acknowledged them all.
 *
 * @param {{ relayUrl: string, events: object[] }} options
 * @returns {Promise<{ relayUrl: string, published: number }>}
 */
export async function seedTestRelay({ relayUrl, events }) {
  if (events.length === 0) return { relayUrl, published: 0 };

  const socket = new WebSocket(relayUrl);
  const pending = new Set(events.map((event) => event.id));

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `Timed out seeding ${relayUrl}. Is the local dev relay running? ` +
                `${pending.size} of ${events.length} events were never acknowledged.`,
            ),
          ),
        PUBLISH_TIMEOUT_MS,
      );

      const settle = (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };

      socket.on('error', (error) =>
        settle(new Error(`Could not reach the dev relay at ${relayUrl}: ${error.message}`)),
      );

      socket.on('open', () => {
        for (const event of events) socket.send(JSON.stringify(['EVENT', event]));
      });

      socket.on('message', (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }
        // ["OK", <id>, <accepted>, <reason>] — a duplicate still comes back accepted.
        if (!Array.isArray(message) || message[0] !== 'OK') return;

        if (message[2] === false) {
          settle(new Error(`The dev relay rejected a fixture event: ${message[3] || 'no reason'}`));
          return;
        }

        pending.delete(message[1]);
        if (pending.size === 0) settle();
      });
    });
  } finally {
    socket.close();
  }

  return { relayUrl, published: events.length };
}
