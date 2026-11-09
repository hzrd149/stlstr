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
      nappletType: 'make-detail',
      description: 'View a completed 3D print, its photos, maker notes, and discussion.',
      icon,
      // `intent` receives the route payload, `outbox` resolves the kind:2351 make, its parent
      // printable, and its comments; `identity` names the viewer so comments can be composed;
      // `count` shows the comment count; `resource` fetches make photos; `intent` opens the
      // parent print and the maker profile.
      requires: ['outbox', 'identity', 'count', 'resource', 'intent', 'theme'],
      artifactMode: 'single-file',
      archetypes: [{ slug: 'make-detail', convention: 'napplet:make-detail/open' }],
    }),
  ],
  build: {
    modulePreload: { polyfill: false },
    outDir: 'dist',
  },
});
