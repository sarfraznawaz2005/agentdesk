// ---------------------------------------------------------------------------
// Auto-Earn — settings panel (Freelance → Settings tab)
//
// Controlled component: the parent SettingsTab owns the value and persists it
// through the single global Save button (no separate save here). Full-auto
// cannot be the default autonomy mode without the risk acknowledgment.
// ---------------------------------------------------------------------------

import { HelpCircle } from "lucide-react";
import { Tip } from "../ui/tooltip";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
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

// Comparison rows for the Assisted vs Full-auto modal.
const AUTONOMY_ROWS: Array<{ label: string; assisted: string; fullAuto: string }> = [
  { label: "Drafting replies", assisted: "When you ask", fullAuto: "Automatic, on each new client message" },
  { label: "Sending replies", assisted: "You click Approve & Send", fullAuto: "Sent automatically (governor-paced)" },
  { label: "Doing the work (clone / build)", assisted: "—", fullAuto: "AI agent does it autonomously" },
  { label: "Placing a bid", assisted: "You click Place Bid", fullAuto: "You click Place Bid (same)" },
  { label: "Delivering finished work", assisted: "You", fullAuto: "AI prepares + reviews, then you approve" },
  { label: "Sensitive messages (money / contracts / off-platform / disputes)", assisted: "You handle them", fullAuto: "Escalated to you — never auto-answered" },
  { label: "Runs in background on any page", assisted: "Yes (sync + notifications)", fullAuto: "Yes (sync + notifications + replies + work)" },
  { label: "Account risk", assisted: "Very low", fullAuto: "Higher — requires the risk acknowledgment" },
];

// The "Default autonomy" help opens a modal (instead of a tooltip) with the help
// text plus a side-by-side Assisted vs Full-auto comparison.
function AutonomyHelpModal() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="Default autonomy — what's the difference?"
          className="inline-flex text-muted-foreground/70 hover:text-foreground"
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Default autonomy</DialogTitle>
          <DialogDescription>
            How replies and bids are handled by default. Each connected account can override this from the Inbox tab.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p>
            <strong>Assisted</strong> — the AI writes drafts; you edit and click Send. Safest, near-zero risk.{" "}
            <strong>Full-auto</strong> — an AI agent handles conversations and the work on its own (requires the risk
            acknowledgment). Money actions — <em>placing bids</em> and <em>delivering work</em> — still need your approval
            in both modes.
          </p>
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left">
                  <th className="px-2 py-1.5 font-medium"> </th>
                  <th className="px-2 py-1.5 font-medium">Assisted</th>
                  <th className="px-2 py-1.5 font-medium">Full-auto</th>
                </tr>
              </thead>
              <tbody>
                {AUTONOMY_ROWS.map((r) => (
                  <tr key={r.label} className="border-b border-border/60 last:border-0 align-top">
                    <td className="px-2 py-1.5 font-medium">{r.label}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{r.assisted}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{r.fullAuto}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            Tip: start with Assisted. Move an account to Full-auto only once you trust the drafts.
          </p>
        </div>
      </DialogContent>
    </Dialog>
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

      <label className="flex items-center gap-2">
        <input type="checkbox" checked={s.autoBidShortlisted} onChange={(e) => patch({ autoBidShortlisted: e.target.checked })} />
        <span className="text-sm">Auto-draft proposals for shortlisted listings</span>
        <HelpIcon text="When a listing is auto-shortlisted, automatically draft a proposal and queue it for you (in Full-auto it's also filled into the bid form, ready to place). Bids are NEVER auto-placed — you always click Place Bid. Off by default." />
      </label>

      <div className="grid grid-cols-2 gap-4">
        {/* Rendered manually (not via <Field>) so the modal trigger isn't nested in
            a <label> that would also toggle the select. */}
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            Default autonomy
            <AutonomyHelpModal />
          </span>
          <select
            value={s.autonomyMode}
            onChange={(e) => patch({ autonomyMode: e.target.value as "assisted" | "full_auto" })}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          >
            <option value="assisted">Assisted (you send)</option>
            <option value="full_auto">Full-auto</option>
          </select>
        </div>
        <Field
          label="Max sends / hour"
          help="The most replies the app will send in any rolling 60-minute window — a hard cap so the account never looks like a spam bot. Bids use a stricter limit (half this, minimum 1) plus the daily bid budget below."
        >
          <input type="number" min={1} value={s.maxSendsPerHour}
            onChange={(e) => patch({ maxSendsPerHour: num(e.target.value, 4) })}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
        </Field>
        <Field
          label="Max bids / day"
          help="Hard daily budget for proposals across all projects (rolling 24h). Freelancer memberships include a monthly bid quota — this keeps automated bidding well inside it and far below spam velocity. Set to 0 to disable the daily cap (hourly limits still apply)."
        >
          <input type="number" min={0} value={s.bidDailyCap}
            onChange={(e) => patch({ bidDailyCap: num(e.target.value, 10) })}
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
          label="Auto-dismiss stale bids (hours)"
          help="A bid that's been filled and waiting for you to place it ('awaiting review') is automatically dismissed after this many hours — by then the project is usually already awarded to someone else. Set to 0 to never auto-dismiss."
        >
          <input type="number" min={0} value={s.bidStaleHours}
            onChange={(e) => patch({ bidStaleHours: num(e.target.value, 24) })}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
        </Field>
        <Field
          label="Bid pricing"
          help="How the bid amount is chosen from the project budget. Average = middle of the range; Min/Max = the low/high end; Percentile = a chosen position in the range. Hourly projects use the hourly rate below when set."
        >
          <select value={s.bidPricingMode} onChange={(e) => patch({ bidPricingMode: e.target.value })}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm">
            <option value="avg">Average of range</option>
            <option value="min">Budget minimum (competitive)</option>
            <option value="max">Budget maximum</option>
            <option value="percentile">Percentile of range</option>
          </select>
        </Field>
        {s.bidPricingMode === "percentile" && (
          <Field
            label="Bid percentile (%)"
            help="Where in the budget range to bid: 0 = minimum, 100 = maximum, 25 = lower quarter."
          >
            <input type="number" min={0} max={100} value={s.bidPercentile}
              onChange={(e) => patch({ bidPercentile: num(e.target.value, 50) })}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
          </Field>
        )}
        <Field label="Bid floor (min)" help="Never bid below this amount. 0 = no floor.">
          <input type="number" min={0} value={s.bidMinClamp}
            onChange={(e) => patch({ bidMinClamp: num(e.target.value, 0) })}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
        </Field>
        <Field label="Bid ceiling (max)" help="Never bid above this amount. 0 = no ceiling.">
          <input type="number" min={0} value={s.bidMaxClamp}
            onChange={(e) => patch({ bidMaxClamp: num(e.target.value, 0) })}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
        </Field>
        <Field label="Hourly rate" help="Amount to bid on hourly projects. 0 = use the project's listed budget.">
          <input type="number" min={0} value={s.bidHourlyRate}
            onChange={(e) => patch({ bidHourlyRate: num(e.target.value, 0) })}
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
