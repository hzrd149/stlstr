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
      nappletType: 'part-detail',
      description:
        'Inspect a 3D-printable part, download its file, and explore comments and related prints.',
      icon,
      // `inc` delivers the route payload, `outbox` resolves the NIP-94 file event and its
      // comments/usages, `identity` gates comment compose, and `intent` opens related views.
      requires: ['inc', 'outbox', 'resource', 'intent', 'link', 'theme', 'identity', 'count'],
      artifactMode: 'single-file',
      archetypes: [{ slug: 'part-detail', convention: 'napplet:part-detail/open' }],
    }),
  ],
  build: {
    modulePreload: { polyfill: false },
    outDir: 'dist',
  },
});
