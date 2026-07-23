import { svelte } from '@sveltejs/vite-plugin-svelte';
import { nip5aManifest } from '@napplet/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    svelte(),
    tailwindcss(),
    nip5aManifest({
      nappletType: 'browse',
      requires: ['outbox', 'inc', 'identity', 'common', 'count', 'resource', 'intent'],
      artifactMode: 'single-file',
      // The protocol names the payload SHAPE this role accepts — an unnumbered
      // convention per the naps repo, not a NAP domain.
      archetypes: [{ slug: 'browse', naps: ['napplet:browse/open'] }],
    }),
  ],
  build: {
    modulePreload: { polyfill: false },
    outDir: 'dist',
  },
});
