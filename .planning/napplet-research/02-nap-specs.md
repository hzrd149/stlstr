# NAP Specs — Full Reference

> Compiled from the napplet/naps repo (master + PR branches). Each section is the full text of a NAP spec.
> NAP-SHELL and NAP-INTENT are merged (Active). All others are Draft PRs.

---

## NAP-SHELL — Bootstrap Handshake & Capability Negotiation

**Domain:** `shell` · **Required:** Mandatory · **Web binding:** `window.napplet.shell`

NAP-SHELL is the **foundational** capability: it defines `shell.supports()` itself and is therefore the one NAP that cannot be discovered through `shell.supports()`. Every runtime that implements any NAP implements NAP-SHELL unconditionally.

### Description

Before a napplet can use any capability, two things must be true: the runtime must learn **when the napplet is ready to receive messages**, and the napplet must learn **what the runtime offers**. NAP-SHELL is the two-message handshake that resolves this bootstrap dependency.

The napplet signals readiness (`shell.ready`). The runtime replies once with the **environment** (`shell.init`): the set of capabilities it offers and the named services it exposes. The napplet caches that environment, which is what makes `shell.supports()` answerable **synchronously and locally** thereafter.

### API Surface

| Operation | Parameters | Result | Wire |
|-----------|------------|--------|------|
| `supports` | `domain` (`tstr`) | `bool` | local query against cached `shell.init` |
| `services` | none | list of `tstr` service names | local read against cached `shell.init` |
| `ready` | none | `ShellEnvironment` | resolves after `shell.ready` / `shell.init` |
| `onReady` | handler for `ShellEnvironment` | `Subscription` handle | fires after `shell.init` |

`ShellEnvironment` fields:
- `capabilities` (yes, `ShellCapabilities`) — runtime-internal, sufficient to answer `supports(domain)`
- `services` (yes, list of text) — named services the runtime exposes

### Wire Protocol

| Type | Direction | Payload fields |
|------|-----------|----------------|
| `shell.ready` | napplet -> runtime | *(none)* |
| `shell.init` | runtime -> napplet | `capabilities`, `services` |

The handshake is two fire-and-forget messages; neither carries a correlation `id`.

- `shell.ready` carries **no payload** — it is a liveness signal only.
- `shell.init` is sent **exactly once** in response to the first `shell.ready`.
- `shell.supports()` is answered **locally** from the cached environment — not a wire round-trip.

### Example

```
-> { "type": "shell.ready" }
<- {
     "type": "shell.init",
     "capabilities": { "domains": ["relay", "storage", "identity"] },
     "services": []
   }
```

### Error Handling

Failure is expressed by **absence**: if `shell.init` never arrives, `supports()` returns `false` for everything. A napplet SHOULD treat a missing environment after a reasonable timeout as "running outside a conformant runtime" and degrade.

### Shell Behavior

- MUST send `shell.init` in response to the napplet's first `shell.ready`, only after the receiver is live.
- MUST establish the napplet's session upon receiving the first `shell.ready`, binding identity from NIP-5A creation-time assignment.
- MUST send `shell.init` **exactly once** per napplet lifecycle.
- MUST NOT service capability calls before the handshake completes.
- SHOULD treat duplicate `shell.ready` as idempotent.

### Security

- `shell.ready` is a bare liveness ping — carries no identity, no capability request.
- Session establishment is a privileged side effect; a second `shell.ready` MUST NOT create a second session.
- The capability set in `shell.init` is the runtime's authoritative statement of what this napplet may use, scoped per napplet.
- Withholding `shell.init` denies a napplet every capability at once — a single total enforcement point.

---

## NAP-INTENT — Archetype Intent Dispatcher

**Domain:** `intent` · **Web binding:** `window.napplet.intent` · `shell.supports("intent")`

### Description

NAP-INTENT provides shell-mediated invocation of *another* napplet by its **archetype** — a shared role name such as `note`, `profile`, or `emoji-list`. The napplet describes *what role* it wants, *what action* to perform, and *what payload* to deliver; the shell resolves the role to an installed napplet, applies the user's default-handler preference, creates or focuses the window, and delivers the payload. This is the napplet equivalent of Android-style implicit intents.

The **archetype** is the intent category, the **action** is the intent action, the **payload** is the extras, and the user's default handler is the default app. NAP-INTENT standardizes the **envelope**, not the payload. The `payload` is opaque and MAY be tagged by a `convention` field naming the unnumbered payload shape.

### API Surface

| Operation | Parameters | Result | Wire |
|-----------|------------|--------|------|
| `invoke` | `request` (`IntentRequest`) | `IntentResult` | `intent.invoke` / `intent.invoke.result` |
| `open` | `archetype`, optional `payload`, optional `opts` | `IntentResult` | sugar over `invoke` with action `"open"` |
| `available` | `archetype` (`tstr`) | `IntentAvailability` | `intent.available` / `.result` |
| `handlers` | none | list of `IntentAvailability` | `intent.handlers` / `.result` |
| `onChanged` | handler for `IntentAvailability` | `Subscription` | `intent.changed` |

Key schemas:
- `IntentRequest`: `archetype` (yes, text), `action` (no, defaults `open`), `convention` (no), `payload` (no, any), `handler` (no, `default`/`choose`/dTag), `behavior` (no, `IntentBehavior`)
- `IntentResult`: `ok` (yes, bool), `archetype` (yes), `action` (yes), `handled` (yes, bool), `handler` (no, dTag), `windowId` (no), `convention` (no), `error` (no)
- `IntentAvailability`: `archetype` (yes), `available` (yes, bool), `candidates` (yes, list of `IntentCandidate`), `hasDefault` (yes, bool)
- `IntentCandidate`: `dTag` (yes), `title` (no), `actions` (yes, list), `conventions` (yes, list), `isDefault` (no, bool)

### Wire Protocol

| Type | Direction | Payload fields |
|------|-----------|----------------|
| `intent.invoke` | napplet -> shell | `id`, `request` |
| `intent.invoke.result` | shell -> napplet | `id`, `result`, `error?` |
| `intent.available` | napplet -> shell | `id`, `archetype` |
| `intent.available.result` | shell -> napplet | `id`, `availability`, `error?` |
| `intent.handlers` | napplet -> shell | `id` |
| `intent.handlers.result` | shell -> napplet | `id`, `handlers`, `error?` |
| `intent.changed` | shell -> napplet | `availability` |

The **action is a field** (`request.action`), never part of the message type. `intent.invoke` is the single dispatch verb for `open`, `edit`, `pick`, `share`, and any future action.

### Example

```
-> { "type": "intent.available", "id": "a1", "archetype": "emoji-list" }
<- {
     "type": "intent.available.result", "id": "a1",
     "availability": {
       "archetype": "emoji-list", "available": true,
       "candidates": [{ "dTag": "emojilistr", "title": "Emoji List Maker", "actions": ["open"], "conventions": ["napplet:emoji-list/open"], "isDefault": true }],
       "hasDefault": true
     }
   }
-> { "type": "intent.invoke", "id": "i1", "request": { "archetype": "emoji-list", "action": "open", "payload": { "seed": ["🤙", "⚡"] }, "behavior": { "focus": true } } }
<- { "type": "intent.invoke.result", "id": "i1", "result": { "ok": true, "archetype": "emoji-list", "action": "open", "handled": true, "handler": "emojilistr", "windowId": "win-12", "convention": "napplet:emoji-list/open" } }
```

### Shell Behavior

