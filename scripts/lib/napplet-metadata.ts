import { readFileSync } from 'node:fs';

// Raster version of the stlstr favicon: NIP-5D icons cannot be SVG.
export const icon = {
  data: readFileSync(new URL('./napplet-icon.png', import.meta.url)),
  mimeType: 'image/png' as const,
};
