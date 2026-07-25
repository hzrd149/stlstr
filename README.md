# stlstr

stlstr is a Thingiverse-style app for publishing, browsing, and discussing 3D printables on Nostr. The host app is intentionally small: it owns identity, relays, Blossom uploads, routing, and sandbox policy. Product UI lives in NIP-5D napplets under `napplets/*`.

This repo publishes those napplets as reusable app surfaces. Other napplet runtimes can embed them by granting the NAP domains in their manifests and delivering the intent payloads for the archetypes below.

## Napplet Archetypes

Each napplet declares one protocol-facing archetype. The folder name is the local package/deploy `d` tag; the archetype is the interoperable role that other runtimes should target with NAP-INTENT.

| Napplet        | Archetype          | Intent action      | Payload                   | Purpose                                                                                                                                                                         |
| -------------- | ------------------ | ------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `print-search` | `printable-search` | `open`             | Optional `query` or `tag` | Search printables and tag-filter printable feeds.                                                                                                                              |
| `user-profile` | `profile`          | `open`             | `pubkey`                  | Show a maker profile and their published printables. This intentionally uses the generic `profile` archetype so profile links work across unrelated napplet collections.         |
| `print-detail` | `printable-detail` | `open`             | `address`                 | Show one printable, its media/files, maker attribution, comments, reactions, and edit actions.                                                                                  |
| `print-create` | `printable-create` | `open` or `create` | Optional `remixOf`        | Publish a new printable and upload its media/files.                                                                                                                             |
| `print-edit`   | `printable-edit`   | `edit`             | `address`                 | Load an owned printable and publish a replacement event.                                                                                                                        |
| `part-detail`  | `part-detail`      | `open`             | `fileId`                  | Show metadata for a NIP-94 part file and offer relevant actions.                                                                                                                |
| `stl-preview`  | `stl-preview`      | `open`             | `url`, optional metadata  | Preview an STL file in 3D from NAP-RESOURCE fetch parameters, usually as an overlay.                                                                                            |

Printable addresses use `33500:<pubkey>:<d>`, where kind `33500` is stlstr's printable event kind. Part details use a Nostr file event id as `fileId`. STL previews use resource metadata such as `{ url, name, mime, size }`; callers resolve any Nostr event before opening the viewer.

## Runtime Contract

The napplets are sandboxed iframe apps built with `@napplet/vite-plugin` in single-file artifact mode. They do not own keys, relay pools, global storage, or direct Blossom credentials. A runtime embedding them should provide capabilities through `window.napplet` according to each manifest's `requires` list.

Common requirements:

- `intent`: open another archetype from inside a napplet.
- `inc`: deliver inbound intent payloads on `<archetype>:<action>` topics after the napplet emits `<archetype>:ready`.
- `outbox`: query and publish Nostr events through the runtime's relay/signing policy.
- `identity`: expose the current user's pubkey/profile/follows when a napplet needs owner-aware UI.
- `upload`: upload printable files and images to runtime-managed Blossom servers.
- `resource`: fetch external media/file URLs through the runtime's network policy.
- `storage`: keep drafts and local UI state under runtime control.
- `link`, `theme`, `common`, and `count`: optional richer shell integrations used by detail, preview, and browse surfaces.

For example, a runtime that wants to use this repo's profile surface should route `intent.open('profile', { pubkey })` to the `user-profile` napplet, grant `inc`, `outbox`, `resource`, `identity`, and `intent`, then deliver the payload on `profile:open` once the frame has emitted `profile:ready`.

## Compatibility Guidelines

To make another napplet compatible with stlstr or any runtime that understands these roles:

- Declare the shared archetype in the napplet manifest, not just a repo-specific name. Use `profile` for person/profile views instead of `user-profile`.
- Accept the payload shapes above. If a napplet needs extra data, treat it as optional and still render from the common payload.
- Use NAP-INTENT for cross-napplet navigation. For example, maker links should open `profile` with `{ pubkey }`, and printable links should open `printable-detail` with `{ address }`.
- Keep Nostr reads and writes behind `outbox`; do not bundle a signer, touch `window.nostr`, or create hidden relay behavior inside the napplet.
- Treat domains beyond the manifest payload as runtime services. If `count`, `common`, `link`, `storage`, or `theme` are absent, degrade gracefully rather than failing the whole surface.
- Keep visual chrome out of napplets. The runtime owns windows, title bars, borders, and navigation; napplets render the embedded content surface.

## Forking Or Reusing

You can fork one napplet without forking the whole app. Preserve the archetype and payload if you want it to remain drop-in compatible with existing runtimes, then change the UI, event queries, or publishing flow behind that contract.

Useful starting points:

- Fork `napplets/user-profile` to build a different profile view while keeping archetype `profile`.
- Fork `napplets/print-detail` to make a custom printable detail page that still accepts `address`.
- Fork `napplets/print-search` to change search ranking or feed layout while keeping `printable-search` open payloads.
- Build a new napplet with `pnpm napplet:new <name> "Display Title"`, then add a manifest archetype that matches one of the shared roles if it should be interchangeable.

## Development

Install with pnpm:

```sh
pnpm install
```

Run the host, napplet build watchers, and local Kehto Paja:

```sh
pnpm dev
```

Scripts are namespaced: `app:*` builds and deploys the stlstr host app (as an
[nsyte](https://github.com/sandwichfarm/nsyte) static site), and `napplet:*`
builds and deploys the napplets (to Nostr/Blossom via the napplet CLI). Shared
scripts (`dev`, `verify`, `test`, `format`) stay unprefixed.

Build all napplets:

```sh
pnpm napplet:build
```

Verify napplets and shared libraries:

```sh
pnpm verify
```

### Deploy the host app (nsyte)

`app:build` builds the napplets first, then the host app, bundling every
built-in napplet artifact into `apps/stlstr/dist/napplets/<dTag>/index.html` and
emitting `apps/stlstr/dist/napplets.json`. The built-ins are served same-origin,
so the app is self-contained — no separate napplet deploy is required for the
shipped defaults.

```sh
pnpm app:build            # produce the deployable apps/stlstr/dist
pnpm app:deploy:dry       # preview the nsyte deploy without publishing
pnpm app:deploy           # build, then `nsyte deploy apps/stlstr/dist`
```

`app:deploy` runs `nsyte deploy` against `apps/stlstr/dist`. Configure the
target once with `nsyte init` (writes `.nsite/config.json` — relays, Blossom
servers, and signing); `nsyte` must be on `PATH`.

### Deploy the napplets (napplet CLI)

Publishing napplets to Nostr is separate from the app deploy above, and is only
needed for cross-runtime discovery of the napplets as standalone NIP-5A apps.
There is one target — `.napplet/config.json`, signed with the `hzrd149` key.
Store that key once in the OS keychain (it is never written to the repo), then
deploy:

```sh
pnpm napplet:login        # store the hzrd149 nsec under keyReference "hzrd149"
pnpm napplet:deploy:dry   # preview the publish without writing anything
pnpm napplet:deploy       # build, then publish every napplet
```

Every napplet deploy is public and permanent: relay writes are append-only and
Blossom blobs are content-addressed, so preview with `napplet:deploy:dry` first.
