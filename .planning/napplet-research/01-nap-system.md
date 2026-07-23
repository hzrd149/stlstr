# NAP System: Governance, Layering, and the Web Projection

> Source: https://github.com/napplet/naps (README, projections/web.md, templates)

## Glossary

| Term                | Meaning                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Seam**            | The boundary between a napplet and its runtime — what's offered, and how it's asked for. Transport-agnostic.                 |
| **Napplet**         | A Nostr applet: a small, single-purpose app. Described by a NIP-5A manifest (kind 35128).                                    |
| **Runtime / Shell** | The host that composes napplets and provides their capabilities.                                                             |
| **NAP**             | One capability contract in the seam — operations, message schema, error model, trust boundary. Never the delivery mechanism. |
| **Domain**          | A capability's short name (`relay`, `intent`); how a NAP is referenced and discovered.                                       |
| **Projection**      | A mapping of the seam onto one concrete host (web, native, WASM, ...).                                                       |
| **NAP-WORD**        | An interface spec — an API the runtime offers. One canonical spec per name.                                                  |
| **Convention**      | An unnumbered message shape napplets agree to use. Named as `napplet:<archetype>/<intent>[...?params]`. Not a NAP.           |
| **NAAT**            | A Napplet Archetype: a canonical role name (`note`, `feed`) with a boundary. Not a NAP.                                      |

## What is a napplet?

A napplet is a Nostr applet — a small app that does one thing well. A chat widget, a feed viewer, a profile editor, and a relay manager are four napplets, not one app with four tabs. **The runtime composes napplets; napplets do not compose themselves.**

A napplet is described and distributed as a NIP-5A manifest (a Nostr event, kind 35128): a pubkey-addressed `dTag`, an aggregate hash of its build, and the capabilities it requires. That manifest is the napplet's identity, independent of how or where it runs.

## What is a NAP?

A NAP is one capability contract in the seam. `NAP-RELAY` says _a runtime can proxy relay reads and writes, and here is exactly how a napplet requests them._ `NAP-INTENT` says _a runtime can open another napplet by role, and here is the request/result shape._

A NAP is **not**:

- **the transport.** `postMessage`, iframes, and `window.napplet.*` are _projection_ details, not the NAP. The same `NAP-RELAY` contract could be carried by IPC, an FFI call, or WASM imports.
- **Nostr itself.** Napplets are Nostr-native — identities are pubkeys, manifests are events, payloads carry Nostr data. NAPs standardize the _runtime contract_ around that data; they do not redefine Nostr.

## Layering

```
NIP-5A   what a napplet IS / how it's described    manifest, identity   (substrate)
  NAP    what a runtime offers a napplet           the capability seam  (this repo)
   └─ projection: web, native, WASM, ...             same contracts, different host
```

NIP-5A defines the napplet. A NAP defines a capability the napplet can ask a runtime for. A _projection_ implements that seam for a concrete host.

## The two axes

A complete napplet ecosystem needs two governed things: what the runtime _offers_, and what kind of napplet each _is_. Cross-napplet message shapes are conventions. They are not assigned NAP numbers.

### NAP-WORD — interfaces (what the runtime offers)

Named by a single uppercase word, one canonical spec per name. Defines a shell-provided API contract. Discovery: `shell.supports("<domain>")`.

Every NAP-WORD is **optional** — a runtime offers it or it doesn't — except **NAP-SHELL**, which every conformant runtime MUST implement.

### Conventions — message shapes (what napplets say to each other)

Cross-napplet message shapes are unnumbered conventions named as `napplet:<archetype>/<intent>[...?params]`, such as `napplet:profile/open` or `napplet:note/open`. Napplets converge by using the same topic names and payload fields. The registry does not assign sequence numbers.

### NAAT — archetypes (what kind of napplet this is)

A NAAT is neither an interface nor a payload convention, just a name and a boundary. A napplet declares roles with a `["archetype", "<slug>", "<convention>"]` manifest tag, and napplets invoke each other by role through NAP-INTENT.

## Boundary rule

A NAP is **runtime-provided** AND defines an **API surface**. A convention is **napplet-agreed** AND defines **message semantics**. An archetype (NAAT) is a **canonical role name** with a **boundary**, owning neither an API nor a payload. Only runtime-provided API surfaces are NAPs.

## How it works (mechanics)

**Discovery.** A runtime advertises the capabilities it provides; a napplet checks for one before using it by domain:

```
shell.supports("relay")          // is the relay capability available?
```

A napplet also declares the capabilities it needs in its NIP-5A manifest (`["requires", "relay"]`); a runtime that lacks one may refuse to load it.

**Request / result.** Messages are objects with a `type` discriminant in `domain.action` form. Request/result pairs correlate by `id`; fire-and-forget messages omit it; runtimes may push unsolicited messages.

```
-> { "type": "relay.publish", "id": "a1", "event": { ... } }   // napplet -> runtime
<- { "type": "relay.publish.result", "id": "a1", "ok": true }   // runtime -> napplet
```

**Mediation & trust.** The runtime is the policy boundary. Napplets are untrusted: they never receive signing keys, wallet credentials, or raw network access. Security-critical operations (signing, payments, uploads) are performed by the runtime on the napplet's behalf, gated by per-napplet capability policy. Napplet identity — the `(dTag, aggregateHash)` tuple — is assigned by the runtime from the manifest, not negotiated by the napplet.

## Web Projection (NIP-5D)

