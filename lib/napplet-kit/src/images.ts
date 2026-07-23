/**
 * Image loading through NAP-RESOURCE.
 *
 * A remote image URL is outside a napplet's authority boundary: pointing an `<img>` at one
 * would disclose the reader's IP to whatever host an untrusted author chose, and would
 * bypass the shell's content policy entirely. So every image — cover, thumbnail, avatar —
 * is fetched as bytes by the shell and turned into an object URL here.
 *
 * Loads are gated so a long list does not burst the shell with fetches.
 *
 * `napplets/print-detail/src/lib/images.ts` is an older copy of this and should be
 * migrated onto it once the napplet rename in flight has settled.
 */

import { resource } from '@napplet/sdk';
import { hasDomain } from './capabilities';

const MAX_IN_FLIGHT = 4;

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
  if (next) next();
  else active -= 1;
}

export function hasResource(): boolean {
  return hasDomain('resource');
}

/**
 * Fetches an image and returns an object URL, or '' when it cannot be shown.
 *
 * Callers own the URL and MUST revoke it. A refusal is not surfaced as an error: the shell
 * blocks SVG and private hosts by policy, and a list is still usable without art.
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
