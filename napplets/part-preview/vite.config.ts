import { svelte } from '@sveltejs/vite-plugin-svelte';
import { nip5aManifest } from '@napplet/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    svelte(),
    tailwindcss(),
    nip5aManifest({
      nappletType: 'part-preview',
      // `inc` is the NAP-INTENT payload delivery seam, `resource` the only way a sandboxed
      // napplet can pull the mesh bytes, and `link` hands oversized parts back to the shell
      // as a download. All are guarded at runtime so a shell that omits one still renders.
      requires: ['inc', 'outbox', 'resource', 'link', 'intent', 'theme'],
      artifactMode: 'single-file',
      // The protocol names the payload SHAPE this role accepts — an unnumbered convention
      // per the naps repo, not a NAP domain.
      archetypes: [{ slug: 'part-preview', naps: ['napplet:part-preview/open'] }],
    }),
  ],
  build: {
    modulePreload: { polyfill: false },
    outDir: 'dist',
  },
});
