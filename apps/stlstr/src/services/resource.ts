import { createResourceService, type ResourceInfo } from '@kehto/services';
import type { ServiceHandler } from '@kehto/runtime';
import type { User } from 'applesauce-common/casts';
import { mergeBlossomServers } from 'applesauce-common/helpers/blossom';
import { Actions, buildBlossomURI, parseBlossomURI } from 'blossom-client-sdk';
import { firstDefinedValue } from './observable';
import { getFallbackBlossomServers } from './settings';

/**
 * NAP-RESOURCE is the only network-fetch primitive a sandboxed napplet has, so this
 * service is the shell's network and content boundary. Napplets hand us URLs; we decide
 * which schemes are fetchable, how big responses may be, and what MIME type the bytes
 * actually are.
 */

/** Response size cap. NAP-RESOURCE recommends 10 MiB. */
const MAX_BYTES = 10 * 1024 * 1024;
/** Per-request URL cap for `resource.bytesMany`. */
const MAX_URLS = 100;
/** Per-URL fetch timeout. */
const FETCH_TIMEOUT_MS = 30_000;
/** In-flight fetches allowed across all napplets in this shell. */
const MAX_CONCURRENT_FETCHES = 8;

/**
 * Grant sentinel. Printable cover images live on arbitrary Blossom servers and CDNs, so a
 * static per-napplet origin allowlist cannot work for this product. Every napplet gets
 * the wildcard and `isOriginGranted` applies the URL policy below instead.
 */
const ANY_MEDIA_ORIGIN = '*';

type PolicyFailure = string | null;

async function getBlossomServers(user: User | null): Promise<string[]> {
  const fallback = mergeBlossomServers(getFallbackBlossomServers()).map((server) =>
    server.toString(),
  );
  if (!user) return fallback;

  const listed = mergeBlossomServers(await firstDefinedValue(user.blossomServers$)).map((server) =>
    server.toString(),
  );
  return listed.length > 0 ? listed : fallback;
}

/**
 * Decides whether a URL may be fetched at all. Returns a reason when it may not.
 */
function checkUrlPolicy(rawUrl: string): PolicyFailure {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return `not a valid URL: ${rawUrl}`;
  }

  if (url.protocol === 'http:' || url.protocol === 'https:') return null;
  if (url.protocol === 'blossom:') return null;

  return `unsupported scheme: ${url.protocol}`;
}

function originPasses(origin: string): boolean {
  // Custom schemes such as `blossom:` have an opaque `null` origin. Let the fetch
  // policy inspect the full URI and candidate server list before any network request.
  if (origin === 'null') return true;
  // `origin` is already scheme://host[:port], so the URL policy applies unchanged.
  return checkUrlPolicy(origin) === null;
}

function serverPassesPolicy(server: string): boolean {
  try {
    const url = new URL(server.includes('://') ? server : `https://${server}`);
    return checkUrlPolicy(url.origin) === null;
  } catch {
    return false;
  }
}

function resolveBlossomDownload(rawUrl: string, servers: string[]) {
  const parsed = parseBlossomURI(rawUrl);
  if (parsed.size !== undefined && parsed.size > MAX_BYTES) {
    throw new Error(`declared blossom blob is larger than ${MAX_BYTES} bytes`);
  }

  const safeHints = parsed.servers.filter(serverPassesPolicy);
  const safeFallbacks = servers.filter(serverPassesPolicy);
  if (safeHints.length === 0 && safeFallbacks.length === 0) {
    throw new Error('No policy-allowed Blossom servers are available for this blob.');
  }

  parsed.servers = safeHints;
  return { uri: buildBlossomURI(parsed), fallbackServers: safeFallbacks };
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function hasAscii(bytes: Uint8Array, text: string, offset: number): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

/**
 * Classifies bytes by magic number. The upstream `Content-Type` is attacker-controlled
 * and NAP-RESOURCE requires that it never reaches the napplet.
 */
export function sniffMimeType(bytes: Uint8Array): string {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (hasAscii(bytes, 'RIFF', 0) && hasAscii(bytes, 'WEBP', 8)) return 'image/webp';
  if (hasAscii(bytes, 'ftypavif', 4)) return 'image/avif';
  if (hasAscii(bytes, 'ftypheic', 4) || hasAscii(bytes, 'ftypheix', 4)) return 'image/heic';
  if (startsWith(bytes, [0x42, 0x4d])) return 'image/bmp';
  if (hasAscii(bytes, '%PDF-', 0)) return 'application/pdf';
  if (hasAscii(bytes, 'ftyp', 4)) return 'video/mp4';
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip';

  // SVG is XML, so it has no magic number. Sniff the head of the document instead.
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 256))
    .trimStart()
    .toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return 'image/svg+xml';
  }

  return 'application/octet-stream';
}

