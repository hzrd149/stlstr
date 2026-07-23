/**
 * Markdown parsing for object descriptions (see NIP.md, "Markdown Content").
 *
 * The description is written by whoever published the event, so rendering it is a security
 * boundary rather than a formatting concern. This module produces a *token tree* and never
 * an HTML string: the Svelte components walk the tokens and emit elements, so there is no
 * point at which untrusted text could become markup, and therefore no sanitizer to keep
 * correct. `{@html}` must not appear anywhere in the rendering path.
 *
 * `marked` is used purely as a lexer for the same reason — `marked.parse()` would hand back
 * exactly the HTML string this design exists to avoid.
 */

import { marked, type Token, type Tokens } from 'marked';

export type { Token, Tokens };

/**
 * Destinations a link or image may use. NIP.md requires refusing everything else; the ones
 * that matter are `javascript:` (script execution) and `data:` (arbitrary inline documents).
 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'nostr:']);

/**
 * Returns the destination if it is safe to render, or '' if it is not.
 *
 * Relative destinations are refused rather than resolved: an event has no base URL, so a
 * relative path would resolve against the napplet's own origin, which is never what the
 * author meant and leaks the shell's structure into the page.
 */
export function safeUrl(raw: string | null | undefined): string {
  if (!raw) return '';

  try {
    // `about:blank` is an opaque base, so anything relative — including the protocol-relative
    // `//host/path` — throws rather than resolving, which is the refusal we want.
    const url = new URL(raw, 'about:blank');
    return ALLOWED_PROTOCOLS.has(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Resolves the HTML entity references CommonMark recognises inside text.
 *
 * marked leaves them in the token and relies on its HTML renderer to pass them through to a
 * parser; we have no parser, so an author's `&amp;` would otherwise show up literally. Only
 * the common named entities and numeric references are handled — the full HTML5 table is
 * ~2000 names, and an unresolved one renders as the source text, which is the CommonMark
 * fallback anyway.
 *
 * Apply this ONLY to text: entity references are not recognised inside code spans or code
 * blocks, where `&amp;` means those five characters.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]+);/g, (source, body: string) => {
    if (body[0] !== '#') return NAMED_ENTITIES[body.toLowerCase()] ?? source;

    const code =
      body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);

    // Lone surrogates and out-of-range values would throw; CommonMark maps them to U+FFFD.
    if (!Number.isFinite(code) || code === 0 || code > 0x10ffff) return '�';
    if (code >= 0xd800 && code <= 0xdfff) return '�';
    return String.fromCodePoint(code);
  });
}

/**
 * Lexes a description into block tokens.
 *
 * `gfm` is on for tables, task lists, strikethrough and autolinks, which NIP.md permits.
 * A malformed description yields a single paragraph of its own source rather than throwing:
 * a description that will not parse should still be readable.
 */
export function parseMarkdown(source: string): Token[] {
  const trimmed = source.trim();
  if (!trimmed) return [];

  try {
    return marked.lexer(trimmed, { gfm: true, breaks: false });
  } catch {
    return [{ type: 'paragraph', raw: trimmed, text: trimmed, tokens: [] } as Tokens.Paragraph];
  }
}
