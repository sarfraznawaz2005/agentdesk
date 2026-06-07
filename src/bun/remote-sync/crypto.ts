// ---------------------------------------------------------------------------
// Remote Sync — credential encryption at rest
// ---------------------------------------------------------------------------
// The implementation now lives in the shared lib/secret-crypto module (same
// AES-256-GCM scheme and the same `remote-sync.key` master key), so every
// feature encrypts secrets identically. This file re-exports it to preserve
// the existing Remote Sync import paths.
// ---------------------------------------------------------------------------

export { isEncrypted, encryptSecret, decryptSecret } from "../lib/secret-crypto";