- MUST resolve `archetype` to a handler using its catalog of installed napplets and the user's default-handler preference.
- MUST keep a user-overridable default per archetype.
- SHOULD offer an "open with..." chooser when `handler: "choose"` or no default exists.
- MUST source `available()`/`handlers()` from the installed-napplet catalog (signed NIP-5A manifests), not running instances.
- MUST NOT let a napplet learn the identity of or address another napplet except through this resolution.

### Security

- Dispatch is navigation/focus-stealing — shells SHOULD rate-limit or require a user gesture.
- Archetype resolution is a trust boundary — callers name roles, never instances.
- Payloads cross a napplet boundary — receiving napplet MUST treat payload as untrusted input.

---

## NAP-INC — Inter-Napplet Communication

**Domain:** `inc` · **Web binding:** `window.napplet.inc` · `shell.supports("inc")`

### Description

NAP-INC provides topic-based publish/subscribe and point-to-point channels for communication between napplets. Under the NIP-5D iframe transport, sandboxed napplets cannot communicate directly (opaque origins, no shared context). The shell routes messages between napplets using typed `inc.*` messages.

**Topics** are loose-coupled pub/sub. **Channels** are pre-authorized point-to-point connections (auth-on-open model: shell validates target once on open, then messages flow without per-message validation).

### API Surface

```typescript
interface NappletInc {
  emit(topic: string, payload?: unknown): void;
  on(topic: string, callback: (event: IncEvent) => void): Subscription;
  channel: {
    open(target: string): Promise<ChannelHandle>;
    list(): Promise<ChannelInfo[]>;
    broadcast(payload: unknown): void;
  };
}

interface IncEvent { topic: string; sender: string; payload: unknown; }  // sender = dTag
interface ChannelHandle { id: string; peer: string; emit(payload): void; on(callback): Subscription; close(): void; }
```

### Wire Protocol — Topics

| Type | Direction | Payload |
|------|-----------|---------|
| `inc.emit` | napplet -> shell | `topic`, `payload?` |
| `inc.subscribe` | napplet -> shell | `id`, `topic` |
| `inc.subscribe.result` | shell -> napplet | `id` |
| `inc.unsubscribe` | napplet -> shell | `topic` |
| `inc.event` | shell -> napplet | `topic`, `sender` (dTag), `payload?` |

### Wire Protocol — Channels

| Type | Direction | Payload |
|------|-----------|---------|
| `inc.channel.open` | napplet -> shell | `id`, `target` (dTag) |
| `inc.channel.open.result` | shell -> napplet | `id`, `channelId?`, `peer?`, `error?` |
| `inc.channel.emit` | napplet -> shell | `channelId`, `payload?` |
| `inc.channel.event` | shell -> napplet | `channelId`, `sender` (dTag), `payload?` |
| `inc.channel.broadcast` | napplet -> shell | `payload?` |
| `inc.channel.list` | napplet -> shell | `id` |
| `inc.channel.list.result` | shell -> napplet | `id`, `channels` |
| `inc.channel.close` | napplet -> shell | `channelId` |
| `inc.channel.closed` | shell -> napplet | `channelId`, `reason?` |

Key notes:
- `inc.emit`, `inc.channel.emit`, `inc.channel.broadcast`, `inc.unsubscribe`, `inc.channel.close` are fire-and-forget (no `id`).
- `inc.event` and `inc.channel.event` are shell-initiated deliveries (no `id`), identified by `topic`/`sender` or `channelId`/`sender`.
- Shell MUST NOT deliver `inc.event` back to the emitting napplet (sender exclusion).

### Topic conventions

| Prefix | Direction | Meaning |
|--------|-----------|---------|
| `shell:*` | napplet -> shell | Commands to the shell |
| `napplet:*` | shell -> napplet | Responses/notifications from shell |
| `{domain}:*` | bidirectional | Domain-scoped messages between napplets |

### Security

- Sender identity is shell-enforced via `MessageEvent.source`. No per-message signing.
- Topic namespaces are not enforced — any napplet can emit on any topic. Shell MAY restrict via ACL.
- Channel authorization is validated once on open. Channel IDs are opaque (not enumerable/guessable).

---

## NAP-RELAY — Relay Proxy

**Domain:** `relay` · **Depends:** `resource` (optional, for sidecar) · **Web binding:** `window.napplet.relay` · `shell.supports("relay")`

### Description

NAP-RELAY provides relay access through the shell. Sandboxed iframes cannot open WebSocket connections directly. The shell acts as a relay proxy, forwarding typed relay messages to its connected relay pool and delivering matching events back. This is the most fundamental shell capability — without it, napplets have no way to read or write Nostr events.

**Use this only for explicit relay-local behavior** (group relays, diagnostics, protocol tooling). For normal social reads and publishes, use `outbox` or a higher-level domain.

### API Surface

| Operation | Parameters | Result | Wire |
|-----------|------------|--------|------|
| `subscribe` | `filters`, optional `options` (`RelaySubscribeOptions`) | `Subscription` handle streaming `RelayEventResult` | `relay.subscribe` + `relay.event`/`relay.eose` |
| `publish` | `template` (`EventTemplate`) | `NostrEvent` | `relay.publish` / `.result` |
| `publishEncrypted` | `template`, `recipient`, optional `encryption` | `NostrEvent` | `relay.publishEncrypted` / `.result` |
| `query` | `filters` | list of `RelayEventResult` | `relay.query` / `.result` |
| `Subscription.close` | none | none | `relay.close` |

`RelayEventResult` = `{ event: NostrEvent, ? sidecar: RelayEventSidecar }`
`RelayEventSidecar` = `{ ? resources: [* ResourceSidecarEntry], ? relayHints: [* tstr] }`
`RelaySubscribeOptions` = `{ ? relay: tstr }` — targets a specific relay instead of the shared pool.

The shell signs event templates. The shell encrypts content for `publishEncrypted` (NIP-44 default, NIP-04 fallback). The shell decrypts incoming encrypted events before delivering them — napplets receive plaintext.

### Wire Protocol

| Type | Direction | Payload fields |
|------|-----------|----------------|
| `relay.subscribe` | napplet -> shell | `id`, `subId`, `filters`, `relay?` |
| `relay.close` | napplet -> shell | `id`, `subId` |
| `relay.publish` | napplet -> shell | `id`, `event` (EventTemplate) |
| `relay.publishEncrypted` | napplet -> shell | `id`, `event`, `recipient`, `encryption?` |
| `relay.query` | napplet -> shell | `id`, `filters` |
| `relay.event` | shell -> napplet | `subId`, `result` (RelayEventResult) |
| `relay.eose` | shell -> napplet | `subId` |
| `relay.closed` | shell -> napplet | `subId`, `reason?` |
| `relay.publish.result` | shell -> napplet | `id`, `ok`, `event?`, `eventId?`, `error?` |
| `relay.publishEncrypted.result` | shell -> napplet | `id`, `ok`, `event?`, `eventId?`, `error?` |
| `relay.query.result` | shell -> napplet | `id`, `events` (RelayEventResult[]) |

### Sidecar Pre-Resolution

Shells MAY attach sidecar metadata to `RelayEventResult`:
- `sidecar.resources?: ResourceSidecarEntry[]` — pre-fetched byte resources (type owned by NAP-RESOURCE). Napplet's subsequent `resource.bytes(url)` resolves from cache without a round-trip.
- `sidecar.relayHints?: [* tstr]` — relay URLs where the event was observed.

**Sidecar pre-resolution is default OFF** for privacy reasons. Pre-fetching reveals user activity to upstream hosts before the user has chosen to render the event. Conformant shells MUST NOT enable it by default. Opt-in is per-shell-policy.

