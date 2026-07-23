import { svelte } from '@sveltejs/vite-plugin-svelte';
import { nip5aManifest } from '@napplet/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    svelte(),
    tailwindcss(),
    nip5aManifest({
      nappletType: 'edit-object',
      requires: ['outbox', 'upload', 'identity', 'storage', 'resource', 'intent'],
      artifactMode: 'single-file',
      archetypes: [{ slug: 'edit-object', naps: ['outbox', 'upload', 'identity'] }],
    }),
  ],
  build: {
    modulePreload: { polyfill: false },
    outDir: 'dist',
  },
});
