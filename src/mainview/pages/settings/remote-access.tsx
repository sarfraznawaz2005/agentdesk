import { useEffect, useState, useCallback } from "react";
import { toDataURL } from "qrcode";
import { ExternalLink, QrCode, Copy, Check, Smartphone } from "lucide-react";
import { rpc } from "@/lib/rpc";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
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
  const [urlCopied, setUrlCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [pairQr, setPairQr] = useState<{ dataUrl: string; url: string } | null>(null);

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

  async function pairViaQr() {
    setBusy(true);
    setError(null);
    try {
      const r = await rpc.createDevicePairing();
      // Embed the one-time pairing code in the web URL so a single scan both opens
      // the app AND auto-pairs this device (the web bootstrap reads ?pair=).
      const u = new URL(r.pairing.webUrl);
      u.searchParams.set("pair", r.pairing.qr);
      const url = u.toString();
      // errorCorrectionLevel "L" maximizes data capacity (the URL carries the payload).
      const dataUrl = await toDataURL(url, { width: 260, margin: 1, errorCorrectionLevel: "L" });
      setPairQr({ dataUrl, url });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create pairing QR");
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

  const webUrl = status?.webUrl ?? "";

  function openUrl() {
    if (webUrl) void rpc.openExternalUrl(webUrl);
  }

  function copyUrl() {
    if (!webUrl) return;
    void navigator.clipboard.writeText(webUrl).then(() => {
      setUrlCopied(true);
      setTimeout(() => setUrlCopied(false), 1500);
    });
  }

  async function openQr() {
    if (!webUrl) return;
    try {
      // Encodes the plain web URL so a phone camera opens the app directly.
      const dataUrl = await toDataURL(webUrl, { width: 240, margin: 1 });
      setQrDataUrl(dataUrl); // non-null → opens the QR dialog
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate QR code");
    }
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

      {/* Web address — where to open the app on another device */}
      {status?.enabled && webUrl && (
        <div className="rounded-lg border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">Web address</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                Open this on another device (or scan the QR on a phone), then pair it below.
              </div>
              <a
                href={webUrl}
                onClick={(e) => { e.preventDefault(); openUrl(); }}
                className="mt-1.5 block max-w-full truncate font-mono text-sm text-primary hover:underline"
                title={webUrl}
              >
                {webUrl}
              </a>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={openUrl}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:brightness-110"
              >
                <ExternalLink className="h-3.5 w-3.5" /> Open
              </button>
              <button
                type="button"
                onClick={copyUrl}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted"
              >
                {urlCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {urlCopied ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                onClick={openQr}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted"
              >
                <QrCode className="h-3.5 w-3.5" /> QR
              </button>
            </div>
          </div>
        </div>
      )}

      {/* QR modal — scan to open the web app on a phone */}
      <Dialog open={qrDataUrl !== null} onOpenChange={(open) => { if (!open) setQrDataUrl(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Scan to open on your phone</DialogTitle>
            <DialogDescription>
              Point your phone camera at this code to open the app, then pair the device.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3 pb-2">
            {qrDataUrl && (
              <img
                src={qrDataUrl}
                alt={`QR code for ${webUrl}`}
                width={240}
                height={240}
                className="rounded-md bg-white p-2"
              />
            )}
            <a
              href={webUrl}
              onClick={(e) => { e.preventDefault(); openUrl(); }}
              className="max-w-full truncate font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
              title={webUrl}
            >
              {webUrl}
            </a>
          </div>
        </DialogContent>
      </Dialog>

      {/* Pair-via-QR modal — scanning pairs the phone AND opens the app */}
      <Dialog open={pairQr !== null} onOpenChange={(open) => { if (!open) setPairQr(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Pair a phone via QR</DialogTitle>
            <DialogDescription>
              Scan this with your phone camera — it opens AgentDesk and pairs the device automatically. No code to type.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3 pb-2">
            {pairQr && (
              <img
                src={pairQr.dataUrl}
                alt="Device pairing QR code"
                width={260}
                height={260}
                className="rounded-md bg-white p-2"
              />
            )}
            <p className="text-center text-xs text-muted-foreground">
              Pairs one device · valid for 30 minutes · keep it private (anyone who scans it can reach this desktop).
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {/* Devices */}
      <div className="rounded-lg border border-border">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="text-sm font-medium">Paired devices</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={pairViaQr}
              disabled={busy || !status?.enabled}
              title={status?.enabled ? "Show a QR a phone can scan to pair + open the app" : "Enable remote access first"}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              <Smartphone className="h-3.5 w-3.5" /> Pair via QR
            </button>
            <button
              type="button"
              onClick={addDevice}
              disabled={busy}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:brightness-110 disabled:opacity-50"
            >
              Add device
            </button>
          </div>
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
