// RPC contract for the web-app Remote Access feature (TASK-477).
//
// Lets the desktop expose a pairing QR, list paired devices, and revoke them.
// The relay/E2E machinery lives in src/bun/remote + src/shared/remote; these
// RPCs are the thin control surface the desktop UI (and, later, the mobile
// settings) call.

export interface RemoteDeviceDto {
  /** pairingId */
  id: string;
  name: string;
  revoked: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface RemoteAccessStatusDto {
  /** The user has turned remote access on. */
  enabled: boolean;
  /** The desktop is currently connected to the relay. */
  connected: boolean;
  /** The relay URL is baked into this build (Model A). */
  relayConfigured: boolean;
  /** Number of paired, non-revoked devices. */
  deviceCount: number;
  /** The web app URL to open/scan to reach this desktop (Cloudflare Pages). */
  webUrl: string;
}

export interface DevicePairingDto {
  /** base64url QR contents the user scans in the web app. */
  qr: string;
  pairingId: string;
  /** The web app URL to open (Cloudflare Pages), for convenience. */
  webUrl: string;
}

export type RemoteAccessRequests = {
  getRemoteAccessStatus: {
    params: Record<string, never>;
    response: { status: RemoteAccessStatusDto };
  };
  setRemoteAccessEnabled: {
    params: { enabled: boolean };
    response: { status: RemoteAccessStatusDto };
  };
  /** Create a new device pairing (ensuring a relay room exists) and return the QR. */
  createDevicePairing: {
    params: { name?: string };
    response: { pairing: DevicePairingDto };
  };
  listPairedDevices: {
    params: Record<string, never>;
    response: { devices: RemoteDeviceDto[] };
  };
  renameDevice: {
    params: { id: string; name: string };
    response: { ok: boolean };
  };
  /** Revoke a device locally and on the relay; kicks any live connection. */
  revokeDevice: {
    params: { id: string };
    response: { ok: boolean };
  };
  /** Permanently remove a device row from the list (also revokes it first). */
  deleteDevice: {
    params: { id: string };
    response: { ok: boolean };
  };
};
