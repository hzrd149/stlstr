import { svelte } from '@sveltejs/vite-plugin-svelte';
import { nip5aManifest } from '@napplet/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    svelte(),
    tailwindcss(),
    nip5aManifest({
      nappletType: 'print-edit',
      // `intent` sends the user to the printable after a successful save; `storage`
      // keeps the unsaved draft. Both stay optional at runtime (guarded via
      // `napplets().intent` / `.storage`), but the shell grants exactly this list,
      // so leaving them out is what makes the feature dead rather than degraded.
      requires: ['outbox', 'inc', 'identity', 'upload', 'resource', 'intent', 'storage'],
      artifactMode: 'single-file',
      archetypes: [
        {
          slug: 'printable-edit',
          naps: ['napplet:printable-edit/open', 'napplet:printable-edit/edit'],
        },
      ],
    }),
  ],
  build: {
    modulePreload: { polyfill: false },
    outDir: 'dist',
  },
});
