/** Helpers for handing printable files to local slicer integrations. */

export type SlicerOpenFile = {
  url: string;
  name: string;
};

export type SlicerCompatibility =
  { ok: true; extensions: string[] } | { ok: false; extensions: string[]; reason: string };

export const SLICERBRIDGE_PROTOCOL = 'slicerbridge:';

export const SLICER_SUPPORTED_EXTENSIONS = [
  'stl',
  '3mf',
  'obj',
  'step',
  'stp',
  'gcode',
  'bgcode',
  'zip',
] as const;

const supported = new Set<string>(SLICER_SUPPORTED_EXTENSIONS);

export function slicerFileExtension(name: string): string {
  const match = name
    .trim()
    .toLowerCase()
    .match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? '';
}

export function isSlicerOpenableFile(file: SlicerOpenFile): boolean {
  if (!supported.has(slicerFileExtension(file.name))) return false;

  try {
    const url = new URL(file.url);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function slicerCompatibilityInfo(files: SlicerOpenFile[]): SlicerCompatibility {
  const extensions = [
    ...new Set(files.map((file) => slicerFileExtension(file.name)).filter(Boolean)),
  ];
  if (extensions.length <= 1) return { ok: true, extensions };

  return {
    ok: false,
    extensions,
    reason: `Cannot open mixed file types together: ${extensions
      .map((extension) => `.${extension}`)
      .join(' + ')}. Open one type at a time.`,
  };
}

export function buildSlicerBridgeUri(files: SlicerOpenFile[]): string | null {
  const openable = files.filter(isSlicerOpenableFile);
  if (openable.length === 0) return null;

  const compatibility = slicerCompatibilityInfo(openable);
  if (!compatibility.ok) return null;

  const params = new URLSearchParams();
  for (const file of openable) {
    params.append('file', file.url);
    params.append('name', file.name || 'model');
  }

  return `slicerbridge://multi?${params.toString()}`;
}
