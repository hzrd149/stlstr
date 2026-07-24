/**
 * Reading Nostr tags.
 *
 * Every napplet that inspects an event ends up wanting the first value of a named tag —
 * a printable's `d`, `title`, or `summary`, a file's `url` — trimmed, with a missing tag
 * treated the same as an empty one. This is that one helper.
 */

/** The trimmed value of the first tag with this name, or '' when there is none. */
export function tagValue(tags: string[][], name: string): string {
  return tags.find((tag) => tag[0] === name)?.[1]?.trim() ?? '';
}
