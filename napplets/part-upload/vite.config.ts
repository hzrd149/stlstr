import { svelte } from '@sveltejs/vite-plugin-svelte';
import { nip5aManifest } from '@napplet/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    svelte(),
    tailwindcss(),
    nip5aManifest({
      nappletType: 'part-upload',
      requires: ['upload', 'outbox', 'identity', 'inc', 'intent'],
      artifactMode: 'single-file',
      archetypes: [
        { slug: 'part-upload', naps: ['napplet:part-upload/open', 'napplet:part-upload/create'] },
      ],
    }),
  ],
  build: {
    modulePreload: { polyfill: false },
    outDir: 'dist',
  },
});
