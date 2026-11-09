import { svelte } from '@sveltejs/vite-plugin-svelte';
import { nip5aManifest } from '@napplet/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { icon } from '../../scripts/lib/napplet-metadata';

export default defineConfig({
  plugins: [
    svelte(),
    tailwindcss(),
    nip5aManifest({
      nappletType: 'part-upload',
      description: 'Upload 3D model files to Blossom and publish reusable parts on Nostr.',
      icon,
      requires: ['upload', 'outbox', 'identity', 'intent'],
      artifactMode: 'single-file',
      archetypes: [
        { slug: 'part-upload', convention: 'napplet:part-upload/open' },
        { slug: 'part-upload', convention: 'napplet:part-upload/create' },
      ],
    }),
  ],
  build: {
    modulePreload: { polyfill: false },
    outDir: 'dist',
  },
});
