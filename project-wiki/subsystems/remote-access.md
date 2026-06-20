---
title: Remote Access (Web App)
type: subsystem
status: verified
verified_at: 2026-06-20
sources:
  - relay/src/index.ts
  - src/bun/remote/
  - src/shared/remote/
  - src/mainview/lib/remote-transport.ts
  - docs/web-app-prd.md
tags: [remote, web-app, relay, e2e, pairing, cloudflare]
---

# Remote Access (Web App)

Lets a user reach their **own desktop** from a web browser on any device. The
desktop stays the backend (files, agents, SQLite); the browser is a thin remote
control. End-to-end encrypted, zero-signup, opt-in, and disabled by default —
existing users are unaffected. See [[overview]] and `docs/web-app-prd.md`.

> **One sentence:** the desktop dials OUT to a blind relay; a paired browser
> dials IN to the same relay; frames are forwarded opaquely and decrypted only at
> the two ends.

## Topology

```
 browser ──(WS, E2E)──►  relay.agentdesk.workers.dev  ◄──(WS, outbound)── desktop
   ▲  pairing QR (out of band)            │ blind forwarder (no plaintext)        │
   └────────── agentdeskweb.pages.dev ────┘                          real rpc-groups handlers
```

- **Relay** (`relay/`): a Cloudflare Worker + SQLite Durable Objects. Routes by a
  pairing **room**, forwards opaque frames, mints/verifies/revokes **role-scoped
  HMAC tokens**, and rate-limits the open `/register`. Deployed at
  `relay.agentdesk.workers.dev`.
- **Web app**: the same React SPA, built for the browser (`bun run build:web` →
  `dist-web/`), deployed to Cloudflare Pages at `agentdeskweb.pages.dev`.

## Cost model (Model A — free tier)

Cloudflare Workers + Durable Objects (SQLite, WebSocket Hibernation) + Pages, all
on the free tier — **$0** to users and to us within the free limits. One vendor
Cloudflare account; end users create nothing. See `docs/web-app-prd.md` §5.

## Backend (`src/bun/remote/`)

| File | Role |
|---|---|
| `rpc-handlers.ts` | The single combined request-handler map (all 8 rpc-groups). Both the Electrobun bridge (`rpc-registration.ts`) and the remote transport dispatch into it → identical results. |
| `rpc-ws-server.ts` | `Bun.serve` WS RPC server (opt-in via `AGENTDESK_REMOTE_RPC_PORT`) for direct/LAN/tunnel access; subscription-filtered broadcasts. |
| `broadcast-bus.ts` / `broadcast-hook.ts` | Pure fan-out bus + the engine-manager hook (`registerRemoteBroadcastSink`) so `broadcastToWebview` also reaches remote clients. |
| `relay-client.ts` | Desktop outbound relay transport (dial, status, reconnect). |
| `relay-session.ts` | Desktop session manager: per-device E2E sessions over the relay (handshake → decrypt RPC → dispatch → encrypt response/broadcast), cid-addressed for multiple devices. |
| `manager.ts` | Identity persistence (encrypted), pairing creation (QR), device list/rename/revoke, session lifecycle. Backs the remote-access RPCs. |
| `config.ts` | Baked-in relay/web URLs (env-overridable: `AGENTDESK_RELAY_HTTP`, `AGENTDESK_WEB_URL`). |
| `index.ts` | `maybeStartRemoteRpcServer` (direct WS) wiring. |

Startup: `src/bun/index.ts` calls `initRemoteAccess(requestHandlers)` (no-op
unless the user enabled it). Persistence: `remote_identity` + `remote_devices`
(migration `v47_remote-access-devices.ts`, raw-SQL). RPCs: contract in
`src/shared/rpc/remote-access.ts`, handler `src/bun/rpc/remote-access.ts`,
registered in `rpc-groups/features.ts`.

## Shared (`src/shared/remote/`, browser + Bun)

| File | Role |
|---|---|
| `e2e.ts` | Portable E2E: ECDH P-256 → HKDF-SHA256 → AES-256-GCM. |
| `pairing.ts` | `createDesktopPairing` (relay `/register` + keypair + QR payload) / `completeClientPairing`. |
| `ws-rpc-client.ts` | Generic WS-RPC client (direct connections). |
| `relay-rpc-client.ts` | Web client over the relay — mirror of `relay-session.ts` (handshake + cid + E2E). |
| `web-pairing.ts` | Web pairing persistence: store/restore the session across reloads (re-derives the key from a stored private-key JWK + the QR payload). |

## Frontend

- `src/mainview/lib/remote-transport.ts` — `IS_REMOTE` detection, the broadcast
  method→`agentdesk:*` DOM-event map, and `createRemoteRpcTransport()` (relay
  client backed by the stored pairing).
- `src/mainview/lib/rpc.ts` — branches at the single seam: Electrobun
  (`IS_REMOTE===false`, byte-identical to before) vs the WS-backed transport.
- `src/mainview/main.tsx` — web bootstrap: unpaired → `PairingScreen`, else `App`.
- `src/mainview/components/remote/pairing-screen.tsx` — paste-the-code pairing.
- `src/mainview/pages/settings/remote-access.tsx` — desktop **Settings → Channels →
  Remote Access** (enable, add device → QR/code, list/revoke). Wrappers in `rpc.ts`.
  (Lives under **Channels** because it is another way to reach the desk, alongside
  Discord/WhatsApp/Email — wired in `src/mainview/pages/settings.tsx`.)

