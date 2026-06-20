# AgentDesk Relay

A **blind, stateless WebSocket forwarder** that lets the AgentDesk web app (and,
later, a mobile app) reach a user's own desktop over the internet. It is the
backbone of the remote-access feature described in [`../docs/web-app-prd.md`](../docs/web-app-prd.md).

## What it is (and isn't)

- **Is:** a Cloudflare Worker + a SQLite-backed Durable Object that routes
  end-to-end-encrypted frames between a user's desktop and that user's remote
  clients, scoped by a pairing room.
- **Isn't:** a place where any project data, files, or chat history lives. The
  relay forwards **opaque** frames and never decrypts payloads. The real backend
  (agents, files, SQLite) stays on each user's own machine.

## Cost model (Model A — free tier)

- Hosted on Cloudflare Workers + **Durable Objects (SQLite-backed, free tier)**.
- The Durable Object uses the **WebSocket Hibernation API**, so idle paired
  connections incur **no duration billing**.
- Fixed free URL: `relay.agentdesk.workers.dev`. $0 within the free tier; the
  $5/mo Workers Paid plan is only a ceiling reached at large scale.

## Develop

```bash
npm install
npm run dev          # wrangler dev — local Worker + DO (reads .dev.vars)
npm run typecheck    # tsc --noEmit
npm run dry-run      # wrangler deploy --dry-run (build + config validation)
npm test             # integration test (requires `npm run dev` running)
```

`npm test` exercises registration, token rejection, opaque text/binary
forwarding both directions, one-desktop-per-room replacement, the
desktop-offline lifecycle, and cross-tenant isolation.

## Deploy (TASK-473)

```bash
npm run deploy                          # first deploy registers relay.agentdesk.workers.dev
wrangler secret put PAIRING_SIGNING_KEY # HMAC key for pairing tokens (never committed)
curl https://relay.agentdesk.workers.dev/health
```

## Architecture

- **Worker entry** (`src/index.ts`): upgrades WebSockets and routes each to a
  room Durable Object via `getByName(room)`.
- **`RelayDurableObject`**: one instance per pairing room. Holds one desktop and
  its connected clients; forwards `desktop -> clients` and `client -> desktop`.
  Accepts sockets with the **Hibernation API** (`ctx.acceptWebSocket`) and tags
  each with its role so routing survives hibernation.
- **`paired_devices` table**: per-device records (id, public key, revoked),
  populated by the pairing handshake.

## Build status

| Task | Scope | Status |
|---|---|---|
| TASK-470 | Scaffold: Worker + SQLite DO + Hibernation + room forwarding | ✅ done |
| TASK-471 | Authenticated identity routing, one-desktop-per-room, lifecycle | ✅ done |
| TASK-472 | Pairing handshake: `/register` mints signed role-scoped tokens | ✅ done |
| TASK-473 | First deploy + register subdomain + set signing secret | TODO |
| TASK-477 / 482 | Endpoint E2E + per-device revocation (`paired_devices`) | TODO |

> **Security note (review the model in `src/index.ts`).** A WebSocket must now
> present a **signed, role-scoped token** (`desktop` vs `client`) to connect, and
> the room is taken from the signed payload — not a query param. The relay still
> only forwards **opaque** frames. Two things remain before production use:
> (1) endpoint-to-endpoint encryption + per-device revocation, enforced at the
> desktop (TASK-477) and web client (TASK-482); (2) setting the real
> `PAIRING_SIGNING_KEY` secret at deploy (TASK-473).