async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error(`response is larger than ${limit} bytes`);
  }

  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > limit) throw new Error(`response is larger than ${limit} bytes`);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > limit) throw new Error(`response is larger than ${limit} bytes`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Caps how many upstream fetches the shell runs at once, across every napplet. */
function createFetchQueue(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];

  function release() {
    active -= 1;
    waiting.shift()?.();
  }

  return async function withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

export type ResourceServiceOptions = {
  /** Resolves a napplet window to its NIP-5D identity, normally the session registry. */
  resolveIdentity: (windowId: string) => { dTag: string; aggregateHash: string } | null;
  /** Current account, used only to prefer the user's Blossom server list for downloads. */
  getActiveUser: () => User | null;
};

/**
 * Creates the shell's NAP-RESOURCE handler.
 *
 * Known gap: raw `image/svg+xml` must be rasterized before delivery. The shell has no
 * rasterizer yet, so SVG responses are rejected instead of being passed through.
 */
export function createStlstrResourceService({
  resolveIdentity,
  getActiveUser,
}: ResourceServiceOptions): ServiceHandler {
  const withSlot = createFetchQueue(MAX_CONCURRENT_FETCHES);

  const resourceInfo: ResourceInfo = {
    schemes: [
      { scheme: 'https', enabled: true },
      { scheme: 'http', enabled: true },
      { scheme: 'data', enabled: true },
      { scheme: 'blossom', enabled: true },
      { scheme: 'htree', enabled: false },
      { scheme: 'nostr', enabled: false },
    ],
    maxBytes: MAX_BYTES,
    maxUrls: MAX_URLS,
  };

  return createResourceService({
    resourceInfo,
    resolveIdentity,

    getConnectGrants: () => [ANY_MEDIA_ORIGIN, ...getFallbackBlossomServers()],

    isOriginGranted: (origin, grants) => {
      if (grants.includes(ANY_MEDIA_ORIGIN)) return originPasses(origin);
      return grants.includes(origin) && originPasses(origin);
    },

    fetch: async (url, init) =>
      withSlot(async () => {
        // A rejection thrown here reaches the napplet as `network-error`: the service maps
        // fetch failures to that code and only forwards the reason as a detail message the
        // shim drops. Log the real reason so shell-side refusals stay debuggable.
        const reject = (reason: string): never => {
          console.warn('[stlstr] resource refused', { url, reason });
          throw new Error(reason);
        };

        const failure = checkUrlPolicy(url);
        if (failure) reject(failure);

        const timeout = new AbortController();
        const abortForTimeout = () => timeout.abort();
        const timer = window.setTimeout(abortForTimeout, FETCH_TIMEOUT_MS);
        init.signal.addEventListener('abort', abortForTimeout);

        try {
          const isBlossomUrl = new URL(url).protocol === 'blossom:';
          const response = isBlossomUrl
            ? await (async () => {
                if (init.method && init.method !== 'GET')
                  reject(`unsupported blossom method: ${init.method}`);

                const blossom = resolveBlossomDownload(
                  url,
                  await getBlossomServers(getActiveUser()),
                );
                return Actions.resolveBlob(blossom.uri, {
                  fallbackServers: blossom.fallbackServers,
                  signal: timeout.signal,
                  timeout: FETCH_TIMEOUT_MS,
                });
              })()
            : await fetch(url, {
                method: init.method ?? 'GET',
                headers: init.headers,
                signal: timeout.signal,
                redirect: 'follow',
                credentials: 'omit',
                referrerPolicy: 'no-referrer',
              });

          if (!response.ok) reject(`upstream responded ${response.status}`);

          const bytes = await readCapped(response, MAX_BYTES);
          const mime = sniffMimeType(bytes);

          if (mime === 'image/svg+xml') {
            reject('SVG resources are not delivered until the shell can rasterize them');
          }

          // Re-wrap with the sniffed type so the upstream Content-Type never reaches the napplet.
          return new Response(bytes as unknown as BodyInit, {
            status: response.status,
            headers: { 'content-type': mime },
          });
        } finally {
          window.clearTimeout(timer);
          init.signal.removeEventListener('abort', abortForTimeout);
        }
      }),
  });
}