Shims MUST hydrate sidecar `resources` into the `resource.bytes` single-flight cache BEFORE delivering the event to the napplet's event handler. This ordering is load-bearing for synchronous cache lookup.

### Security

- Shell controls which relays the napplet can access. Napplets cannot open arbitrary WebSocket connections.
- Shell signs event templates. Napplets never see signing keys.
- Shell encrypts for `publishEncrypted` — napplets provide plaintext; this prevents exfiltration of encrypted data.
- Shell MAY inspect event content before signing (primary security benefit of shell-mediated signing).
- Shell decrypts incoming encrypted events — napplets never see ciphertext or decryption keys.
- Scoped relay URLs SHOULD be validated to prevent SSRF.

---

## NAP-OUTBOX — Outbox-Aware Relay Access

**Domain:** `outbox` · **Depends:** `relay` (required), `resource` (optional) · **Web binding:** `window.napplet.outbox` · `shell.supports("outbox")`

### Description

NAP-OUTBOX provides outbox-model relay routing. A napplet provides Nostr filters and intent; the runtime finds the correct relays (NIP-65), queries them, deduplicates results, and streams updates. This is the **default event-read and publish boundary** when relay selection is part of result correctness.

The shell owns relay discovery, routing, fallback, deduplication, signature validation, signing, and publish fanout policy.

### API Surface

| Operation | Parameters | Result | Wire |
|-----------|------------|--------|------|
| `getEvent` | `eventId`, optional `options` (`OutboxEventOptions`) | `OutboxEventResult` | `outbox.getEvent` / `.result` |
| `query` | `filters`, optional `options` (`OutboxQueryOptions`) | `OutboxResult` | `outbox.query` / `.result` |
| `subscribe` | `filters`, optional `options` (`OutboxSubscribeOptions`) | `OutboxSubscription` handle | `outbox.subscribe` + push messages |
| `publish` | `template`, optional `options` (`OutboxPublishOptions`) | `OutboxPublishResult` | `outbox.publish` / `.result` |
| `resolveRelays` | `target` (`OutboxTarget`) | `OutboxRelayPlan` | `outbox.resolveRelays` / `.result` |

