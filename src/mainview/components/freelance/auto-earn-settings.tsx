// ---------------------------------------------------------------------------
// Auto-Earn — settings panel (Freelance → Settings tab)
//
// Controlled component: the parent SettingsTab owns the value and persists it
// through the single global Save button (no separate save here). Full-auto
// cannot be the default autonomy mode without the risk acknowledgment.
// ---------------------------------------------------------------------------

import { HelpCircle } from "lucide-react";
import { Tip } from "../ui/tooltip";
import type { FreelanceAutoEarnSettingsDto } from "../../../shared/rpc/freelance";

function HelpIcon({ text }: { text: string }) {
  return (
    <Tip content={text} side="top">
      <button type="button" aria-label="Help" className="inline-flex text-muted-foreground/70 hover:text-foreground">
        <HelpCircle className="h-3.5 w-3.5" />
      </button>
    </Tip>
  );
}

interface Props {
  value: FreelanceAutoEarnSettingsDto;
  onChange: (next: FreelanceAutoEarnSettingsDto) => void;
}

export function AutoEarnSettings({ value: s, onChange }: Props) {
  const patch = (p: Partial<FreelanceAutoEarnSettingsDto>) => onChange({ ...s, ...p });

  const num = (v: string, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <div>
        <h3 className="text-base font-semibold">Auto-Earn</h3>
        <p className="text-sm text-muted-foreground">
          Read your platform inbox in-app and (optionally) let AI draft and send replies.
          Sending respects the Behavior Governor below so the account is not flagged.
          Active hours use the timezone set in <strong>Settings → General</strong> (default UTC).
          Changes apply when you click <strong>Save</strong> at the bottom.
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          <strong>Note:</strong> Currently works with <strong>Freelancer.com</strong>. More platforms coming soon.
        </p>
      </div>

      <label className="flex items-center gap-2">
        <input type="checkbox" checked={s.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
        <span className="text-sm font-medium">Enable Auto-Earn (master switch)</span>
        <HelpIcon text="Turns the whole Auto-Earn feature on. When off, the Inbox tab is hidden and no background syncing or sending happens. Off by default." />
      </label>

      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Default autonomy"
          help="How replies and bids are sent by default. Assisted: the AI writes a draft, you edit it and click Send yourself. Full-auto: the app sends on its own (requires the risk acknowledgment below). Each connected account can override this."
        >
          <select
            value={s.autonomyMode}
            onChange={(e) => patch({ autonomyMode: e.target.value as "assisted" | "full_auto" })}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          >
            <option value="assisted">Assisted (you send)</option>
            <option value="full_auto">Full-auto</option>
          </select>
        </Field>
        <Field
          label="Max sends / hour"
          help="The most messages or bids the app will send in any rolling 60-minute window — a hard cap so the account never looks like a spam bot. Bids use a stricter limit (half this, minimum 1)."
        >
          <input type="number" min={1} value={s.maxSendsPerHour}
            onChange={(e) => patch({ maxSendsPerHour: num(e.target.value, 1) })}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
        </Field>
        <Field
          label="Min gap between sends (s)"
          help="Minimum seconds enforced between any two sends. Prevents rapid-fire sending, which is a common ban trigger. Bids wait 3x this gap."
        >
          <input type="number" min={5} value={s.minGapSeconds}
            onChange={(e) => patch({ minGapSeconds: num(e.target.value, 90) })}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
        </Field>
        <Field
          label="Active hours"
          help="Sending and background inbox sync only run between these two hours (e.g. 9 to 22 = 9am–10pm). Outside the window everything pauses, so there's no robotic 3am activity. Hours use the timezone set in Settings → General (default UTC)."
        >
          <div className="flex items-center gap-2">
            <input type="number" min={0} max={23} value={s.activeHours.start}
              onChange={(e) => patch({ activeHours: { ...s.activeHours, start: num(e.target.value, 9) } })}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
            <span className="text-muted-foreground">to</span>
            <input type="number" min={0} max={23} value={s.activeHours.end}
              onChange={(e) => patch({ activeHours: { ...s.activeHours, end: num(e.target.value, 22) } })}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
          </div>
        </Field>
        <Field
          label="Default delivery days"
          help="The 'This project will be delivered in … days' value prefilled on every bid. You can still change it per-bid in the live session before placing the bid."
        >
          <input type="number" min={1} value={s.bidDeliveryDays}
            onChange={(e) => patch({ bidDeliveryDays: num(e.target.value, 7) })}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
        </Field>
        <Field
          label="Inbox sync min interval (s)"
          help="Floor of the random delay between automatic inbox refreshes. The app re-checks your inbox at a random time between this and the max, so the rhythm doesn't look mechanical."
        >
          <input type="number" min={30} value={s.pollMin}
            onChange={(e) => patch({ pollMin: num(e.target.value, 180) })}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
        </Field>
        <Field
          label="Inbox sync max interval (s)"
          help="Ceiling of the random delay between automatic inbox refreshes. Paired with the min to create a jittered, human-like polling cadence instead of a fixed interval."
        >
          <input type="number" min={30} value={s.pollMax}
            onChange={(e) => patch({ pollMax: num(e.target.value, 480) })}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
        </Field>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Notifications</span>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={s.notifyDesktop} onChange={(e) => patch({ notifyDesktop: e.target.checked })} />
          <span className="text-sm">Desktop notification on new client reply</span>
          <HelpIcon text="Show a desktop (OS) notification when a client sends you a new message. Turn this off to stay silent." />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={s.notifyChannels} onChange={(e) => patch({ notifyChannels: e.target.checked })} />
          <span className="text-sm">Notify on channels</span>
          <HelpIcon text="Also forward new client messages to your connected channels (Discord, WhatsApp, email, etc.). Set those up in the main Settings → Channels." />
        </label>
      </div>

      <label className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
        <input type="checkbox" checked={s.fullautoAck} onChange={(e) => patch({ fullautoAck: e.target.checked })} className="mt-0.5" />
        <span className="text-sm text-muted-foreground">
          <strong className="text-amber-600 dark:text-amber-400">Full-auto risk acknowledgment.</strong>{" "}
          I understand that letting AI send messages or bids without my click crosses the platform&apos;s
          automation line and can risk my account. Full-auto stays off until this is checked.
        </span>
      </label>
    </div>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {label}
        {help && <HelpIcon text={help} />}
      </span>
      {children}
    </label>
  );
}
