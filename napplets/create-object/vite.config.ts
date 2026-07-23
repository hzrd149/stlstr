import { svelte } from '@sveltejs/vite-plugin-svelte';
import { nip5aManifest } from '@napplet/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    svelte(),
    tailwindcss(),
    nip5aManifest({
      nappletType: 'create-object',
      requires: ['upload', 'outbox', 'identity', 'storage', 'intent'],
      artifactMode: 'single-file',
      archetypes: [
        { slug: 'create-object', naps: ['upload', 'outbox', 'identity', 'storage', 'intent'] },
      ],
    }),
  ],
  build: {
    modulePreload: { polyfill: false },
    outDir: 'dist',
  },
});
