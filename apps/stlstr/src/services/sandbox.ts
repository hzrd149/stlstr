/**
 * sandbox.ts — hardening applied to a napplet artifact before it becomes an iframe srcdoc.
 *
 * The `sandbox="allow-scripts"` attribute already denies a napplet the shell's DOM, cookies,
 * and storage. It does not deny it a NIP-07 browser extension: extensions inject
 * `window.nostr` into every frame, srcdoc frames included. A napplet that found it there
 * could read the user's pubkey and ask for signatures completely outside the NAP boundary —
 * no grant, no consent prompt, and nothing the shell could see or revoke.
 *
 * So the frame is closed off at the source. Napplets learn who the user is through
 * NAP-IDENTITY and publish through NAP-OUTBOX, where the shell holds the signer and applies
 * policy. There is no third way.
 */

/**
 * Runs before any napplet code, including the injected NAP prelude.
 *
 * The property is defined as non-configurable so a content script that injects later cannot
 * replace it. Reading yields `undefined` rather than throwing, so ordinary feature
 * detection (`if (window.nostr)`) simply fails and the napplet falls back to NAP-IDENTITY;
 * an actual call still fails loudly on its own as a TypeError.
 */
const NOSTR_GUARD = `<script>(function () {
  var warned = false;
  function warn(action) {
    if (warned) return;
    warned = true;
    console.error(
      '[stlstr] This napplet tried to ' + action + ' window.nostr. Napplets must use ' +
        'NAP-IDENTITY to read the user and NAP-OUTBOX to publish; direct signer access is denied.'
    );
  }
  try {
    delete window.nostr;
  } catch (error) {
    // A non-configurable injection cannot be removed; the define below will also fail.
  }
  try {
    Object.defineProperty(window, 'nostr', {
      configurable: false,
      enumerable: false,
      get: function () {
        warn('read');
        return undefined;
      },
      set: function () {
        warn('replace');
      },
    });
  } catch (error) {
    console.error('[stlstr] could not seal window.nostr in a napplet frame', error);
  }
})();</script>`;

/**
 * Inserts the guard as the first thing in the document.
 *
 * Falls back to prefixing the artifact when there is no `<head>`, which still runs the
 * guard first because the parser reaches it before any napplet script.
 */
export function sealNappletFrame(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (!head) return `${NOSTR_GUARD}${html}`;

  const at = head.index + head[0].length;
  return `${html.slice(0, at)}${NOSTR_GUARD}${html.slice(at)}`;
}