| Concern   | Web projection                                                             |
| --------- | -------------------------------------------------------------------------- |
| Host      | Napplets run as `sandbox="allow-scripts"` iframes                          |
| Carrier   | Messages travel over `postMessage`                                         |
| Surface   | Capabilities appear on a `window.napplet.*` object                         |
| Discovery | `shell.supports("<domain>")`                                               |
| Identity  | Runtime verifies `MessageEvent.source` and binds each message to a napplet |

### Domain surfacing

A NAP named `foo` (domain `foo`) surfaces as `window.napplet.foo` and is discovered via `shell.supports("foo")`.

### Message delivery

Request/result objects are delivered by `postMessage`:

```
-> { "type": "relay.publish", "id": "a1", "event": { ... } }
<- { "type": "relay.publish.result", "id": "a1", "ok": true }
```

### Identity & trust

The shell verifies `MessageEvent.source` on every inbound message to bind it to a napplet identity — the `(dTag, aggregateHash)` tuple from the NIP-5A manifest. Napplets are untrusted: they never receive signing keys, wallet credentials, or raw network access. Security-critical operations are performed by the shell on the napplet's behalf, gated by per-napplet capability policy.

## NAP-WORD registry

| NAP ID       | Domain     | Req | Deps                          | Description                                                | Status   |
| ------------ | ---------- | --- | ----------------------------- | ---------------------------------------------------------- | -------- |
| NAP-SHELL    | `shell`    | yes | —                             | Bootstrap handshake and capability negotiation             | Active   |
| NAP-INTENT   | `intent`   | —   | —                             | Invoke a napplet by archetype (default-handler dispatch)   | Active   |
| NAP-INC      | `inc`      | —   | —                             | Inter-napplet communication                                | Active   |
| NAP-THEME    | `theme`    | —   | —                             | Shell-provided theming                                     | Active   |
| NAP-RELAY    | `relay`    | —   | `resource`                    | Relay proxy (subscribe, publish, query, publishEncrypted)  | Draft    |
| NAP-IDENTITY | `identity` | —   | `resource`                    | Read-only user identity queries                            | Draft    |
| NAP-STORAGE  | `storage`  | —   | —                             | Scoped key-value storage                                   | Draft    |
| NAP-KEYS     | `keys`     | —   | —                             | Keyboard forwarding and action keybindings                 | Draft    |
| NAP-MEDIA    | `media`    | —   | `resource`                    | Media session control and playback                         | Draft    |
| NAP-NOTIFY   | `notify`   | —   | —                             | Shell-rendered notifications                               | Draft    |
| NAP-RESOURCE | `resource` | —   | —                             | Sandboxed resource fetching (https/blossom/nostr/data)     | Draft    |
| NAP-CONFIG   | `config`   | —   | —                             | Per-napplet declarative configuration (JSON Schema-driven) | Draft    |
| NAP-UPLOAD   | `upload`   | —   | `relay`                       | Shell-mediated file and blob upload (NIP-96, Blossom)      | Draft    |
| NAP-VALUE    | `value`    | —   | `relay`                       | Shell-mediated value transfer and zaps                     | Draft    |
| NAP-OUTBOX   | `outbox`   | —   | `relay`                       | Outbox-aware relay routing and queries                     | Draft    |
| NAP-CVM      | `cvm`      | —   | `value`                       | Native ContextVM / MCP-over-Nostr bridge                   | Draft    |
| NAP-LINK     | `link`     | —   | —                             | Shell-mediated external link opening                       | Draft    |
| NAP-POW      | `pow`      | —   | `identity`, `relay`, `outbox` | NIP-13 proof-of-work miner                                 | Draft    |
| NAP-CLASS    | `class`    | —   | —                             | Napplet class authority (sub-track root)                   | Deferred |
| NAP-CONNECT  | `connect`  | —   | —                             | User-gated direct network access                           | Deferred |

### Additional package-level domains (no NAP spec yet)

These domains ship in `@napplet/nap` and `@napplet/sdk` but do not yet have standalone NAP spec files in the naps repo:

| Domain   | Purpose                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------- |
| `common` | Common social actions — NIP-19 helpers, profile lookup, follows, follow/unfollow, reactions, reports |
| `lists`  | NIP-51 list mutations (add/remove)                                                                   |
| `count`  | Event count queries through the shell                                                                |
| `dm`     | Shell-mediated encrypted direct-message helpers                                                      |
| `ble`    | Runtime-mediated Bluetooth LE/GATT sessions                                                          |
| `webrtc` | Runtime-mediated WebRTC data sessions                                                                |
| `serial` | Runtime-mediated serial device access                                                                |

## Governance

NIP-style informal process:

- Fork the repo, add a markdown file under `naps/` following the interface template, open a PR.
- Community discusses via PR comments.
- Maintainer (dskvr) merges when the spec makes sense and has at least one implementation.
- No formal stages, review committees, or voting.
- NAP-WORD names and NAAT slugs are first-come-first-served but must be approved by the maintainer.

## NAP-WORD Template structure

Every NAP spec follows this shape:

- **NAP ID**, **Domain**, **Depends** (by domain), **Web binding**
- **Description** — what the interface provides and why a napplet needs it
- **API Surface** — operation table (operation, parameters, result, wire message)
- **Schemas** — typed field tables for each result/parameter type
- **Wire Protocol** — message type table with direction and payload fields
- **Examples** — wire-level request/result exchanges
- **Error Handling** — how errors are reported
- **Shell Behavior** — MUST/SHOULD/MAY obligations for the runtime
- **Security Considerations** — trust boundaries and isolation guarantees
- **Implementations** — links to implementations
