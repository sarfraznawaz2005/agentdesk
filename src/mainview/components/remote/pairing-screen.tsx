import { useState } from "react";
import { completeAndStorePairing } from "../../../shared/remote/web-pairing";
import { REPAIR_REASON_KEY } from "@/lib/remote-transport";

/**
 * Web pairing screen (TASK-482).
 *
 * Shown by the web bootstrap when the browser is not yet paired to a desktop.
 * The user pastes (or scans) the pairing code shown on their desktop's
 * "Remote access" settings. On success we persist the pairing and reload so the
 * app boots with a live relay transport.
 *
 * QR-camera scanning is a later enhancement; the pasted code is the robust v1.
 */
export function PairingScreen() {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One-shot reason set when a stale/revoked pairing was cleared (read once).
  const [repairReason] = useState<string | null>(() => {
    try {
      const r = sessionStorage.getItem(REPAIR_REASON_KEY);
      if (r) sessionStorage.removeItem(REPAIR_REASON_KEY);
      return r;
    } catch {
      return null;
    }
  });

  async function connect() {
    const trimmed = code.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await completeAndStorePairing(trimmed);
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pairing failed — check the code and try again.");
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-xl">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold">Connect to your desktop</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            On your computer open <span className="font-medium">AgentDesk → Settings → Channels → Remote Access</span>,
            create a pairing code, then scan or paste it here.
          </p>
        </div>

        {repairReason && (
          <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-300">
            {repairReason}
          </div>
        )}

        <label className="mb-2 block text-sm font-medium" htmlFor="pairing-code">
          Pairing code
        </label>
        <textarea
          id="pairing-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) connect();
          }}
          placeholder="Paste the pairing code from your desktop…"
          rows={4}
          className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
          autoFocus
        />

        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

        <button
          type="button"
          onClick={connect}
          disabled={!code.trim() || busy}
          className="mt-5 w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Connecting…" : "Connect"}
        </button>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Your desktop must be running and online. Files and agents stay on your machine — this browser is a remote
          control.
        </p>
      </div>
    </div>
  );
}
