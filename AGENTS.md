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

## Product UX

- stlstr is a user-facing product, not a protocol debugger. Normal UI should show human-readable names, profile metadata, object titles, thumbnails, and friendly status text instead of raw hex IDs, event JSON, full pubkeys, relay internals, or other debug/protocol details.
- Raw pubkeys, event IDs, relay URLs, and JSON are acceptable only in explicit advanced/debug views, logs, developer tooling, or copy/export actions where the user intentionally asks for protocol-level data.

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

## Source Control

- **Commit every finished feature.** As soon as a unit of work builds and its checks pass, commit it. Uncommitted work is the only work that can be lost, and this tree has already lost a day's worth once.
- Do not batch a whole session into one commit at the end. Commit at each point the tree is coherent — a shell service, a napplet, a test suite — so any single mistake costs one step instead of everything.
- **More than one agent may be editing this tree at the same time.** Before running anything that discards working-tree state, assume someone else has uncommitted work in it and check `git status` first. `git reset --hard`, `git checkout -- .`, `git clean`, and `git stash` all destroy other agents' changes without warning; a stash is not safe just because it is reversible in principle, because the next `git stash drop` makes it unreachable.
- Prefer committing over stashing. If you need a clean tree, commit the current state (a WIP commit is fine and can be amended) rather than shelving it.
- If work does go missing, it is usually still in the object store: `git reflog` shows resets, and `git fsck --unreachable --dangling` finds dropped stash commits and orphaned blobs. Back up the working tree before attempting any recovery.
- Never commit generated artifacts — `dist`, `.turbo`, `apps/stlstr/public/napplets.dev.json`, and napplet sidecar manifests are all ignored on purpose.

## Napplet Workflow

- Scaffold new napplets with `pnpm new <name> ["Display Title"] [-- <generator flags>]`; this wraps `npx @napplet/boilerplate` and then `scripts/lib/adopt.mjs` normalizes the package for this monorepo.
- Napplet folder names double as deploy `d` tags; `adopt.mjs` warns if names are not lowercase/digit/hyphen and at most 13 chars.
- Do not add app-owned `@napplet/shim` imports in napplets. Kehto injects `window.napplet`; napplet app code should use `@napplet/sdk`.
- Napplet `vite.config.ts` must declare every used NAP in `nip5aManifest({ requires: [...] })`; the host injects grants from that list.
- Napplet builds should stay single-file artifacts by using `artifactMode: 'single-file'`; host dev serves `napplets/<name>/dist` at `/napplets.dev/<name>/`.
- For normal dev, napplets are not run as Vite dev servers; `pnpm dev` serves their built `dist/index.html` from the host origin.
- Napplets MUST NOT render their own title bars, card wrappers, or visible borders; they are seamless embedded surfaces in the stlstr shell. Napplets MUST use DaisyUI (on Tailwind) so their visual language matches the host. See the `build-napplet` skill's "Visual Integration" section for the full contract.

## Host Wiring

- `apps/stlstr/src/App.tsx` routes each path to a napplet in a sandboxed iframe with `sandbox="allow-scripts"`, injecting only the NAP domains that route grants.
- `@kehto/runtime` handles `storage`, `media`, `keys`, `notify`, and `theme` itself; every other domain (`outbox`, `upload`, `resource`, `intent`, `common`, `count`, `lists`, `link`, ...) is **service-only** and does nothing until the shell registers a handler in `createStlstrAdapter().services`. Unhandled messages surface through `onUnroutedMessage`.
- Registered so far: `outbox` and `upload` (Applesauce/Blossom backed), `resource` (`services/resource.ts`), `intent` (`services/intent.ts`), `identity` (`@kehto/services`, signer-backed), and `link` (`services/links.ts`). `common` and `count` are granted on some routes but still unregistered.
- NAP-IDENTITY is read-only and request/response, so a napplet that asked "who is signed in?" at mount holds a stale answer until the shell pushes `bridge.injectEvent('identity:changed', { pubkey })`. That push is what lets owner-gated actions appear on login without a reload.
- NAP-RESOURCE is the shell's fetch boundary: any `https` origin is grantable, but the host `fetch` enforces scheme, private-host, 10 MiB, 30s, and concurrency limits and re-types every response by sniffing so upstream `Content-Type` never reaches a napplet. Dev builds also allow `http` to private hosts for the local Blossom server.
- NAP-INTENT resolves archetypes to shell routes rather than new windows, so `intent.open('object-detail', { address })` is a navigation. Navigation is deferred a tick so the caller's result arrives before its iframe unmounts.
- `apps/stlstr/vite.config.ts` has a dev-only middleware for `/napplets.dev.json` and `/napplets.dev/<name>/*`; if a napplet 404s in the host, build/watch its `dist` first.
- The dev registry `apps/stlstr/public/napplets.dev.json` is generated by `pnpm dev` and is gitignored; do not commit it.

## Current Gaps

- There is no root `README.md` or CI workflow in the current tree; trust package scripts and config over stale template prose in package READMEs.
- NAP-RESOURCE rejects `image/svg+xml` instead of rasterizing it, as the spec requires; there is no rasterizer yet. It also cannot re-check resolved addresses after DNS the way the policy describes, because browsers do not expose that.
- Refusals raised inside the host `fetch` reach napplets as `network-error` with no detail — `@kehto/services` only maps pre-fetch grant failures to `blocked-by-policy`. The shell logs the real reason to the console.
- `@apps/stlstr` still depends on `nostr-tools`; replace shell-side Nostr plumbing with Applesauce packages as NAP service handlers are implemented.
