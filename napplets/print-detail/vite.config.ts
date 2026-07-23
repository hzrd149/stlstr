import { svelte } from '@sveltejs/vite-plugin-svelte';
import { nip5aManifest } from '@napplet/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    svelte(),
    tailwindcss(),
    nip5aManifest({
      nappletType: 'print-detail',
      // The shell grants exactly this list; optional domains stay optional by
      // being guarded at runtime (`if (window.napplet?.count)`), not by being
      // absent here. `inc` is the NAP-INTENT payload delivery seam.
      requires: [
        'outbox',
        'inc',
        'identity',
        'common',
        'count',
        'resource',
        'link',
        'intent',
        'theme',
        'storage',
      ],
      artifactMode: 'single-file',
      // The protocol names the payload SHAPE this role accepts — an unnumbered
      // convention per the naps repo, not a NAP domain.
      archetypes: [{ slug: 'printable-detail', naps: ['napplet:printable-detail/open'] }],
    }),
  ],
  build: {
    modulePreload: { polyfill: false },
    outDir: 'dist',
  },
});
