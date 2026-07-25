import { createLinkService } from '@kehto/services';
import type { ServiceHandler } from '@kehto/runtime';
import { STLSTR_LOCAL_MODE } from './nostr';

function isAllowedSlicerBridgeUrl(url: URL): boolean {
  if (url.protocol !== 'slicerbridge:' || url.hostname !== 'multi') return false;

  const files = url.searchParams.getAll('file');
  if (files.length === 0) return false;

  return files.every((file) => {
    try {
      const source = new URL(file);
      return source.protocol === 'http:' || source.protocol === 'https:';
    } catch {
      return false;
    }
  });
}

function isAllowedExternalLink(url: URL): boolean {
  if (url.protocol === 'slicerbridge:') return isAllowedSlicerBridgeUrl(url);
  return true;
}

/**
 * NAP-LINK — shell-mediated navigation out of the sandbox.
 *
 * Napplets cannot navigate the top-level page, so downloads and outbound links come here.
 * This is deliberately used instead of NAP-RESOURCE for file downloads: pulling a
 * multi-megabyte STL across postMessage only to re-offer it as a blob wastes memory the
 * napplet does not have, and the shell already owns download policy.
 *
 * `createLinkService` denies everything unless an opener is supplied, so the policy below
 * is the whole allowlist.
 */
export function createStlstrLinkService(): ServiceHandler {
  return createLinkService({
    // `pnpm local` builds serve files from a local Blossom server over plain http.
    allowedProtocols: STLSTR_LOCAL_MODE
      ? ['https:', 'http:', 'slicerbridge:']
      : ['https:', 'slicerbridge:'],
    open: ({ url }) => {
      if (!isAllowedExternalLink(url)) {
        console.warn('[stlstr] link.open rejected by policy', url.href);
        return { status: 'denied' };
      }

      // `noopener` severs window.opener so the target can never reach back into the shell.
      const opened = window.open(url.href, '_blank', 'noopener,noreferrer');
      if (!opened) {
        console.warn('[stlstr] link.open was blocked by the browser', url.href);
        return { status: 'denied' };
      }
      return { status: 'opened' };
    },
  });
}
