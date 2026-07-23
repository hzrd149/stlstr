# Plan: NAP-INTENT architecture for stlstr

Status: draft · Target: `apps/stlstr` routing + every napplet manifest

How every stlstr route becomes an intent, how an intent makes the shell navigate, and how the
payload reaches the napplet that renders the page.

## 1. What NAP-INTENT actually is in the installed packages

Verified against `@kehto/services@0.16.5`, `@kehto/shell@0.17.2`, `@kehto/nip@0.4.2`,
`@napplet/nap@0.28.0`, `@napplet/vite-plugin@0.11.3`.

| Fact                                                                                                                                                                                                                                                   | Evidence                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| A napplet declares roles as manifest tags `["archetype", slug, protocol, "kind:<n>"...]`. `nip5aManifest({ archetypes: [{ slug, naps }] })` emits one tag per entry in `naps`.                                                                         | `@napplet/vite-plugin` `buildArchetypeTags`                                      |
| The **protocol is a free-form string**. Types call it a NAP-N (`nap: 'NAP-1'` in the `manifestToIntentCatalogEntry` example); matching is plain string equality, and hyprgate-gui passes the bare slug (`naps: ['feed']`).                             | `manifestToIntentCatalogEntry` docs; `hyprgate-gui/napplets/feed/vite.config.ts` |
| Resolution: candidates by archetype → user default handler → action check → protocol check (`request.protocol ?? defaultProtocol(archetype) ?? handler.protocols[0]`) → `windows.open(...)`.                                                           | `createCatalogIntentResolver` in `@kehto/services`                               |
| **NAP-INTENT has no inbound delivery message.** Shell→napplet messages are only `intent.invoke.result`, `intent.available.result`, `intent.handlers.result`, `intent.changed`. The handling napplet never learns its intent through the intent domain. | `IntentInboundMessage` in `@napplet/nap/intent/types`                            |
| Payload delivery is therefore **out of band**, by host choice: `IntentWindowController.open` receives `{dTag, archetype, action, protocol, payload, behavior, callerWindowId}` and returns a `windowId`.                                               | `IntentWindowController`                                                         |
| `shell.supports('intent')` is gated on the **`hooks.intent.isAvailable()` adapter hook**, which is separate from registering the service. Same for `common`, `link`, `lists`, `serial`.                                                                | `buildShellCapabilities`, shell/dist/index.js:988                                |
| The runtime ACL gates `intent.*` by declared capability — `invoke` needs `intent:write`, `available`/`handlers` need `intent:read`. A domain missing from the manifest's `requires` gets its messages dropped.                                         | `@kehto/acl` capability table; hyprgate's `feed-builder/vite.config.ts` comment  |
| In dev there is **no manifest catalog**: the `.nip5a-manifest.json` sidecar is only written when `VITE_DEV_PRIVKEY_HEX` is set, and archetype tags never appear in the built HTML (only `napplet-type` / `napplet-requires` metas).                    | `writeBundleManifest` in `@napplet/vite-plugin`                                  |

### Two bugs this surfaces in what we have now

1. **Every napplet manifest declares domain names where protocols belong.** All five pass
   `archetypes: [{ slug, naps: ['outbox', ...] }]`, which emits `["archetype","browse-objects","outbox"]` —
   a role claiming to speak the protocol "outbox". Meaningless to any resolver.
2. **`shell.supports('intent')` is false.** We register the `intent` service but never set
   `hooks.intent`, so the shell does not advertise the domain. Napplets that feature-detect the
   documented way see no intent support. `create-object` only works because it probes
   `window.napplet.intent` directly. The same applies to `common` and `count`, which the browse
   route grants but the shell neither advertises nor services.

Also note `requires` is under-declared across napplets (`browse-objects` declares only `outbox`
while using `resource` and `intent`). Harmless today, silently fatal once the ACL is enforced
against a real manifest.

## 2. Decisions

