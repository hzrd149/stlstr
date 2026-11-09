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
      nappletType: 'print-detail',
      description: 'Explore a printable project, download its parts, and share makes and comments.',
      icon,
      // The shell grants exactly this list; optional domains stay optional by
      // being guarded at runtime (`if (window.napplet?.count)`), not by being
      // absent here. `intent` both receives the route payload and opens other views.
      requires: [
        'outbox',
        'identity',
        'common',
        'count',
        'resource',
        'link',
        'intent',
        'theme',
        'storage',
      ],
      artifactMode: 'single-file',
      // The protocol names the payload SHAPE this role accepts — an unnumbered
      // convention per the naps repo, not a NAP domain.
      archetypes: [{ slug: 'printable-detail', convention: 'napplet:printable-detail/open' }],
    }),
  ],
  build: {
    modulePreload: { polyfill: false },
    outDir: 'dist',
  },
});
