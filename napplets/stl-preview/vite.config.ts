import { svelte } from '@sveltejs/vite-plugin-svelte';
import { nip5aManifest } from '@napplet/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    svelte(),
    tailwindcss(),
    nip5aManifest({
      nappletType: 'stl-preview',
      // `inc` delivers the intent payload, `resource` fetches the STL bytes, and `link`
      // lets oversized or unsupported files fall back to a shell-mediated download.
      requires: ['inc', 'resource', 'link', 'theme'],
      artifactMode: 'single-file',
      archetypes: [{ slug: 'stl-preview', naps: ['napplet:stl-preview/open'] }],
    }),
  ],
  build: {
    modulePreload: { polyfill: false },
    outDir: 'dist',
  },
});
