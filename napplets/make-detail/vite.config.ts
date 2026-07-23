import { svelte } from '@sveltejs/vite-plugin-svelte';
import { nip5aManifest } from '@napplet/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    svelte(),
    tailwindcss(),
    nip5aManifest({
      nappletType: 'make-detail',
      // `inc` delivers the route payload, `outbox` resolves the kind:2351 make, its parent
      // object, and its comments; `identity` names the viewer so comments can be composed;
      // `count` shows the comment count; `resource` fetches make photos; `intent` opens the
      // parent print and the maker profile.
      requires: ['inc', 'outbox', 'identity', 'count', 'resource', 'intent', 'theme'],
      artifactMode: 'single-file',
      archetypes: [{ slug: 'make-detail', naps: ['napplet:make-detail/open'] }],
    }),
  ],
  build: {
    modulePreload: { polyfill: false },
    outDir: 'dist',
  },
});
