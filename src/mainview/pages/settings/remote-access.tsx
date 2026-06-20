import { useEffect, useState, useCallback } from "react";
import { rpc } from "@/lib/rpc";
import { Switch } from "@/components/ui/switch";
import type { RemoteAccessStatusDto, RemoteDeviceDto } from "../../../shared/rpc/remote-access";

/**
 * Remote Access settings (TASK-477 UI).
 *
 * Enable/disable remote access, create a device pairing (shows the code the web
 * app pastes), and list/revoke paired devices.
 */
export function RemoteAccessSettings() {
  const [status, setStatus] = useState<RemoteAccessStatusDto | null>(null);
  const [devices, setDevices] = useState<RemoteDeviceDto[]>([]);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([rpc.getRemoteAccessStatus(), rpc.listPairedDevices()]);
      setStatus(s.status);
      setDevices(d.devices);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load remote access");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggle(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      const r = await rpc.setRemoteAccessEnabled(enabled);
      setStatus(r.status);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update");
    } finally {
      setBusy(false);
    }
  }

  async function addDevice() {
    setBusy(true);
    setError(null);
    try {
      const r = await rpc.createDevicePairing();
      setPairingCode(r.pairing.qr);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create pairing");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    try {
      await rpc.revokeRemoteDevice(id);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await rpc.deleteRemoteDevice(id);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function copyCode() {
    if (!pairingCode) return;
    void navigator.clipboard.writeText(pairingCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Remote Access</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Reach this desktop from a web browser on another device. Your files and agents stay on this machine — the
          browser is a remote control. The desktop must be running and online.
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Enable toggle + status */}
      <div className="flex items-center justify-between rounded-lg border border-border p-4">
        <div>
          <div className="text-sm font-medium">Enable remote access</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {status
              ? `${status.connected ? "Connected to relay" : "Not connected"} · ${status.deviceCount} device${status.deviceCount === 1 ? "" : "s"}${status.relayConfigured ? "" : " · relay not configured"}`
              : "Loading…"}
          </div>
        </div>
        <Switch
          checked={status?.enabled ?? false}
          onCheckedChange={(checked) => toggle(checked)}
          disabled={busy || !status}
          aria-label="Enable remote access"
        />
      </div>

      {/* Devices */}
      <div className="rounded-lg border border-border">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="text-sm font-medium">Paired devices</div>
          <button
            type="button"
            onClick={addDevice}
            disabled={busy}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:brightness-110 disabled:opacity-50"
          >
            Add device
          </button>
        </div>

        {pairingCode && (
          <div className="border-b border-border bg-muted/40 p-4">
            <div className="mb-2 text-xs font-medium">
              Open the web app and paste this code to pair (valid for this device):
            </div>
            <textarea
              readOnly
              value={pairingCode}
              rows={3}
              className="w-full resize-none rounded border border-input bg-background px-2 py-1.5 font-mono text-[11px]"
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={copyCode} className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted">
                {copied ? "Copied!" : "Copy code"}
              </button>
              <button type="button" onClick={() => setPairingCode(null)} className="rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground">
                Done
              </button>
            </div>
          </div>
        )}

        {devices.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">No devices paired yet.</div>
        ) : (
          <ul className="divide-y divide-border">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <div className={`text-sm ${d.revoked ? "text-muted-foreground line-through" : ""}`}>{d.name}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Paired {new Date(d.createdAt).toLocaleDateString()}
                    {d.lastSeenAt ? ` · last seen ${new Date(d.lastSeenAt).toLocaleString()}` : ""}
                    {d.revoked ? " · revoked" : ""}
                  </div>
                </div>
                {d.revoked ? (
                  <button
                    type="button"
                    onClick={() => remove(d.id)}
                    disabled={busy}
                    className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                    title="Remove this device from the list"
                  >
                    Remove
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => revoke(d.id)}
                    disabled={busy}
                    className="rounded-md border border-destructive/40 px-2.5 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