**Protocol ids: convention strings** — `napplet:<archetype>/<action>`, e.g.
`napplet:object-detail/open`. String equality satisfies the installed packages today, and the
upstream naps repo has already replaced numbered payload NAPs with exactly this form
("unnumbered conventions named `napplet:<archetype>/<intent>`", `01-nap-system.md`), so there is
no rename later. Divergence to be aware of: hyprgate-gui uses the bare slug (`feed`) — if the two
shells should ever resolve each other's napplets, this is the thing to reconcile.

**Payload channel: targeted `inc.event`, following hyprgate-gui.** NAP-INC is the only NAP that
can carry a shell→napplet push of arbitrary shape, and hyprgate has already proven the pattern in
`apps/shell/src/lib/kehto/intent-window-controller.ts`. Its hard-won constraints carry over:

- **Targeted, never broadcast.** Post directly to the resolved iframe's `contentWindow`; the
  runtime's broadcast primitive fans out to every subscriber on the topic.
- **Readiness handshake.** The napplet emits `<archetype>:ready` once its `inc.on` subscription is
  registered; the shell buffers the payload and flushes on that signal. Without it the payload
  races the napplet's cold start and is lost.
- **Exactly-once, then re-deliverable.** Flush once per delivery, but allow an explicit re-delivery
  so an already-mounted napplet can be handed a new payload in place.
- **De-proxy before posting.** A Svelte 5 `$state` proxy throws a silent `DataCloneError` across
  `postMessage`. Validate into a plain object first.

stlstr is simpler than hyprgate here: hyprgate is a window manager and needs a cross-window buffer
map keyed by `windowId`. We are a router — exactly one napplet is mounted per route — so the
pending payload can live with the frame that owns it.

## 3. Architecture: a route is a materialized intent

The canonical form of "where the user is" becomes an `IntentRequest`, and the URL is its
serialization:

```
intentFromLocation(location)  →  { archetype, action, payload }   // deep link, refresh, back
intentToHref(request)         →  "/objects/<pubkey>/<d>"           // in-app intent.open
```

These are inverses. `intent.open()` resolves to an href and pushes it; a pasted URL parses to the
same intent. One delivery path, so a deep link and an in-app navigation hand the napplet an
identical payload — the failure mode this avoids is a napplet that works when clicked into but is
blank on refresh.

Flow for `intent.open('object-detail', { address })`:

```
napplet → intent.invoke
  → resolver: candidates → default handler → action + protocol check
  → intentToHref(request) → shell navigate (deferred a tick, see §5)
  → shell mounts the archetype's napplet, holding the payload
  → napplet subscribes, emits "<archetype>:ready"
  → shell flushes the payload as a targeted inc.event
  → napplet renders
```

## 4. The stlstr intent map

| Archetype        | Handler dTag     | Actions          | Protocol (convention)                                          | Payload                    | Route                           |
| ---------------- | ---------------- | ---------------- | -------------------------------------------------------------- | -------------------------- | ------------------------------- |
| `browse-objects` | `browse-objects` | `open`, `search` | `napplet:browse-objects/open`, `napplet:browse-objects/search` | `{ query?, tag? }`         | `/`, `/search?q=`, `/tags/:tag` |
| `object-detail`  | `object-detail`  | `open`           | `napplet:object-detail/open`                                   | `{ address }` (kind 33500) | `/objects/:pubkey/:d`           |
| `create-object`  | `create-object`  | `open`, `create` | `napplet:create-object/open`                                   | `{ remixOf?, prefill? }`   | `/create`                       |
| `edit-object`    | `edit-object`    | `open`, `edit`   | `napplet:edit-object/edit`                                     | `{ address }`              | `/objects/:pubkey/:d/edit`      |

Reserved for later milestones, listed so the slugs are not taken by accident:
`maker-profile` (`{ pubkey }` → `/makers/:pubkey`), `object-set` (`{ address }` kind 30050 →
`/collections/:pubkey/:d`), `make` (`{ eventId }` kind 2351).

Payload rules:

- Every payload above is **fully encodable in the URL**, so deep links are lossless. Payloads that
  are not (a remix prefill, a draft seed) are delivered by inc only and must degrade to a usable
  empty state on refresh.
- `address` is the NIP-01 address `33500:<pubkey>:<d>`. The resolver also accepts
  `{ pubkey, identifier }`; it normalizes to `address` before delivery so napplets parse one shape.
- Actions are verbs on the same role: `edit-object` handles `edit` on the `edit-object` archetype
  rather than inventing an archetype per verb.

## 5. Implementation plan

### Phase 1 — make the current handler honest

1. Set `hooks.intent = { isAvailable: () => true }` on the adapter so `shell.supports('intent')`
   is true. Same for `link`/`common`/`lists` when those services land.
2. Fix `archetypes` in all five `vite.config.ts` files: protocols become convention strings, and
   add `kind:` constraints where a role is kind-specific (`contracts: [{ protocol, eventKinds: [33500] }]`).
3. Fix `requires` in all five to list every domain actually used, ahead of ACL enforcement.
4. Keep the navigation-deferral tick from the existing service — it is load-bearing, not a
   workaround: navigating unmounts the caller, so `intent.invoke.result` must be posted first.

### Phase 2 — route/intent isomorphism

5. `apps/stlstr/src/services/intent-map.ts`: the table in §4 as data — archetype → dTag, actions,
   protocols, payload parse/serialize, href builder.
6. Replace `routeFromLocation` with `intentFromLocation` returning `{ request, route }`; derive
   `AppRoute` from the intent rather than the reverse. `/search` and `/tags/:tag` stop being
   special cases — they are `browse-objects` with a payload.
7. Rewrite the resolver in `services/intent.ts` on top of the map. Keep the hand-written
   `IntentResolver` for now; shape the catalog as `IntentCatalogEntry[]` so it can be swapped for
   `createCatalogIntentResolver` + `manifestToIntentCatalogEntry` once deployed manifests exist
   (§1: no catalog in dev).

### Phase 3 — payload delivery

8. `apps/stlstr/src/services/intent-delivery.ts`: per-frame pending payload, `markReady(windowId)`,
   targeted `postMessage({ type: 'inc.event', topic, payload, sender: 'shell' })` to the iframe's
   `contentWindow`, exactly-once flush, explicit re-delivery, plain-object validation before post.
9. `NappletFrame` seeds the pending payload from the route's intent at mount and flushes on the
   napplet's ready signal. Because the frame is recreated per route, no cross-window buffer map is
   needed — but the payload must be seeded **before** `iframe.srcdoc` is assigned.
10. Topic naming: `napplet:<archetype>/<action>` for the payload and `napplet:<archetype>/ready`
    for the readiness signal, so the inc topic and the protocol id are the same vocabulary.
    (hyprgate uses `feed:open` / `feed:ready`; ours differ because our protocol ids differ.)
11. Napplet side: subscribe first, then emit ready. Order is the whole point of the handshake.

### Phase 4 — verification

12. Extend `tests/browser/nap-handlers.test.mjs`: payload arrives after a cold mount; the same
    payload arrives on a deep link with no prior intent; re-delivery to a mounted napplet; a
    payload sent to one route does not leak to the next.
13. `intentToHref(intentFromLocation(url)) === url` over the route table, as a unit-level check.

## 6. Open questions

1. **Default-handler policy.** hyprgate treats caller-supplied dTags as a trust boundary and always
   resolves through the user default (`T-88-01`). Ours is a fixed built-in catalog, so a caller
   dTag is currently meaningless — do we reject `handler: "<dTag>"` outright, or ignore it?
2. **Reconcile protocol vocabulary with hyprgate?** They use bare slugs, we chose conventions.
   Only matters if the two shells ever share a napplet catalog.
3. **Does `browse-objects` need `search` as a distinct action**, or is search just an `open` payload?
   Leaning payload — fewer actions, and the URL already distinguishes them.
