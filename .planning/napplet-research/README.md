# Napplet & NAP Research

> Compiled from https://github.com/napplet/naps and https://napplet.run/docs/ on 2026-07-23.
> Status: napplet is **alpha** — specs are experimental and a moving target. Always treat the living GitHub documents as the source of truth.

## What this is

A complete reference for future agents working on stlstr, covering:

- The **NAP** (Nostr Applet Protocol) capability seam — every NAP spec, its domain, wire protocol, and security model.
- The **@napplet/\*** package ecosystem — what each package does, its exports, and dependency graph.
- The **NIP-5D** web projection — how napplets run in sandboxed iframes and communicate via `postMessage`.
- **NAAT** archetypes — the role axis for cross-napplet intent dispatch.
- **Conventions** — unnumbered message shapes napplets use to talk to each other.

## File index

| File               | Contents                                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-nap-system.md` | NAP governance, layering, the two axes (NAP-WORD / Convention / NAAT), boundary rule, web projection                                                            |
| `02-nap-specs.md`  | Full text of every NAP spec (SHELL, INTENT, INC, RELAY, OUTBOX, STORAGE, IDENTITY, KEYS, THEME, MEDIA, NOTIFY, CONFIG, RESOURCE, UPLOAD, VALUE, CVM, LINK, POW) |
| `03-packages.md`   | All @napplet/* packages: core, shim, sdk, nap, vite-plugin, cli, conformance, conformance-cli, conformance-web, boilerplate, skills                             |
| `04-guide.md`      | NIP-5D explained, core concepts, getting started, spec status                                                                                                   |
| `05-archetypes.md` | NAAT archetype registry and entry schema                                                                                                                        |

## Quick orientation

A **napplet** is a small, single-purpose Nostr web app running in a `sandbox="allow-scripts"` iframe. It never touches signing keys, relays, or storage directly — every sensitive operation is brokered by the host **shell** over `postMessage` using a JSON envelope wire format (`{ type: "domain.action", ...payload }`).

A **NAP** is one capability contract in that seam. `NAP-RELAY` says "the runtime can proxy relay reads/writes, and here's exactly how a napplet requests them." NAPs are transport-agnostic; the **web projection** (NIP-5D) maps them to `window.napplet.<domain>` objects.

Napplets discover capabilities via `shell.supports("<domain>")` (NAP-SHELL) and feature-gate optional domains with `if (window.napplet?.domain)` before use.

## Key sources

- **NIP-5D** (protocol): https://github.com/nostr-protocol/nips/pull/2303
- **NAPs track** (capability domains): https://github.com/napplet/naps
- **Package docs**: https://napplet.run/docs/
- **NIP-5A** (manifest/identity): https://github.com/nostr-protocol/nips/blob/master/5A.md
- **Reference shell (Kehto)**: https://github.com/kehto/web
