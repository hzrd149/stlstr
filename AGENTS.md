# stlstr Agent Notes

## Purpose

- stlstr is intended to become a Thingiverse replacement built on Nostr events and Blossom files, using the NIP-5D napplet system from `https://napplet.run/`.
- The host app is `apps/stlstr`; it uses Kehto (`https://kehto.github.io/web/docs/`) to embed sandboxed napplet iframes and provide shell/runtime services.
- Product UX belongs in napplets. The shell owns user identity, config, relay/Blossom wiring, window/runtime state, and the NAP APIs napplets call through `window.napplet`.

## Architecture Intent

- Shell stack: Kehto hosts and dispatches napplet protocol messages; Applesauce is the intended Nostr engine behind shell services, not direct `nostr-tools` or ad hoc relay code.
- Use Applesauce docs/MCP before designing shell-side Nostr behavior. Relevant surfaces include `EventStore`, relay pools/loaders, models/casting, account/signing helpers, actions, React bindings, content parsing, encrypted-content caching, event caching, and Blossom/file examples.
- NAP boundary: napplets should be small contained UX pieces that call `@napplet/sdk`; the shell translates those NAP calls into identity, config, Nostr, Blossom, storage, cache, media, and relay behavior.
- Planned napplet domains are product slices such as browsing parts, uploading STL/files, thing/detail views, maker profiles, collections, comments/reactions, and makes. `counter` is only the current reference napplet proving NAP-STORAGE wiring.

## Repo Shape

- pnpm workspace, not npm/yarn: packages are `apps/*`, `lib/*`, `napplets/*`, and `tools/*`.
- Root requires Node `>=20`, pnpm `>=10`; lockfile/packageManager currently pins `pnpm@11.16.0`.
- `apps/stlstr` is the React/Vite host app. `napplets/*` are standalone NIP-5D napplets built to `dist/`.
- `tools/napplet-cli` provides the workspace `napplet` bin by shelling out to Deno/JSR `@napplet/cli`; Deno must exist for `napplet discover`, `deploy`, `debug`, and root conformance scripts.

## Commands

- Install with `pnpm install`; `pnpm-workspace.yaml` intentionally allows only `esbuild` postinstall builds and disables Puppeteer's browser download.
- Full local dev is `pnpm dev`: starts `@apps/stlstr` on `127.0.0.1:5173`, builds every napplet with `vite build --watch`, writes `apps/stlstr/public/napplets.dev.json`, and starts Kehto Paja on `127.0.0.1:5197`.
- Use `pnpm dev --no-paja` for host + napplet build-watch only. Dev ports can be overridden with `--host`, `--app-port`, `--paja-port` or `STLSTR_DEV_HOST`, `STLSTR_APP_PORT`, `STLSTR_PAJA_PORT`, `STLSTR_NO_PAJA=1`.
- Root `pnpm build` only builds napplets. Build the host with `pnpm build:app` or `pnpm --filter @apps/stlstr build`.
- Focused napplet verification: `pnpm --filter counter verify`; conformance: `pnpm --filter counter test:conformance`.
- Root verification: `pnpm verify` runs `pnpm test`, then turbo `type-check` and `build` for `napplets/*` and `lib/*`; it does not build/lint the host app.
- Host lint/build checks are separate: `pnpm --filter @apps/stlstr lint` and `pnpm --filter @apps/stlstr build`.
- Browser smoke tests are separate: `pnpm test:browser` requires a system Chromium or `PUPPETEER_EXECUTABLE_PATH`, writes the dev registry, builds `counter`, and serves the host on `127.0.0.1:5174` by default (`STLSTR_TEST_HOST` / `STLSTR_TEST_PORT` override it).
- Formatting is Prettier via `pnpm format:check` / `pnpm format`; `pnpm-lock.yaml`, `dist`, `.turbo`, and napplet sidecar manifests are ignored by Prettier.

## Napplet Workflow

- Scaffold new napplets with `pnpm new <name> ["Display Title"] [-- <generator flags>]`; this wraps `npx @napplet/boilerplate` and then `scripts/lib/adopt.mjs` normalizes the package for this monorepo.
- Napplet folder names double as deploy `d` tags; `adopt.mjs` warns if names are not lowercase/digit/hyphen and at most 13 chars.
- Do not add app-owned `@napplet/shim` imports in napplets. Kehto injects `window.napplet`; napplet app code should use `@napplet/sdk`.
- Napplet `vite.config.ts` must declare every used NAP in `nip5aManifest({ requires: [...] })`; the host injects grants from that list.
- Napplet builds should stay single-file artifacts by using `artifactMode: 'single-file'`; host dev serves `napplets/<name>/dist` at `/napplets.dev/<name>/`.
- For normal dev, napplets are not run as Vite dev servers; `pnpm dev` serves their built `dist/index.html` from the host origin.

## Host Wiring

- `apps/stlstr/src/App.tsx` currently loads the `counter` napplet into a sandboxed iframe with `sandbox="allow-scripts"` and injects only the `storage` domain.
- The current `createNoopAdapter()` is a dev placeholder; real shell services should be Kehto adapters backed by Applesauce state, loaders, signers, cache, relay selection, and Blossom upload/publish flows.
- `apps/stlstr/vite.config.ts` has a dev-only middleware for `/napplets.dev.json` and `/napplets.dev/<name>/*`; if a napplet 404s in the host, build/watch its `dist` first.
- The dev registry `apps/stlstr/public/napplets.dev.json` is generated by `pnpm dev` and is gitignored; do not commit it.

## Current Gaps

- There is no root `README.md` or CI workflow in the current tree; trust package scripts and config over stale template prose in package READMEs.
- `@apps/stlstr` still depends on `nostr-tools`; replace shell-side Nostr plumbing with Applesauce packages as NAP service handlers are implemented.
