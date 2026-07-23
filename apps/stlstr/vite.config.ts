import { defineConfig } from 'vite';
import type { Plugin, ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
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

// https://vite.dev/config/
export default defineConfig({
  plugins: [nappletDistPlugin(), react(), tailwindcss()],
});
