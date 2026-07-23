import { svelte } from '@sveltejs/vite-plugin-svelte';
import { nip5aManifest } from '@napplet/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    svelte(),
    tailwindcss(),
    nip5aManifest({
      nappletType: 'browse-objects',
      requires: ['outbox'],
      artifactMode: 'single-file',
      archetypes: [{ slug: 'browse-objects', naps: ['outbox'] }],
    }),
  ],
  build: {
    modulePreload: { polyfill: false },
    outDir: 'dist',
  },
});
