/**
 * Shared NIP-94 (`kind:1063`) file handling for napplets.
 *
 * Per NIP.md a printable does not contain its files: it references them as
 * independent `kind:1063` events, marked with a role on the printable's `e` tag. The role
 * therefore belongs to the *reference*, not to the file — the same event can be a `part`
 * in one printable and `aux` in another — so nothing in this module carries a role field.
 * Callers that have a printable in hand read the role off the `e` tag themselves.
 */

import type { NostrEvent, NostrTag } from '@napplet/sdk';
import { tagValue } from './tags';

/** The `kind:1063` events this module reads and writes. */
export const FILE_KIND = 1063;

/** The `kind:33500` printables that reference them. */
export const PRINTABLE_KIND = 33500;

/** The `kind:2351` makes users publish for a printable (NIP.md). */
export const MAKE_KIND = 2351;

/**
 * What a `kind:1063` event says about its file.
 *
 * Everything except `url` is best-effort: NIP-94 marks these tags recommended rather than
 * required, and files published by other clients routinely omit them.
 */
export type FileMeta = {
  /** Where the bytes are. The one field without which the event is useless. */
  url: string;
  /** Display name, falling back to the URL basename. Never empty. */
  name: string;
  /** Declared MIME type, or an empty string when the event did not say. */
  mime: string;
  /** Declared size in bytes, or 0 when unknown or unparseable. */
  sizeBytes: number;
  /** SHA-256 of the file, used to recognise the same bytes across events. */
  sha256: string;
  /**
   * Preview image URL, or an empty string when the publisher supplied none.
   *
   * A printable file has no inherent preview — an STL is raw geometry — so per NIP.md this
   * is the only affordable way to show one in a list. Rendering the model instead would
   * mean fetching and parsing every file on the page, and files above the shell's resource
   * ceiling could not be shown at all.
   */
  thumb: string;
  /** Placeholder to show while `thumb` loads. Empty when not published. */
  blurhash: string;
  /** Description of the preview, for accessibility. Empty when not published. */
  alt: string;
};

/** Extensions treated as 3D models, for previewability and the library's model filter. */
const MODEL_EXTENSIONS = ['.stl', '.3mf', '.obj', '.step', '.stp', '.gcode', '.ply'];

/** MIME types that represent printable/manufacturing part files, not docs or aux assets. */
export const PRINTABLE_PART_MIME_TYPES = [
  'model/stl',
  'application/sla',
  'model/3mf',
  'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
  'model/obj',
  'model/step',
  'model/step+xml',
  'application/step',
  'model/ply',
  'text/x.gcode',
  'application/x-gcode',
  'application/gcode',
] as const;

const printablePartMimeTypes = new Set<string>(PRINTABLE_PART_MIME_TYPES);

/**
 * Mirrors the shell's NAP-RESOURCE `MAX_BYTES`. A file above it cannot be fetched for
 * preview at all, so callers check the published size before offering the action rather
 * than starting a request destined to be refused mid-stream.
 */
export const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

/** The filename at the end of a URL, for files whose event carries no `name` tag. */
export function basename(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) || 'file';
  } catch {
    return 'file';
  }
}

/** Reads the NIP-94 tags off a `kind:1063` event. Returns null when there is no URL. */
export function readFileMeta(tags: string[][]): FileMeta | null {
  const url = tagValue(tags, 'url');
  if (!url) return null;

  const size = Number(tagValue(tags, 'size'));
  return {
    url,
    name: tagValue(tags, 'name') || tagValue(tags, 'alt') || basename(url),
    mime: tagValue(tags, 'm'),
    sizeBytes: Number.isFinite(size) && size > 0 ? size : 0,
    sha256: tagValue(tags, 'x'),
    // `image` is the larger preview; it stands in when only it was published.
    thumb: tagValue(tags, 'thumb') || tagValue(tags, 'image'),
    blurhash: tagValue(tags, 'blurhash'),
    alt: tagValue(tags, 'alt'),
  };
}

