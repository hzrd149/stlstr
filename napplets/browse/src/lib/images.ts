/**
 * Cover-image loading through NAP-RESOURCE.
 *
 * Napplets have no network of their own, so every remote image goes through
 * `resource.bytes()` and becomes an object URL. A feed can hold dozens of cards, so loads
 * are gated: without a cap the shell gets a burst of fetches the moment the grid renders.
 */

import { resource } from '@napplet/sdk';

const MAX_IN_FLIGHT = 6;

let active = 0;
const waiting: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MAX_IN_FLIGHT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  // Hand the slot straight to the next waiter rather than decrementing and racing.
  if (next) next();
  else active -= 1;
}

/** True when the shell provides NAP-RESOURCE; optional domains must be feature-detected. */
export function hasResource(): boolean {
  return typeof (window as Window & { napplet?: Record<string, unknown> }).napplet?.resource ===
    'object';
}

/**
 * Fetches an image and returns an object URL, or '' when it cannot be shown.
 *
 * Callers own the returned URL and MUST revoke it. A refusal is not an error worth
 * surfacing — the shell blocks SVG and private hosts by policy, and a card without art is
 * still a usable card.
 */
export async function loadImageUrl(url: string): Promise<string> {
  if (!url || !hasResource()) return '';

  await acquire();
  try {
    const blob = await resource.bytes(url);
    if (!blob.type.startsWith('image/')) return '';
    return URL.createObjectURL(blob);
  } catch {
    return '';
  } finally {
    release();
  }
}
