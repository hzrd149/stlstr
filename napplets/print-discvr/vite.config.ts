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
      nappletType: 'print-discvr',
      description: 'Discover 3D-printable projects shared by makers on Nostr.',
      icon,
      requires: ['outbox', 'inc', 'intent', 'resource', 'identity'],
      artifactMode: 'single-file',
      archetypes: [{ slug: 'printable-discovery', convention: 'napplet:printable-discovery/open' }],
    }),
  ],
  build: {
    modulePreload: { polyfill: false },
    outDir: 'dist',
  },
});