/** True when the file looks like a 3D model, by MIME type first and extension second. */
export function isModelFile(meta: FileMeta): boolean {
  if (meta.mime.startsWith('model/')) return true;
  const name = meta.name.toLowerCase();
  return MODEL_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/** True when the file declares a printable part MIME type. */
export function isPrintablePartFile(meta: FileMeta): boolean {
  return printablePartMimeTypes.has(meta.mime.toLowerCase());
}

/** True when the shell's resource service could fetch this file for a 3D preview. */
export function isPreviewable(meta: FileMeta): boolean {
  // A missing size is not evidence the file is small, but refusing to preview every file
  // that omitted the tag would be worse: the fetch itself enforces the real limit.
  return isModelFile(meta) && meta.sizeBytes <= MAX_PREVIEW_BYTES;
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The shape NAP-UPLOAD returns, narrowed to the fields NIP-94 tags are built from. */
export type UploadOutcome = {
  url?: string;
  sha256?: string;
  originalSha256?: string;
  size?: number;
  mimeType?: string;
  fallbackUrls?: string[];
  dimensions?: { width: number; height: number };
  blurhash?: string;
  nip94?: NostrTag[];
};

/**
 * Builds the NIP-94 tags for a `kind:1063` event from an upload result.
 *
 * `name` is not optional here even though NIP-94 calls it recommended: every consumer in
 * this codebase reads it, and a file without one shows up as the literal string "Part
 * file". The shell's upload service does not return it, because it describes the user's
 * intent rather than the stored blob, so it has to be threaded through from the caller.
 *
 * The shell's own `nip94` tags are preferred when present — it knows what it actually
 * stored — but `name` is appended either way.
 */
export function nip94TagsFromUpload(
  result: UploadOutcome,
  name: string,
  mime?: string,
): NostrTag[] {
  const tags: NostrTag[] = [];

  if (Array.isArray(result.nip94) && result.nip94.length > 0) {
    tags.push(...result.nip94.filter(([tag]) => tag !== 'name'));
  } else {
    if (result.url) tags.push(['url', result.url]);
    tags.push(['m', result.mimeType ?? mime ?? 'application/octet-stream']);
    if (result.sha256) tags.push(['x', result.sha256]);
    if (result.originalSha256) tags.push(['ox', result.originalSha256]);
    if (result.size != null) tags.push(['size', String(result.size)]);
    if (result.dimensions) {
      tags.push(['dim', `${result.dimensions.width}x${result.dimensions.height}`]);
    }
    for (const fallbackUrl of result.fallbackUrls ?? []) tags.push(['fallback', fallbackUrl]);
  }

  if (name.trim()) tags.push(['name', name.trim()]);
  return tags;
}

/**
 * Converts NIP-94 tags into a NIP-92 `imeta` tag for an inline image.
 *
 * `ox` is dropped: it describes the pre-transform blob, which is meaningless to a client
 * rendering the image. `name` is dropped too — `imeta` carries `alt` instead.
 */
export function imetaFromNip94(tags: NostrTag[], alt: string, blurhash?: string): NostrTag {
  const fields = tags
    .filter(([name]) => name !== 'ox' && name !== 'name')
    .map(([name, value]) => `${name} ${value}`);

  if (blurhash) fields.push(`blurhash ${blurhash}`);
  if (alt.trim()) fields.push(`alt ${alt.trim()}`);
  return ['imeta', ...fields];
}

/**
 * The file ids a printable references, optionally narrowed to one role.
 *
 * The role is the fourth element of the `e` tag, per NIP.md. Order is the printable's own
 * publication order and is preserved: it is the only sequencing a client has.
 */
export function fileIdsFor(event: NostrEvent, role?: string): string[] {
  return event.tags
    .filter((tag) => tag[0] === 'e' && tag[1] && (role === undefined || tag[3] === role))
    .map((tag) => tag[1]);
}
