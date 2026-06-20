import { sqlite } from "../connection";

export const name = "remote-access-devices";

// Paired remote devices for the web-app remote-access feature (TASK-477).
// Each row is one device the user paired by scanning the desktop's QR. The
// pairing secret (HKDF salt) is stored ENCRYPTED at rest, like other secrets.
// The desktop's own pairing identity (keypair, relay room, desktop token) lives
// in `settings` under category "remote" — not here.
//
// Raw-SQL table (not Drizzle-managed), consistent with the other remote_* tables.
export function run(): void {
  sqlite.exec(`
-- Single-row table holding the desktop's own relay pairing identity.
CREATE TABLE IF NOT EXISTS remote_identity (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  enabled           INTEGER NOT NULL DEFAULT 0,
  room_id           TEXT NOT NULL DEFAULT '',
  desktop_token_enc TEXT NOT NULL DEFAULT '',   -- AES-encrypted relay desktop token
  client_token      TEXT NOT NULL DEFAULT '',
  keypair_enc       TEXT NOT NULL DEFAULT '',   -- AES-encrypted JWK { publicKey, privateKey }
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS remote_devices (
  id                  TEXT PRIMARY KEY,              -- pairingId
  name                TEXT NOT NULL DEFAULT 'Device',
  pairing_secret_enc  TEXT NOT NULL DEFAULT '',      -- AES-encrypted HKDF salt
  client_token        TEXT NOT NULL DEFAULT '',      -- relay client token (for /revoke)
  public_key          TEXT NOT NULL DEFAULT '',      -- client ECDH public key (set on first connect)
  revoked             INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_remote_devices_revoked
  ON remote_devices(revoked, created_at);
`);
}
