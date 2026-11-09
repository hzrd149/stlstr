# stlstr

stlstr is a Thingiverse-style app for publishing, browsing, and discussing 3D printables on Nostr. The host app is intentionally small: it owns identity, relays, Blossom uploads, routing, and sandbox policy. Product UI lives in NIP-5D napplets under `napplets/*`.

This repo publishes those napplets as reusable app surfaces. Other napplet runtimes can embed them by granting the NAP domains in their manifests and delivering the intent payloads for the archetypes below.

## Napplet Archetypes

Each napplet declares the archetype (role) it fills with a manifest `z` tag, and every convention it accepts with an `i` tag such as `["i", "napplet:printable-create/create"]`. The folder name is the local package/deploy `d` tag; the archetype is the interoperable role that other runtimes target with NAP-INTENT. Handlers are matched by exact convention, so declare every action you accept.

| Napplet        | Archetype             | Actions            | Payload                   | Purpose                                                                                                                                                                  |
| -------------- | --------------------- | ------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `print-discvr` | `printable-discovery` | `open`             | none                      | Discovery home: new, featured, and friend-adjacent printables.                                                                                                           |
| `print-search` | `printable-search`    | `open`             | Optional `query` or `tag` | Search printables and tag-filter printable feeds.                                                                                                                        |
| `user-profile` | `profile`             | `open`             | `pubkey`                  | Show a maker profile and their published printables. This intentionally uses the generic `profile` archetype so profile links work across unrelated napplet collections. |
| `print-detail` | `printable-detail`    | `open`             | `address`                 | Show one printable, its media/files, maker attribution, comments, reactions, and edit actions.                                                                           |
| `print-create` | `printable-create`    | `open` or `create` | Optional `remixOf`        | Publish a new printable and upload its media/files; `remixOf` pre-fills remix attribution.                                                                               |
| `print-edit`   | `printable-edit`      | `open` or `edit`   | `address`                 | Load an owned printable and publish a replacement event.                                                                                                                 |
| `make-detail`  | `make-detail`         | `open`             | `eventId`                 | Show one make: photos, notes, maker, and the printable it came from.                                                                                                     |
| `part-detail`  | `part-detail`         | `open`             | `fileId`                  | Show metadata for a NIP-94 part file and offer relevant actions.                                                                                                         |
| `part-library` | `part-library`        | `open`             | none                      | The signed-in user's published part files and where they are used.                                                                                                       |
| `part-upload`  | `part-upload`         | `open` or `create` | none                      | Publish reusable part file events for printables to reference.                                                                                                           |
| `stl-preview`  | `stl-preview`         | `open`             | `url`, optional metadata  | Preview an STL file in 3D from NAP-RESOURCE fetch parameters, usually as an overlay.                                                                                     |

Printable addresses use `33500:<pubkey>:<d>`, where kind `33500` is stlstr's printable event kind; the printable archetypes also accept `{ pubkey, identifier }`. Part details use a Nostr file event id as `fileId`, and makes use their event id as `eventId`. STL previews use resource metadata such as `{ url, name, mime, size }`; callers resolve any Nostr event before opening the viewer. Every payload field is a string.

## Runtime Contract

The napplets are sandboxed iframe apps built with `@napplet/vite-plugin` in single-file artifact mode. They do not own keys, relay pools, global storage, or direct Blossom credentials. A runtime embedding them should provide capabilities through `window.napplet` according to each manifest's `requires` list.

Common requirements:

- `intent`: open another archetype from inside a napplet, and receive this napplet's own intent through `intent.onDelivery`.
- `outbox`: query and publish Nostr events through the runtime's relay/signing policy.
- `identity`: expose the current user's pubkey/profile/follows when a napplet needs owner-aware UI.
- `upload`: upload printable files and images to runtime-managed Blossom servers.
- `resource`: fetch external media/file URLs through the runtime's network policy.
- `storage`: keep drafts and local UI state under runtime control.
- `link`, `theme`, `common`, and `count`: optional richer shell integrations used by detail, preview, and browse surfaces.

Callers use the convention URI form, for example `intent.open('napplet:profile/open', { payload: { pubkey } })` or `intent.invoke('napplet:part-upload/create')`. A runtime that wants to use this repo's profile surface routes that request to the `user-profile` napplet, grants the domains its manifest requires, and posts a NAP-INTENT `intent.deliver` with `{ sender, archetype: 'profile', action: 'open', convention: 'napplet:profile/open', payload: { pubkey } }` once the frame is ready. The napplets receive it through `intent.onDelivery` (wrapped by `@stlstr/napplet-kit/intent`), so no INC topics or readiness handshake are involved.

In stlstr itself an intent is a navigation: the URL carries the payload, and the verb and attested `sender` (the caller's manifest catalog id, or `shell` for a deep link) ride in router history state. Errors use NAP-INTENT's common strings: `no handler`, `unsupported convention`, `invoke rejected`.

## Compatibility Guidelines

To make another napplet compatible with stlstr or any runtime that understands these roles:

- Declare the shared archetype in the napplet manifest, not just a repo-specific name. Use `profile` for person/profile views instead of `user-profile`.
- Accept the payload shapes above. If a napplet needs extra data, treat it as optional and still render from the common payload.
- Use NAP-INTENT for cross-napplet navigation. For example, maker links should open `napplet:profile/open` with `{ pubkey }`, and printable links should open `napplet:printable-detail/open` with `{ address }`.
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

Run the host, napplet build watchers, and local Kehto Paja against the
production relays and configured Blossom servers:

```sh
pnpm dev
```

To develop against a local relay (`ws://localhost:4869`) instead — expected to
already be running on your machine — use:

```sh
pnpm local
```

`pnpm local` also makes relay settings read-only. Media server settings remain
editable and direct local Blossom URLs are not blocked by policy.

Scripts are namespaced: `app:*` builds and deploys the stlstr host app (as an
[nsyte](https://github.com/sandwichfarm/nsyte) static site), and `napplet:*`
builds and deploys the napplets (to Nostr/Blossom via the napplet CLI). Shared
scripts (`dev`, `local`, `verify`, `test`, `format`) stay unprefixed.

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
There is one target — `.napplet/config.yaml`, signed with the `hzrd149` key.

The workspace launcher runs the pnpm-resolved JSR CLI version. Deployment explicitly
uses the current NIP-5D format: the final HTML SHA-256 is the artifact identity,
the description is event content, and the embedded PNG icon is uploaded to Blossom.
All built-in napplets include descriptions and the stlstr icon. The build-time dummy
key signs local sidecars for host verification; deployment signs fresh events with
the configured publishing identity. Run `pnpm napplet:deploy:dry` before publishing.
Store that key once in the OS keychain (it is never written to the repo), then
deploy:

```sh
pnpm napplet:login        # store the hzrd149 nsec under keyReference "hzrd149"
pnpm napplet:deploy:dry   # preview the publish without writing anything
pnpm napplet:deploy       # build, then publish every napplet
```

Every napplet deploy is public and permanent: relay writes are append-only and
Blossom blobs are content-addressed, so preview with `napplet:deploy:dry` first.
