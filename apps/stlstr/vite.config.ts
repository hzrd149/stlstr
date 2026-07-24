import { defineConfig } from 'vite';
import type { Plugin, ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const nappletsRoot = join(repoRoot, 'napplets');
const devRegistryPath = join(repoRoot, 'apps', 'stlstr', 'public', 'napplets.dev.json');

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.wasm': 'application/wasm',
};

function nappletDistPlugin(): Plugin {
  return {
    name: 'stlstr-napplet-dist-dev-server',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/napplets.dev.json', (_req, res) => {
        if (!existsSync(devRegistryPath)) {
          res.statusCode = 404;
          res.end('Run `pnpm dev` to generate the local napplet registry.');
          return;
        }

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(readFileSync(devRegistryPath));
      });

      server.middlewares.use('/napplets.dev', (req, res, next) => {
        const requestPath = decodeURIComponent(req.url?.split('?')[0] ?? '/');
        const parts = requestPath.split('/').filter(Boolean);
        const [nappletName, ...fileParts] = parts;

        if (!nappletName || nappletName.includes('..') || nappletName.includes(sep)) {
          next();
          return;
        }

        const relativeFile = fileParts.length > 0 ? fileParts.join('/') : 'index.html';
        const distRoot = resolve(nappletsRoot, nappletName, 'dist');
        const filePath = resolve(distRoot, normalize(relativeFile));

        if (!filePath.startsWith(`${distRoot}${sep}`) && filePath !== distRoot) {
          res.statusCode = 403;
          res.end('Forbidden');
          return;
        }

        if (!existsSync(filePath)) {
          res.statusCode = 404;
          res.end(`Napplet dist file is not built yet: ${nappletName}/${relativeFile}`);
          return;
        }

        const file = statSync(filePath).isDirectory() ? join(filePath, 'index.html') : filePath;
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.end(`Napplet dist file is not built yet: ${nappletName}/${relativeFile}`);
          return;
        }

        res.setHeader('Content-Type', contentTypes[extname(file)] ?? 'application/octet-stream');
        res.end(readFileSync(file));
      });
    },
  };
}

/**
 * List every napplet workspace whose single-file artifact has been built into
 * its `dist/`. Returns the folder name (== dTag == NIP-5A d tag for the built-in
 * napplets) alongside its absolute dist path.
 */
function listBuiltNapplets(): Array<{ name: string; dist: string }> {
  if (!existsSync(nappletsRoot)) return [];

  return readdirSync(nappletsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, dist: join(nappletsRoot, entry.name, 'dist') }))
    .filter((napplet) => existsSync(join(napplet.dist, 'index.html')))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Recursively collect every file under `dir`, as paths relative to `dir`. */
function walkFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(full).map((child) => join(entry.name, child));
    return [entry.name];
  });
}

/**
 * Production-only: bundle every built-in napplet into the app's own dist so a
 * deployed static site is self-contained. Each napplet's built artifact is
 * emitted at `napplets/<dTag>/…` (same-origin), and a `napplets.json` registry
 * maps each dTag to its artifact URL. The runtime resolves the default napplet
 * for each archetype to `/napplets/<dTag>/index.html` in production (the dev
 * server serves the equivalent live route at `/napplets.dev/<dTag>/`).
 */
function nappletBundlePlugin(): Plugin {
  return {
    name: 'stlstr-napplet-bundle',
    apply: 'build',
    generateBundle() {
      // The dev registry is a local-only artifact (gitignored). If a build runs
      // after `pnpm dev` it would otherwise ship with stale localhost URLs.
      // Vite copies public/ before generateBundle, so drop it from the output.

      const napplets = listBuiltNapplets();
      if (napplets.length === 0) {
        this.warn(
          'No built napplets found under napplets/*/dist. Run `pnpm build` (napplets) before building the app, or use `pnpm build:all`. The deployed app will have no built-in napplets.',
        );
      }

      const registry: Array<{ name: string; url: string }> = [];
      for (const napplet of napplets) {
        for (const file of walkFiles(napplet.dist)) {
          this.emitFile({
            type: 'asset',
            fileName: `napplets/${napplet.name}/${file.split(sep).join('/')}`,
            source: readFileSync(join(napplet.dist, file)),
          });
        }
        registry.push({ name: napplet.name, url: `/napplets/${napplet.name}/index.html` });
      }

      this.emitFile({
        type: 'asset',
        fileName: 'napplets.json',
        source: `${JSON.stringify({ version: 1, napplets: registry }, null, 2)}\n`,
      });
    },
    // Belt-and-suspenders: ensure the dev registry never reaches the output even
    // if it was emitted as a public asset.
    writeBundle(options) {
      const outDir = options.dir ?? resolve(repoRoot, 'apps', 'stlstr', 'dist');
      const staleDevRegistry = join(outDir, 'napplets.dev.json');
      if (
        existsSync(staleDevRegistry) &&
        relative(outDir, staleDevRegistry) === 'napplets.dev.json'
      ) {
        readFileSync(staleDevRegistry); // touch to confirm readable before unlink
        rmSync(staleDevRegistry, { force: true });
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [nappletDistPlugin(), nappletBundlePlugin(), react(), tailwindcss()],
});