Key options:
- `OutboxQueryOptions`: `authors?`, `relays?`, `limit?`, `timeoutMs?`
- `OutboxPublishOptions`: `relays?` (explicit fanout candidates), `toOutbox?` (default `true` — publish to user's NIP-65 write relays), `toInboxes?` (author pubkeys whose NIP-65 read relays are required fanout targets)
- `OutboxRelayPlan`: `relays` (yes), `source` (`nip65`/`cache`/`policy`/`fallback`), `missingAuthors?`

### Wire Protocol

| Type | Direction | Payload fields |
|------|-----------|----------------|
| `outbox.getEvent` | napplet -> shell | `id`, `eventId`, `options?` |
| `outbox.getEvent.result` | shell -> napplet | `id`, `result?`, `incomplete?`, `error?` |
| `outbox.query` | napplet -> shell | `id`, `filters`, `options?` |
| `outbox.query.result` | shell -> napplet | `id`, `events`, `incomplete?`, `error?` |
| `outbox.subscribe` | napplet -> shell | `id`, `subId`, `filters`, `options?` |
| `outbox.event` | shell -> napplet | `subId`, `result` |
| `outbox.closed` | shell -> napplet | `subId`, `reason?` |
| `outbox.close` | napplet -> shell | `id`, `subId` |
| `outbox.publish` | napplet -> shell | `id`, `event`, `options?` |
| `outbox.publish.result` | shell -> napplet | `id`, `ok`, `event?`, `eventId?`, `relays?`, `error?` |
| `outbox.resolveRelays` | napplet -> shell | `id`, `target` |
| `outbox.resolveRelays.result` | shell -> napplet | `id`, `plan`, `error?` |

### Shell Behavior

- MUST resolve relay plans per NIP-65 when available.
- MUST verify `outbox.getEvent` results match the requested `eventId`.
- MUST deduplicate events by event ID before returning `outbox.query.result`.
- MUST validate event signatures before delivering events.
- MUST sign event templates; napplets do not receive signing keys.
- MUST include the shell-user's NIP-65 write relays in publish fanout unless `toOutbox: false`.
- MUST resolve NIP-65 read relays for every author in `toInboxes` when non-empty.
- MUST deduplicate relay URLs across own-outbox, inbox, and explicit relay URLs before publishing.

### Security

- Relay selection leaks user interest — shells SHOULD limit broad queries.
- `options.relays` MUST be subject to shell validation (no private network relays).
- Publishing remains shell-mediated — shells SHOULD show consent UI or require prior policy approval.

---

## NAP-STORAGE — Scoped Key-Value Storage

**Domain:** `storage` · **Web binding:** `window.napplet.storage` · `shell.supports("storage")`

### Description

NAP-STORAGE provides an async localStorage-like API. Without `allow-same-origin`, iframes have opaque origins and cannot access localStorage. Storage is scoped by composite key `(dTag, aggregateHash)` — different napplet types and different versions have completely separate namespaces. Recommended quota: 512 KB.

### API Surface

| Operation | Parameters | Result | Wire |
|-----------|------------|--------|------|
| `getItem` | `key` (`tstr`) | `tstr` or `null` | `storage.get` / `.result` |
| `setItem` | `key`, `value` (`tstr`) | none | `storage.set` / `.result` |
| `removeItem` | `key` (`tstr`) | none | `storage.remove` / `.result` |
| `keys` | none | list of `tstr` | `storage.keys` / `.result` |
| `instance.*` | same as above, with `scope: "instance"` | same | same wire, `scope` field added |

**Instance scope:** When a napplet is open more than once (e.g. several feeds), `scope: "instance"` isolates a key to the calling instance while `scope: "shared"` (default) stays common to every instance. The choice is per call. Instance storage lives as long as the instance; the shell MAY reclaim it on destroy. State that must outlive the instance belongs in `shared`.

### Wire Protocol

| Type | Direction | Payload fields |
|------|-----------|----------------|
| `storage.get` | napplet -> shell | `id`, `key`, `scope?` |
| `storage.set` | napplet -> shell | `id`, `key`, `value`, `scope?` |
| `storage.remove` | napplet -> shell | `id`, `key`, `scope?` |
| `storage.keys` | napplet -> shell | `id`, `scope?` |
| `storage.get.result` | shell -> napplet | `id`, `value` (string or null) |
| `storage.set.result` | shell -> napplet | `id` |
| `storage.remove.result` | shell -> napplet | `id` |
| `storage.keys.result` | shell -> napplet | `id`, `keys` (string array) |

`scope` is `"shared"` (default) or `"instance"`. Result messages carry no `scope`; the correlation `id` identifies the request.

### Security

- Storage scoped by `(dTag, aggregateHash)` — enforced isolation between napplets.
- For `scope: "instance"`, shell MUST additionally isolate between instances.
- Storage values are strings only — shell SHOULD NOT parse or execute stored content.
- Storage keys and values are visible to the shell. Napplets needing confidential storage should encrypt values before storing.

---

## NAP-IDENTITY — Read-Only User Identity Queries

**Domain:** `identity` · **Depends:** `resource` (optional, for picture/banner bytes) · **Web binding:** `window.napplet.identity` · `shell.supports("identity")`

### Description

NAP-IDENTITY provides read-only access to the shell-user identity: the connected user/signer pubkey and related public identity data. Napplets cannot sign, encrypt, or decrypt. This shell-user identity is distinct from the NIP-5D napplet session identity.

### API Surface

```typescript
interface NappletIdentity {
  getPublicKey(): Promise<string>;           // hex pubkey or "" when signed out
  onChanged(handler: (pubkey: string) => void): Subscription;
  getRelays(): Promise<Record<string, { read: boolean; write: boolean }>>;
  getProfile(): Promise<ProfileData | null>;
  getFollows(): Promise<string[]>;
  getList(type: string): Promise<string[]>;
  getZaps(): Promise<ZapReceipt[]>;
  getMutes(): Promise<string[]>;
  getBlocked(): Promise<string[]>;
  getBadges(): Promise<Badge[]>;
}
```

`ProfileData`: `name?`, `displayName?`, `about?`, `picture?`, `banner?`, `nip05?`, `lud16?`, `website?`

**Resource resolution:** `picture` and `banner` URLs MUST be fetched through NAP-RESOURCE (`resource.bytes(url)`), not direct `<img src>`.

### Wire Protocol

| Type | Direction | Payload fields |
|------|-----------|----------------|
| `identity.getPublicKey` | napplet -> shell | `id` |
| `identity.getPublicKey.result` | shell -> napplet | `id`, `pubkey` |
| `identity.changed` | shell -> napplet | `pubkey` |
| `identity.getRelays` / `.result` | bidirectional | `id` / `id`, `relays`, `error?` |
| `identity.getProfile` / `.result` | bidirectional | `id` / `id`, `profile?`, `error?` |
| `identity.getFollows` / `.result` | bidirectional | `id` / `id`, `pubkeys`, `error?` |
| `identity.getList` / `.result` | bidirectional | `id`, `listType` / `id`, `entries`, `error?` |
| `identity.getZaps` / `.result` | bidirectional | `id` / `id`, `zaps`, `error?` |
| `identity.getMutes` / `.result` | bidirectional | `id` / `id`, `pubkeys`, `error?` |
| `identity.getBlocked` / `.result` | bidirectional | `id` / `id`, `pubkeys`, `error?` |
| `identity.getBadges` / `.result` | bidirectional | `id` / `id`, `badges`, `error?` |

Key notes:
- `identity.changed` is a push message (no `id`). Emitted when shell-user identity changes, with `pubkey: ""` on sign-out.
- `getPublicKey` MUST always succeed (no `error` field) — returns `""` when no user connected.
- `getProfile` returns `profile: null` if no kind 0 found (not an error).
- Recommended handshake: call `getPublicKey` once on startup, then listen for `identity.changed`.

### Security

- Strictly read-only — no method modifies user state, signs, or performs crypto.
- `identity.changed` reports only shell-user identity, not napplet session identity.
- Follow/mute/block lists reveal social graph — shells MAY restrict access based on trust level.
- Shell MUST NOT expose private keys or signing/encryption/decryption through this interface.

---

## NAP-KEYS — Keyboard Forwarding and Action Keybindings

**Domain:** `keys` · **Web binding:** `window.napplet.keys` · `shell.supports("keys")`

### Description

NAP-KEYS provides bidirectional keyboard interaction. Sandboxed iframes capture keyboard events and prevent shell-level hotkeys from working when a napplet has focus. NAP-KEYS solves this with keyboard forwarding (napplet sends keystrokes to shell) and action registration (napplet declares named actions the shell can bind to keys).

### API Surface

| Operation | Parameters | Result | Wire |
|-----------|------------|--------|------|
| `registerAction` | `action` (`Action`) | `RegisterResult` | `keys.registerAction` / `.result` |
| `unregisterAction` | `actionId` (`tstr`) | none | `keys.unregisterAction` |
| `forward` | keyboard event fields | none | `keys.forward` |
| `onAction` | `actionId`, local callback | `Subscription` | local helper; not a wire message |

`Action` = `{ id: tstr, label: tstr, ? defaultKey: tstr }` — `defaultKey` is a hint only; the shell decides the actual binding.

### Wire Protocol

| Type | Direction | Payload fields |
|------|-----------|----------------|
| `keys.forward` | napplet -> shell | `key`, `code`, `ctrl`, `alt`, `shift`, `meta` |
| `keys.registerAction` | napplet -> shell | `id`, `action` |
| `keys.registerAction.result` | shell -> napplet | `id`, `actionId`, `binding?` |
| `keys.unregisterAction` | napplet -> shell | `actionId` |
| `keys.bindings` | shell -> napplet | `bindings` (array of `{ actionId, key }`) |
| `keys.action` | shell -> napplet | `actionId` |

### Smart Forwarding

The napplet shim maintains a local suppress list from `keys.bindings`. On each keydown:
1. If target is a text input, do not forward.
2. If key is a bare modifier, do not forward.
3. If `isComposing` is true (IME), do not forward.
4. Normalize keystroke to combo string.
5. If combo matches suppress list: `preventDefault()`, trigger local action handler, do NOT forward.
6. If not: send `keys.forward`.

### Reserved Keys (MUST NOT be suppressed)

- `Tab` and `Shift+Tab` — focus navigation (WCAG 2.1.2)
- `Escape` — close dialogs, exit modes
- Browser-reserved shortcuts (`Ctrl+W`, `Ctrl+T`, `Ctrl+L`)

Key combo format: `Modifier+Key` (e.g., `Ctrl+S`, `Alt+Shift+P`). Shells MUST normalize to alphabetical modifier order: `Alt+Ctrl+Shift+Meta+Key`.

### Security

- Keystroke forwarding exposes user input — `keys.forward` is strictly napplet-to-shell.
- Forwarding from text inputs is suppressed to prevent password/credential leakage.
- A compromised napplet could ignore the suppress list — shell MUST NOT rely on napplet suppression for security-critical bindings.

---

## NAP-THEME — Shell-Provided Theming

**Domain:** `theme` · **Web binding:** `window.napplet.theme` · `shell.supports("theme")`

### Description

NAP-THEME provides read-only access to the shell's active theme. The shell owns the theme and delivers it as a typed payload. Napplets query the current theme on demand and receive automatic notifications when it changes.

### API Surface

```typescript
interface Theme {
  colors: { background: string; text: string; primary: string; };  // required, hex colors
  fonts?: { body?: ThemeFont; title?: ThemeFont; };
  background?: { url: string; mode: string; mime: string; };
  title?: string;  // human-readable theme name
}

interface NappletTheme {
  get(): Promise<Theme>;  // via theme.get / theme.get.result
}
```

`theme.changed` is received as a message event (no subscribe/unsubscribe — automatic for all napplets that declare `theme` in `requires`).

### Wire Protocol

| Type | Direction | Payload fields |
|------|-----------|----------------|
| `theme.get` | napplet -> shell | `id` |
| `theme.get.result` | shell -> napplet | `id`, `theme` |
| `theme.changed` | shell -> napplet | `theme` |

### Kind 16767 Mapping

Shells sourcing themes from Nostr kind 16767 events SHOULD map:
- `["c", "<hex>", "background"]` -> `colors.background`
- `["c", "<hex>", "text"]` -> `colors.text`
- `["c", "<hex>", "primary"]` -> `colors.primary`
- `["f", "<name>", "<url>", "body"]` -> `fonts.body`
- `["bg", "url <url>", "mode <mode>", "m <mime>"]` -> `background.*`
- `["title", "<name>"]` -> `title`

### Security

- Theme data is read-only.
- Font/background URLs may point to external resources — shells SHOULD validate or proxy.
- Color values are strings — napplets SHOULD validate hex format before applying.

---

## NAP-MEDIA — Media Session Control

**Domain:** `media` · **Depends:** `resource` (optional, for artwork bytes) · **Web binding:** `window.napplet.media` · `shell.supports("media")`

### Description

NAP-MEDIA provides media session management. Napplets create sessions, report state/metadata, declare dynamic capabilities, and receive commands. The shell provides a media session registry and control surface.

### Ownership Model

- `owner: "shell"` — napplet asks shell to play a source. Shell fetches, plays, owns lifecycle, emits state. Strict sandbox path.
- `owner: "napplet"` — napplet plays media inside its own frame and registers the session for shell metadata display, media keys, audio focus, and OS integration.

### API Surface

| Operation | Parameters | Result | Wire |
|-----------|------------|--------|------|
| `createSession` | `options` (`MediaSessionCreate`) | `MediaSessionResult` | `media.session.create` / `.result` |
| `updateSession` | `sessionId`, partial `metadata` | none | `media.session.update` |
| `destroySession` | `sessionId` | none | `media.session.destroy` |
| `reportState` | `sessionId`, `state` (`MediaState`) | none | `media.state` |
| `reportCapabilities` | `sessionId`, `actions` | none | `media.capabilities` |
| `onCommand` | `sessionId`, handler for `MediaCommand` | `Subscription` | `media.command` |
| `onControls` | `sessionId`, handler for list of `MediaAction` | `Subscription` | `media.controls` |

`MediaSessionCreate`: `owner` (required, `"shell"`/`"napplet"`), `sessionId?`, `source?` (`MediaSourceRef`), `metadata?` (`MediaMetadata`), `context?` (`MediaSessionContext`), `capabilities?`, `autoplay?`, `live?`

`MediaSourceRef`: `url?`, `blossomHash?`, `nostr?` (`MediaNostrRef`), `mimeType?`

`MediaMetadata`: `title?`, `artist?`, `album?`, `artwork?` (`MediaArtwork`), `duration?`, `mediaType?` (`"audio"`/`"video"`)

### Wire Protocol

| Type | Direction | Payload fields |
|------|-----------|----------------|
| `media.session.create` | napplet -> shell | `id`, `owner`, `sessionId?`, `source?`, `metadata?`, `context?`, `capabilities?`, `autoplay?`, `live?` |
| `media.session.create.result` | shell -> napplet | `id`, `sessionId?`, `owner?`, `error?` |
| `media.session.update` | napplet -> shell | `sessionId`, `metadata` |
| `media.session.destroy` | napplet -> shell | `sessionId` |
| `media.state` | owner -> peer | `sessionId`, `status`, `position?`, `duration?`, `volume?` |
| `media.capabilities` | owner -> peer | `sessionId`, `actions` |
| `media.command` | controller -> owner | `sessionId`, `action`, `value?` |
| `media.controls` | shell -> napplet | `sessionId`, `controls` |

For napplet-owned sessions: `media.state`/`media.capabilities` are napplet->shell, `media.command` is shell->napplet.
For shell-owned sessions: `media.state`/`media.capabilities` are shell->napplet, `media.command` is napplet->shell (when requesting allowed actions).

### Security

- Shell MUST reject `owner: "shell"` creation when `source` is missing or blocked.
- Shell MUST own fetching for shell-owned sessions — napplet does not gain network access.
- For napplet-owned sessions, volume control is advisory — a malicious napplet could ignore volume commands.
- Session creation is rate-limited.

---

## NAP-NOTIFY — Shell-Rendered Notifications

**Domain:** `notify` · **Web binding:** `window.napplet.notify` · `shell.supports("notify")`

### Description

NAP-NOTIFY provides notification delivery. Napplets send notification requests; the shell renders them (toasts, system notifications, badge counts) and routes user interaction back. The shell controls presentation, grouping, priority, and dismissal.

### API Surface

| Operation | Parameters | Result | Wire |
|-----------|------------|--------|------|
| `send` | `notification` (`NotificationPayload`) | `NotificationResult` | `notify.send` / `.result` |
| `dismiss` | `notificationId` | none | `notify.dismiss` |
| `badge` | `count` (`uint`) | none | `notify.badge` |
| `registerChannel` | `channel` (`NotificationChannel`) | none | `notify.channel.register` |
| `requestPermission` | optional `channel` | `PermissionResult` | `notify.permission.request` / `.result` |
| `onAction` | handler for `notificationId`, `actionId` | `Subscription` | `notify.action` |
| `onClicked` | handler for `notificationId` | `Subscription` | `notify.clicked` |
| `onDismissed` | handler for `notificationId`, optional `reason` | `Subscription` | `notify.dismissed` |
| `onControls` | handler for list of `NotifyControl` | `Subscription` | `notify.controls` |

`NotificationPayload`: `title` (yes), `body?`, `icon?`, `actions?` (list of `NotificationAction`, max 3), `channel?`, `priority?` (`low`/`normal`/`high`/`urgent`)

### Wire Protocol

| Type | Direction | Payload fields |
|------|-----------|----------------|
| `notify.send` | napplet -> shell | `id`, `title`, `body?`, `icon?`, `actions?`, `channel?`, `priority?` |
| `notify.send.result` | shell -> napplet | `id`, `notificationId?`, `error?` |
| `notify.dismiss` | napplet -> shell | `notificationId` |
| `notify.badge` | napplet -> shell | `count` |
| `notify.channel.register` | napplet -> shell | `channelId`, `label`, `description?`, `defaultPriority?` |
| `notify.permission.request` | napplet -> shell | `id`, `channel?` |
| `notify.permission.result` | shell -> napplet | `id`, `granted` |
| `notify.action` | shell -> napplet | `notificationId`, `actionId` |
| `notify.clicked` | shell -> napplet | `notificationId` |
| `notify.dismissed` | shell -> napplet | `notificationId`, `reason?` |
| `notify.controls` | shell -> napplet | `controls` |

### Security

- Shell SHOULD sanitize `title` and `body` to prevent injection.
- Shell SHOULD clearly attribute notifications to the originating napplet (prevent spoofing).
- `urgent` priority could be abused — shells SHOULD rate-limit urgent notifications.

---

## NAP-RESOURCE — Sandboxed Resource Fetching

**Domain:** `resource` · **Web binding:** `window.napplet.resource` · `shell.supports("resource")`

### Description

NAP-RESOURCE lets a napplet request byte resources through the runtime. The napplet supplies URLs; the runtime owns fetch, scheme dispatch, policy, MIME classification, SVG rasterization, caching, quotas, and errors. This is the **only network-fetch primitive** available inside the iframe sandbox.

### API Surface

| Operation | Parameters | Result | Wire |
|-----------|------------|--------|------|
| `info` | none | `ResourceInfo` | `resource.info` / `.result` |
| `bytes` | `url`, `opts?` | one Blob result | `resource.bytes` / `.result` |
| `bytesMany` | non-empty `urls`, `opts?` | ordered per-URL results | `resource.bytesMany` / `.result` |
| `bytesAsObjectURL` | `url` | `{ url, revoke }` helper | helper over `bytes` |

`opts.signal` MAY abort — sends `resource.cancel` for the request `id`.

### Schemes

| Scheme | Rules |
|--------|-------|
| `data:` | MAY decode in the napplet shim. No network access. |
| `https:` | Runtime fetch. Full Default Resource Policy applies. `mime` is sniffed, not upstream `Content-Type`. |
| `blossom:` | Canonical `blossom:sha256:<hex>`. Runtime MUST verify SHA-256 before delivery. |
| `htree:` | Hashtree reference. Runtime resolves and verifies every hash before delivery. |
| `nostr:` | NIP-19 bech32. Runtime resolves one hop and returns referenced bytes. |

Unknown schemes return `unsupported-scheme`. `http:` is not canonical and MUST NOT be enabled by default.

### Wire Protocol

| Type | Direction | Payload |
|------|-----------|---------|
| `resource.info` | napplet -> runtime | `id` |
| `resource.info.result` | runtime -> napplet | `id`, `info` |
| `resource.bytes` | napplet -> runtime | `id`, `url` |
| `resource.bytesMany` | napplet -> runtime | `id`, `urls` |
| `resource.cancel` | napplet -> runtime | `id` |
| `resource.bytes.result` | runtime -> napplet | `id`, `blob`, `mime` |
| `resource.bytes.error` | runtime -> napplet | `id`, `error`, `message?` |
| `resource.bytesMany.result` | runtime -> napplet | `id`, `items` |
| `resource.bytesMany.error` | runtime -> napplet | `id`, `error`, `message?` |

`ResourceBytesItem`: `url` (yes), `ok` (yes, bool), `blob?` + `mime?` (when ok), `error?` + `message?` (when not ok). Items MUST preserve input order and length.

### Default Resource Policy

| Policy | Level | Rule |
|--------|-------|------|
| Private IP block | MUST | After DNS resolution, before connection. Block RFC1918, loopback, link-local, ULA, 169.254.169.254. Re-check every redirect. |
| MIME sniffing | MUST | Classify by sniffing. Never pass upstream `Content-Type`. |
| SVG rasterization | MUST | Raw `image/svg+xml` MUST NOT be delivered. Rasterize to PNG/WebP in sandboxed Worker. |
| Blossom hash check | MUST | Hash mismatch returns `decode-failed`. |
| Response size cap | SHOULD | 10 MiB. Exceed returns `too-large`. |
| Fetch timeout | SHOULD | 30s per URL. Exceed returns `timeout`. |
| Concurrency/rate limit | SHOULD | 10 in-flight, 60 req/min per napplet. |
| Bulk URL cap | SHOULD | 100 URLs. |
| Blob quota | SHOULD | 50 MiB outstanding per napplet. |

### Sidecar Pre-Resolution

`ResourceSidecarEntry` = `{ url: tstr, blob: bstr, mime: tstr }` — owned by this domain, carried by carrier domains (e.g., `RelayEventResult.sidecar.resources?` in NAP-RELAY). Sidecars are optional and carrier-policy gated. Shims MUST hydrate sidecars before invoking the napplet event handler.

### Error Codes

`invalid-request`, `not-found`, `blocked-by-policy`, `timeout`, `too-large`, `unsupported-scheme`, `decode-failed`, `network-error`, `quota-exceeded`.

### Security

- The runtime is an SSRF boundary — DNS-time private-IP checks are mandatory.
- Upstream `Content-Type` is attacker-controlled and MUST NOT be trusted.
- Raw SVG is an active XML surface and MUST be rasterized before delivery.
- Resource bytes are visible to the host page and browser tooling — not confidential.
- Cache scope comes from runtime-bound napplet identity, never napplet payload.

---

## NAP-CONFIG — Per-Napplet Declarative Configuration

**Domain:** `config` · **Web binding:** `window.napplet.config` · `shell.supports("config")`

### Description

NAP-CONFIG provides per-napplet declarative configuration. A napplet declares a JSON Schema (draft-07+); the shell renders a settings UI, validates user input, persists values in a napplet-scoped store, and delivers live values via snapshot + push.

**The shell is the sole writer of configuration values.** Napplets cannot mutate configuration over the wire.

### API Surface

| Operation | Parameters | Result | Wire |
|-----------|------------|--------|------|
| `registerSchema` | `schema`, optional `version` | none; errors via `onSchemaError` | `config.registerSchema` / `.result` |
| `get` | none | `ConfigValues` | `config.get` / `config.values` |
| `subscribe` | handler for `ConfigValues` | `Subscription` | `config.subscribe` / `config.values` |
| `onSchemaError` | handler for `ConfigSchemaError` | `Subscription` | `config.schemaError` |
| `openSettings` | optional `section` | none | `config.openSettings` |
| `schema` | none | `ConfigSchema` or `null` | local read |

### Wire Protocol

| Type | Direction | Payload fields |
|------|-----------|----------------|
| `config.registerSchema` | napplet -> shell | `id`, `schema`, `version?` |
| `config.registerSchema.result` | shell -> napplet | `id`, `ok`, `error?`, `code?` |
| `config.get` | napplet -> shell | `id` |
| `config.subscribe` | napplet -> shell | *(none)* |
| `config.unsubscribe` | napplet -> shell | *(none)* |
| `config.openSettings` | napplet -> shell | `section?` |
| `config.values` | shell -> napplet | `id?`, `values` |
| `config.schemaError` | shell -> napplet | `error`, `code` |

`config.values` is dual-use: with `id` it answers `config.get`; without `id` it is a subscription push. `config.subscribe` MUST produce an immediate initial `config.values` push (snapshot delivery).

### Schema Contract (Core Subset)

**Supported types:** `object` (top-level only), `string`, `number`, `integer`, `boolean`, `array` (homogeneous only), nested `object` (max depth 4).

**Supported keywords:** `type`, `properties`, `required`, `items`, `additionalProperties` (default `false` at top-level), `default`, `title`, `description`, `enum`, `enumDescriptions`.

**Supported constraints:** `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`.

**Excluded from v1:** `pattern` (ReDoS risk), `$ref` (all forms), `definitions`/`$defs`, `oneOf`/`anyOf`/`allOf`/`not`, `if`/`then`/`else`, `patternProperties`, tuple-typed arrays, expression-valued defaults.

**Standardized extensions (Potentialities):**
- `x-napplet-secret` (boolean) — mask input, suppress logs, route to keychain
- `x-napplet-section` (string) — group under section heading
- `x-napplet-order` (non-negative number) — sort within section
- `deprecationMessage`, `markdownDescription`

`x-napplet-secret: true` combined with a `default` MUST be rejected (`secret-with-default`).

### Error codes

`invalid-schema`, `version-conflict`, `unsupported-draft`, `ref-not-allowed`, `pattern-not-allowed`, `secret-with-default`, `schema-too-deep`, `no-schema`.

### Security

- Storage scope derived from `MessageEvent.source` at iframe creation — wire messages MUST NOT carry `dTag` or `aggregateHash`.
- `config.values` payloads are transmitted cleartext over `postMessage`, including `x-napplet-secret` fields. Browser extensions with script access can observe them.
- `additionalProperties: false` override prevents silent persisted-data accretion.
- External `$ref` forbidden — enables data exfiltration, DoS, privacy leaks.

---

## NAP-UPLOAD — Media and Blob Upload

**Domain:** `upload` · **Depends:** `relay` (optional) · **Web binding:** `window.napplet.upload` · `shell.supports("upload")`

### Description

NAP-UPLOAD provides shell-mediated upload to Nostr-aware storage backends (NIP-96 HTTP file storage and Blossom blob storage). The shell selects a server, constructs and signs authorization (NIP-98 for NIP-96, kind 24242 for Blossom), performs the HTTP upload, and returns a stable URL with NIP-94 integrity metadata.

Napplets never receive signing keys, server credentials, or direct network access.

### API Surface

| Operation | Parameters | Result | Wire |
|-----------|------------|--------|------|
| `info` | none | `UploadInfo` | `upload.info` / `.result` |
| `upload` | `request` (`UploadRequest`) | `UploadResult` | `upload.upload` / `.result` |
| `status` | `uploadId` | `UploadStatus` | `upload.status` / `.result` |
| `onStatus` | handler for `UploadStatus` | `Subscription` | `upload.status.changed` |

`UploadRequest`: `rail?` (`nip96`/`blossom`), `data` (yes, `bstr` — Blob/ArrayBuffer), `mimeType?`, `filename?`, `caption?`, `noTransform?`, `metadata?`

`UploadResult`: `ok`, `uploadId`, `status` (`pending`/`uploading`/`complete`/`failed`/`cancelled`), `rail`, `url?`, `fallbackUrls?`, `sha256?`, `originalSha256?`, `size?`, `mimeType?`, `dimensions?`, `blurhash?`, `nip94?` (list of NostrTag), `error?`

### Wire Protocol

| Type | Direction | Payload fields |
|------|-----------|----------------|
| `upload.info` | napplet -> shell | `id` |
| `upload.info.result` | shell -> napplet | `id`, `info`, `error?` |
| `upload.upload` | napplet -> shell | `id`, `request` |
| `upload.upload.result` | shell -> napplet | `id`, `result`, `error?` |
| `upload.status` | napplet -> shell | `id`, `uploadId` |
| `upload.status.result` | shell -> napplet | `id`, `status`, `error?` |
| `upload.status.changed` | shell -> napplet | `status` |

Key notes:
- `request.data` crosses the boundary by structured clone — shells MUST NOT require base64-encoding.
- Omitting `request.rail` lets the shell choose the best configured rail.
- Shell SHOULD populate `nip94` so a napplet can attach the file to a Nostr event without recomputing hashes.

### Security

- Uploading is network egress and identity-linking — shells MUST treat every `upload.upload` as untrusted until policy checks pass.
- Shell signs rail authorization — napplets MUST NOT receive signing/encryption primitives.
- Metadata leakage risk (EXIF GPS, device IDs) — shells SHOULD offer metadata stripping.
- Returned URLs are public and durable.
- Shells SHOULD rate-limit per-napplet uploads.

---

## NAP-VALUE — Value Transfer

**Domain:** `value` · **Depends:** `relay` (optional) · **Web binding:** `window.napplet.value` · `shell.supports("value")`

### Description

NAP-VALUE provides shell-mediated value transfer. The first use case is Nostr zaps, but the interface is named around value so shells can support additional rails. Napplets describe the intended transfer; the shell handles wallet integration, consent, zap request construction, signing, invoice payment, relay publishing, and result tracking.

### API Surface

| Operation | Parameters | Result | Wire |
|-----------|------------|--------|------|
| `send` | `request` (`ValueRequest`) | `ValueResult` | `value.send` / `.result` |
| `quote` | `request` (`ValueRequest`) | `ValueQuote` | `value.quote` / `.result` |
| `status` | `transferId` | `ValueStatus` | `value.status` / `.result` |
| `onStatus` | handler for `ValueStatus` | `Subscription` | `value.status.changed` |

`ValueRequest`: `rail` (yes, `zap`/`lnurl`/extension), `amountMsat` (yes, uint), `comment?`, `target` (yes, `ValueTarget`), `metadata?`

`ZapTarget`: `type: "zap"`, `pubkey?`, `eventId?`, `address?`, `relays?`
`LnurlTarget`: `type: "lnurl"`, `lnurl` (yes)

`ValueResult`: `ok`, `transferId`, `status` (`pending`/`settled`/`failed`/`cancelled`), `rail`, `amountMsat`, `event?` (NostrEvent), `preimage?`, `error?`

### Wire Protocol

| Type | Direction | Payload fields |
|------|-----------|----------------|
| `value.quote` | napplet -> shell | `id`, `request` |
| `value.quote.result` | shell -> napplet | `id`, `quote`, `error?` |
| `value.send` | napplet -> shell | `id`, `request` |
| `value.send.result` | shell -> napplet | `id`, `result`, `error?` |
| `value.status` | napplet -> shell | `id`, `transferId` |
| `value.status.result` | shell -> napplet | `id`, `status`, `error?` |
| `value.status.changed` | shell -> napplet | `status` |

### Security

- Spending is user-visible and security-critical — shells MUST require explicit consent unless a configured allowance covers the request.
- Shell MUST construct and sign Nostr events (kind 9734 zap requests).
- Shell MUST NOT sign or pay opaque requests it cannot inspect.
- Allowances SHOULD be bound to napplet identity, rail, max amount, recurrence, and target constraints.
- Payment failures MUST NOT be hidden as success.

---

## NAP-CVM — ContextVM Bridge

**Domain:** `cvm` · **Depends:** `value` (optional, for payment prompts) · **Web binding:** `window.napplet.cvm` · `shell.supports("cvm")`

### Description

NAP-CVM provides native access to ContextVM servers (MCP over Nostr). The napplet supplies the server identity and MCP operation; the shell handles ContextVM transport, user policy, signing, encryption, relay access, and value-transfer prompts.

### API Surface

| Operation | Parameters | Result | Wire |
|-----------|------------|--------|------|
| `discover` | optional `query` (`CvmDiscoverQuery`) | list of `CvmServer` | `cvm.discover` / `.result` |
| `request` | `server`, `message` (`McpMessage`), optional `options` | `McpMessage` | `cvm.request` / `.result` |
| `listTools` | `server`, optional `options` | list of `McpTool` | wrapper over `request` |
| `callTool` | `server`, `name`, optional `args`, optional `options` | `McpToolResult` | wrapper over `request` |
| `listResources` | `server`, optional `options` | list of `McpResource` | wrapper over `request` |
| `readResource` | `server`, `uri`, optional `options` | `McpResourceContent` | wrapper over `request` |
| `close` | `server` | none | `cvm.close` / `.result` |
| `onEvent` | handler for `CvmEvent` | `CvmSubscription` | `cvm.event` |
| `registry.list` | optional `query` | list of `CvmRegistryEntry` | `cvm.registry.list` / `.result` |
| `registry.has` | `family`, optional `options` | `bool` | `cvm.registry.has` / `.result` |
| `registry.describe` | `family`, optional `options` | `CvmRegistryEntry` | `cvm.registry.describe` / `.result` |
| `registry.call` | `family`, `tool`, optional `args`, optional `options` | `McpToolResult` | `cvm.registry.call` / `.result` |

`CvmServerRef`: `pubkey` (yes), `relays?`
`CvmServer`: `pubkey` (yes), `relays?`, `name?`, `description?`, `capabilities?`, `paymentRequired?`
`McpMessage`: `jsonrpc: "2.0"`, `id?`, `method?`, `params?`, `result?`, `error?`

### Wire Protocol

| Type | Direction | Payload fields |
|------|-----------|----------------|
| `cvm.discover` | napplet -> shell | `id`, `query?` |
| `cvm.discover.result` | shell -> napplet | `id`, `servers`, `error?` |
| `cvm.request` | napplet -> shell | `id`, `server`, `message`, `options?` |
| `cvm.request.result` | shell -> napplet | `id`, `message?`, `error?` |
| `cvm.close` | napplet -> shell | `id`, `server` |
| `cvm.close.result` | shell -> napplet | `id`, `error?` |
| `cvm.event` | shell -> napplet | `server`, `message` |
| `cvm.registry.list` / `.result` | bidirectional | `id`, `query?` / `id`, `entries?`, `error?` |
| `cvm.registry.has` / `.result` | bidirectional | `id`, `family`, `options?` / `id`, `has?`, `error?` |
| `cvm.registry.describe` / `.result` | bidirectional | `id`, `family`, `options?` / `id`, `entry?`, `error?` |
| `cvm.registry.call` / `.result` | bidirectional | `id`, `family`, `tool`, `args?`, `options?` / `id`, `result?`, `error?` |

Key notes:
- `cvm.request.result` correlates to the NIP-5D request `id`; the embedded MCP message retains its own JSON-RPC `id`.
- `cvm.event` is for MCP notifications not correlated to a single request — fans out to every registered handler.
- The shell owns all ContextVM event IDs, relay subscriptions, encryption state, and signing.

### Security

- ContextVM servers are remote programs — shells SHOULD enforce per-napplet policy for which servers/methods may be called.
- Shells MUST verify server identity by public key.
- Payment requests MUST NOT be auto-approved unless covered by an explicit allowance.
- Napplets receive MCP results but not ContextVM private keys, encryption keys, or direct socket access.

---

## NAP-LINK — Shell-Mediated Link Opening

**Domain:** `link` · **Web binding:** `window.napplet.link` · `shell.supports("link")`

### Description

NAP-LINK lets a sandboxed napplet ask the shell to open an external URL for the user. The shell owns navigation, policy, prompting, and browser context. This is **user navigation, not byte fetching** — use NAP-RESOURCE when bytes are needed.

### API Surface

| Operation | Parameters | Result | Wire |
|-----------|------------|--------|------|
| `open` | `url` (`tstr`), optional `options` (`LinkOpenOptions`) | `LinkOpenResult` | `link.open` / `.result` |

`LinkOpenOptions`: `label?` (human-readable prompt text, not trusted policy input)
`LinkOpenResult`: `status` (`"opened"` / `"denied"`)

### Wire Protocol

| Type | Direction | Payload fields |
|------|-----------|----------------|
| `link.open` | napplet -> shell | `id`, `url`, `options?` |
| `link.open.result` | shell -> napplet | `id`, `status`, `error?` |

### Shell Behavior

- MUST validate `url` — reject relative URLs.
- MUST reject `javascript:`, `data:`, `blob:`, `file:`, and other local/code-bearing schemes.
- SHOULD open web links in a context outside the napplet sandbox, with `noopener`.
- MAY prompt the user before opening; MAY persist user choices per napplet/hostname/URL.
- MUST NOT expose `window.opener` or equivalent authority back to the napplet.

### Security

- Opening a link is user-visible — shells SHOULD require a user gesture or prompt.
- `label` is napplet-supplied text — MUST NOT be used as proof of destination.
- Shells SHOULD rate-limit denied or repeated link requests.

---

## NAP-POW — NIP-13 Proof-of-Work Miner

**Domain:** `pow` · **Depends:** `identity` (required), `relay` (optional), `outbox` (optional) · **Web binding:** `window.napplet.pow` · `shell.supports("pow")`

### Description

NAP-POW provides a shell-mediated NIP-13 proof-of-work miner. The napplet hands over an event template and target difficulty; the runtime mines a `nonce` across 1..n web workers until the event id carries the required leading zero bits, and returns the mined event. Mining commits the user's pubkey and `created_at` into the event id, so the runtime stamps those fields before the search begins.

Two entry points: `mine` returns the mined unsigned event; `mineAndPublish` mines, signs, and publishes through outbox-aware fanout in one step.

### API Surface

| Operation | Parameters | Result | Wire |
|-----------|------------|--------|------|
| `mine` | `template`, `target` (`uint`), optional `opts` (`PowOptions`) | `PowJob` handle | `pow.mine` + push messages |
| `mineAndPublish` | `template`, `target`, optional `opts` | `PowJob` handle | `pow.mineAndPublish` + push messages |
| `queue` | none | list of `PowJobSummary` | `pow.queue` / `.result` |
| `job` | `jobId` | `PowProgress` | `pow.job` / `.result` |
| `hashrate` | none | `PowHashrate` | `pow.hashrate` / `.result` |
| `cancel` | `jobId` | `bool` | `pow.cancel` / `.result` |
| `pause` | optional `jobId` | none | `pow.pause` / `.result` |
| `resume` | optional `jobId` | none | `pow.resume` / `.result` |
| `formatHashRate` | `hashesPerSecond` | `tstr` | local helper; no wire message |

`PowJob`: local handle for `jobId` and `target`. Exposes `started`, `completed`, event listeners (`state`, `progress`, `done`, `error`), and local `cancel`/`pause`/`resume` helpers.

`EventTemplate`: `kind` (yes), `content` (yes), `tags?`, `created_at?` — the runtime stamps `pubkey` and `created_at`.
`PowOptions`: `workers?`, `priority?`, `timeoutMs?`, `commitCreatedAt?` (default `true`).
`PowState`: `queued` / `mining` / `paused` / `done` / `cancelled` / `error`.
`PowResult`: `jobId`, `ok`, `event` (NostrEvent), `pow` (achieved bits), `nonce`, `hashes`, `elapsedMs`, `published?` (PowPublishResult, for mineAndPublish), `error?`.

### Wire Protocol

| Type | Direction | Payload fields |
|------|-----------|----------------|
| `pow.mine` | napplet -> shell | `id`, `jobId`, `template`, `target`, `options?` |
| `pow.mine.result` | shell -> napplet | `id`, `jobId`, `accepted`, `state`, `position?`, `error?` |
| `pow.mineAndPublish` | napplet -> shell | `id`, `jobId`, `template`, `target`, `options?` |
| `pow.mineAndPublish.result` | shell -> napplet | `id`, `jobId`, `accepted`, `state`, `position?`, `error?` |
| `pow.state` | shell -> napplet | `jobId`, `state`, `position?` |
| `pow.progress` | shell -> napplet | `jobId`, `progress` |
| `pow.done` | shell -> napplet | `jobId`, `result` |
| `pow.error` | shell -> napplet | `jobId`, `error` |
| `pow.queue` / `.result` | bidirectional | `id` / `id`, `jobs` |
| `pow.job` / `.result` | bidirectional | `id`, `jobId` / `id`, `progress`, `error?` |
| `pow.hashrate` / `.result` | bidirectional | `id` / `id`, `hashrate` |
| `pow.cancel` / `.result` | bidirectional | `id`, `jobId` / `id`, `jobId`, `cancelled`, `error?` |
| `pow.pause` / `.result` | bidirectional | `id`, `jobId?` / `id`, `jobId?`, `error?` |
| `pow.resume` / `.result` | bidirectional | `id`, `jobId?` / `id`, `jobId?`, `error?` |

Key notes:
- The napplet generates `jobId` and uses it to correlate push messages.
- `pow.mine.result` reports the job's **initial** state (`"queued"` with position, or `"mining"`). The mined event arrives later in `pow.done`.
- `created_at` is committed when mining **starts**, not when submitted, so queue wait never produces a stale timestamp.
- `options.timeoutMs` bounds mining time only, not queue wait.
- `pause`/`resume` without `jobId` acts on the whole miner.

### Security

- Mining is unbounded CPU work — shell MUST cap max `target`, concurrent jobs, and total workers. SHOULD enforce `timeoutMs`.
- `mine` returns an **unsigned** event — the proof of work is public and carries no secret.
- Signing happens only at publish time, gated by shell consent.
- Shell MUST preserve every committed field when signing a previously-mined event — re-stamping `created_at` or reordering tags destroys the proof of work.
- `mineAndPublish` MUST run the same content/consent checks as any signed publish.
