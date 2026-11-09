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
      nappletType: 'print-create',
      description:
        'Create a printable project with model parts, photos, and printing instructions.',
      icon,
      requires: ['upload', 'outbox', 'identity', 'storage', 'intent', 'resource'],
      artifactMode: 'single-file',
      archetypes: [
        {
          slug: 'printable-create',
          convention: 'napplet:printable-create/open',
        },
        {
          slug: 'printable-create',
          convention: 'napplet:printable-create/create',
        },
      ],
    }),
  ],
  build: {
    modulePreload: { polyfill: false },
    outDir: 'dist',
  },
});
