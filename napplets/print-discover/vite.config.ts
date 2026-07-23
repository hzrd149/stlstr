import { svelte } from '@sveltejs/vite-plugin-svelte';
import { nip5aManifest } from '@napplet/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    svelte(),
    tailwindcss(),
    nip5aManifest({
      nappletType: 'print-discover',
      requires: ['outbox', 'inc', 'intent', 'resource', 'identity'],
      artifactMode: 'single-file',
      archetypes: [{ slug: 'printable-discovery', naps: ['napplet:printable-discovery/open'] }],
    }),
  ],
  build: {
    modulePreload: { polyfill: false },
    outDir: 'dist',
  },
});
