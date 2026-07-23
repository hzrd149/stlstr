import { svelte } from '@sveltejs/vite-plugin-svelte';
import { nip5aManifest } from '@napplet/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    svelte(),
    nip5aManifest({
      nappletType: 'counter',
      requires: ['storage'],
      artifactMode: 'single-file',
      archetypes: [{ slug: 'counter', naps: ['counter'] }],
    }),
  ],
  build: {
    modulePreload: { polyfill: false },
    outDir: 'dist',
  },
});
