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
      nappletType: 'user-profile',
      description: 'Explore a maker profile and the printable projects and makes they have shared.',
      icon,
      // The shell grants exactly this list. `intent` delivers the pubkey to show; the
      // rest are guarded at runtime so a shell that omits one still works.
      requires: ['outbox', 'resource', 'identity', 'intent'],
      artifactMode: 'single-file',
      // The protocol names the payload SHAPE this role accepts — an unnumbered
      // convention per the naps repo, not a NAP domain.
      archetypes: [{ slug: 'profile', convention: 'napplet:profile/open' }],
    }),
  ],
  build: {
    modulePreload: { polyfill: false },
    outDir: 'dist',
  },
});
