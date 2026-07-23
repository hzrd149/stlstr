import { svelte } from '@sveltejs/vite-plugin-svelte';
import { nip5aManifest } from '@napplet/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    svelte(),
    tailwindcss(),
    nip5aManifest({
      nappletType: 'part-library',
      // `identity` is not optional here the way it is elsewhere: the library is
      // definitionally the signed-in user's own files, so with no pubkey there is no
      // query to run. `link` is what makes a part obtainable rather than only viewable.
      //
      // No `count`: per-file usage counts would need one count query per row, while a
      // single `#e` query over every file id returns the exact same numbers *and* the
      // referencing objects themselves. Declaring it would grant a capability never used.
      //
      // `resource` fetches thumbnail bytes. Pointing an `<img>` at a published `thumb` URL
      // would work, and would leak the reader's IP to whatever host the author chose.
      requires: ['outbox', 'inc', 'identity', 'intent', 'link', 'resource'],
      artifactMode: 'single-file',
      // The protocol names the payload SHAPE this role accepts — an unnumbered
      // convention per the naps repo, not a NAP domain.
      archetypes: [{ slug: 'part-library', naps: ['napplet:part-library/open'] }],
    }),
  ],
  build: {
    modulePreload: { polyfill: false },
    outDir: 'dist',
  },
});