## Security model (v1)

Zero-signup, so trust splits in two layers:

1. **Relay admittance** — a connection must present a token signed with
   `PAIRING_SIGNING_KEY` (HMAC). Tokens are role-scoped (`desktop` private,
   `client` in the QR); role+room+jti come from the signed payload. Revocable
   (`/revoke` + `revoked_tokens`); `/register` is rate-limited per IP.
2. **Confidentiality + per-device identity** — endpoints derive an E2E key from
   ECDH + the out-of-band **pairing secret** (HKDF salt, only ever in the QR), so
   a relay-only observer cannot read or forge traffic even with both public keys.
   The desktop is authoritative over which devices are admitted
   (`resolvePairingSecret`; revoke → no session).
3. **Time-bounding (TASK-492)** — `resolvePairingSecret` enforces two expiries so
   tokens aren't indefinitely live: an **unclaimed** QR must be redeemed within
   `PAIRING_CLAIM_WINDOW_MS` (30 min) — a stale/intercepted code dies after that;
   and a **claimed** device unseen for `DEVICE_INACTIVITY_MS` (90 days) expires →
   secret stops resolving → the user must re-pair. Active devices refresh
   `last_seen_at` on every connect, so they never expire. The relay also enforces
   token `e` (expiry) in `verifyToken`, though the room-scoped client token is
   left long-lived (it is shared across a room's devices; per-device control is
   the DB/pairing layer above, not the transport token).

> There is **no account login** — pairing IS the auth, because a mandatory
> Cloudflare-Access-style login would contradict zero-signup. Cloudflare Access
> remains available as an **optional** gate a user can put in front of their own
> `pages.dev` if they want account-level auth; the app neither requires nor
> implements it. (See [[github-token-auth]] for the unrelated git-auth pattern.)

## Isolation

Structural: one relay room per desktop; distinct rooms = distinct DO instances;
a client's room is bound in its signed token, so it can only reach its own
desktop. No shared/central DB. Cross-tenant isolation is tested in the relay suite.

## Verification

These are **standalone integration scripts**, NOT `bun:test` suites — they use a
`check()`/`main()`/`process.exit()` harness and are run directly by path against
a local `wrangler dev` relay (or in isolation). They are named `*.itest.ts`
(and `relay/test/relay-integration.mjs`) — deliberately OUTSIDE the `.test.*`
glob — so the repo-root `bun test` (which only runs the real `bun:test` suites
in `tests/`) never imports them and triggers their network calls / `process.exit`.

Run them directly, e.g. `bun src/shared/remote/relay-rpc-client.itest.ts`:
relay (`relay/test/relay-integration.mjs`), e2e, `ws-rpc-client.itest.ts`,
broadcast, `relay-client.itest.ts`, `relay-session.itest.ts`, pairing capstone
(`pairing.itest.ts`), `web-pairing.itest.ts`, and the **full loop**
(`relay-rpc-client.itest.ts`: web client ⇄ relay ⇄ desktop session). The full
loop + the relay suite also pass against the **live** `relay.agentdesk.workers.dev`.

## Re-pairing & recovery (TASK-493)

A paired web client persists its pairing in `localStorage` (`web-pairing.ts`), so
`isPaired()` stays true across reloads. The hazard: if that pairing goes **dead**
(the device was revoked, the desktop was reset to a new identity/room, or the QR
claim window/inactivity expiry elapsed), the web would otherwise sit on
"Connecting…" forever with no way to enter a new code. Two recovery paths:

1. **Desktop-driven reject** — when `relay-session.ts` handles a `hello` whose
   `resolvePairingSecret` returns null (revoked/unknown/claimed/expired), it now
   sends a `{ k:"reject", cid }` frame instead of silently dropping. The web's
   `relay-rpc-client` (`onRejected`) stops reconnecting and calls
   `forgetRemotePairing(reason)` → clears the stored pairing, stashes a reason in
   `sessionStorage` (`REPAIR_REASON_KEY`), and reloads to the `PairingScreen`.
2. **Manual escape hatch** — after ~10s stuck off-line, `RemoteStatusBanner`
   surfaces a **Re-pair** button (also `forgetRemotePairing()`), so a user can
   always recover even against an *old* desktop build that doesn't send `reject`.

So **to re-pair after a revoke**: revoke on the desktop → the web drops to the
pairing screen (auto, or via Re-pair) → desktop **Add device** → paste the new
code. (Reject-on-unpaired needs the desktop on a build ≥ this change; the Re-pair
button is web-only and works regardless.)

## Gotchas

- **Desktop must be online** — the browser is a remote control; if the desktop is
  asleep/offline the web app shows an offline/not-paired state.
- **A dead pairing no longer strands the user** — see *Re-pairing & recovery*
  above; `localStorage` pairing is cleared on reject or via the banner's Re-pair.
- **Native-only features** (tray, terminal, file dialogs, `<electrobun-webview>`)
  don't exist in a plain browser — gated by `IS_REMOTE` (see `docs/web-app-prd.md`
  §9; native-gating work tracked separately).
- `*.pages.dev` subdomains are globally unique → the project is `agentdeskweb`.
