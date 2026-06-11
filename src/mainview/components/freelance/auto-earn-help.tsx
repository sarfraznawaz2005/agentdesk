// ---------------------------------------------------------------------------
// Auto-Earn — in-app Help guide (user-facing)
//
// A plain-language guide rendered as the "Help" sub-tab of the Auto-Earn tab.
// Audience: non-technical users. Explains what the feature is, how to set it up,
// the two modes, how to reply/bid, the dashboard/alerts, the settings, safety, and
// an FAQ. Kept in sync with docs/autoearn-user-guide.md.
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <div className="space-y-2 text-sm text-muted-foreground">{children}</div>
    </section>
  );
}

function Callout({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" }) {
  const cls =
    tone === "warn"
      ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
      : "border-primary/30 bg-primary/5 text-foreground";
  return <div className={`rounded-md border p-3 text-sm ${cls}`}>{children}</div>;
}

function Faq({ q, children }: { q: string; children: ReactNode }) {
  return (
    <details className="group rounded-md border border-border px-3 py-2">
      <summary className="cursor-pointer list-none text-sm font-medium text-foreground marker:hidden">
        <span className="mr-1.5 inline-block text-muted-foreground transition-transform group-open:rotate-90">▸</span>
        {q}
      </summary>
      <div className="mt-2 pl-4 text-sm text-muted-foreground">{children}</div>
    </details>
  );
}

export function AutoEarnHelp() {
  return (
    <div className="mx-auto max-w-3xl space-y-7 py-1">
      <div>
        <h2 className="text-lg font-semibold">Auto-Earn — how it works & how to use it</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A simple, step-by-step guide. No technical knowledge needed.
        </p>
      </div>

      <Section title="1. What is Auto-Earn?">
        <p>
          Auto-Earn brings your <strong>Freelancer.com inbox right into AgentDesk</strong> and uses AI to help you
          <strong> reply to clients</strong> and <strong>send proposals (bids)</strong> — so you can win and keep work
          with much less effort.
        </p>
        <p>Think of it as a smart assistant that:</p>
        <ul className="ml-5 list-disc space-y-1">
          <li>Reads your messages from the freelance site and shows them inside AgentDesk.</li>
          <li>Writes a draft reply or proposal for you using AI.</li>
          <li>Lets you edit and send it — or, if you choose, sends it for you.</li>
        </ul>
        <p>
          The most important promise: it does this <strong>without getting your account flagged or banned</strong> as a
          bot.
        </p>
      </Section>

      <Section title="2. Will it get my account banned?">
        <p>
          Freelance sites ban accounts that <em>behave</em> like robots — sending too fast, at 3 a.m., or the exact same
          message over and over. Auto-Earn is built to behave like a normal human using a normal browser:
        </p>
        <ul className="ml-5 list-disc space-y-1">
          <li>It uses <strong>your real login</strong> in a normal browser window — it never fakes or hides your identity.</li>
          <li>
            A built-in <strong>Behavior Governor</strong> paces everything: a sensible gap between messages, a limit per
            hour, only during the hours you choose, and never two identical messages.
          </li>
          <li>
            In the default mode, <strong>you press Send</strong> — exactly what the site expects.
          </li>
        </ul>
        <Callout>
          <strong>Golden rule:</strong> the safest setting (the default) is <strong>Assisted mode</strong>, where you read
          and click Send yourself. Use it unless you have a strong reason not to.
        </Callout>
      </Section>

      <Section title="3. First-time setup (3 steps)">
        <ol className="ml-5 list-decimal space-y-1">
          <li>
            <strong>Set your timezone</strong> in <strong>Settings → General</strong> (e.g. Asia/Karachi). This makes
            "active hours" follow <em>your</em> clock.
          </li>
          <li>
            <strong>Turn Auto-Earn on</strong> — open <strong>Freelance → Settings</strong>, tick <strong>Enable
            Auto-Earn</strong>, leave the rest at their safe defaults, and click <strong>Save</strong>.
          </li>
          <li>
            <strong>Log in once</strong> — open the new <strong>Inbox</strong> tab, find the <strong>Live session</strong>
            panel at the bottom, click <strong>Log in</strong>, and sign into Freelancer.com. Your login is remembered,
            even after you restart the app.
          </li>
        </ol>
        <p>
          Once you're logged in, your conversations appear in the Inbox and the status shows{" "}
          <strong>"Connected as &lt;your name&gt;"</strong>. Nothing is sent anywhere yet — it's just reading your own
          inbox.
        </p>
      </Section>

      <Section title="4. The two modes — Assisted vs Full-auto">
        <p>
          In Auto-Earn settings you pick a <strong>Default autonomy</strong> (and you can override it per account from the
          Inbox tab):
        </p>
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left">
                <th className="px-2 py-1.5 font-medium"> </th>
                <th className="px-2 py-1.5 font-medium">Assisted (recommended)</th>
                <th className="px-2 py-1.5 font-medium">Full-auto</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Drafting replies", "When you ask", "Automatic, on each new client message"],
                ["Sending replies", "You click Approve & Send", "Sent automatically (paced)"],
                ["Doing the work (clone / build)", "—", "AI agent does it autonomously"],
                ["Placing a bid", "You click Place Bid", "You click Place Bid (same)"],
                ["Delivering finished work", "You", "AI prepares + reviews, then you approve"],
                ["Sensitive messages (money/contracts/off-platform/disputes)", "You handle them", "Escalated to you — never auto-answered"],
                ["Runs in the background on any page", "Yes (sync + notifications)", "Yes (sync + notifications + replies + work)"],
                ["Account risk", "Very low", "Higher — needs the risk acknowledgment"],
              ].map((row) => (
                <tr key={row[0]} className="border-b border-border/60 align-top last:border-0">
                  <td className="px-2 py-1.5 font-medium text-foreground">{row[0]}</td>
                  <td className="px-2 py-1.5">{row[1]}</td>
                  <td className="px-2 py-1.5">{row[2]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Callout tone="warn">
          <strong>Money actions always need you — in both modes.</strong> The app never clicks{" "}
          <strong>Place Bid</strong> for you, and never delivers finished work without your approval. Full-auto cannot be
          switched on until you tick the <strong>Full-auto risk acknowledgment</strong>. Start with Assisted; move to
          Full-auto only once you trust the drafts.
        </Callout>
      </Section>

      <Section title="5. Replying to a client">
        <ol className="ml-5 list-decimal space-y-1">
          <li>In the <strong>Inbox</strong> tab, click a conversation on the left.</li>
          <li>Click <strong>Draft reply</strong>. The AI writes a draft in the "Drafts &amp; queue" box.</li>
          <li>Read and edit it — it's a normal text box.</li>
          <li>Click <strong>Approve &amp; Send</strong>. The app types it like a person and sends. You'll see "Reply sent."</li>
        </ol>
        <p>Don't like a draft? Click <strong>Reject</strong> and draft a fresh one.</p>
      </Section>

      <Section title="6. Sending a proposal (bid)">
        <p>
          Not sure about a job yet? Click <strong>Chat</strong> on its listing card first. You can ask anything, or use
          the quick starts: <strong>What's this project</strong> (a plain-language explanation),{" "}
          <strong>Should we bid?</strong> (a clear BID/SKIP verdict based only on whether the AI agents can build
          everything the client asked for — things you'll handle anyway, like communication, credentials, and
          deployment, never count against a job), <strong>Create Project Timelines</strong>, and{" "}
          <strong>How would we build it?</strong> (tech stack and task plan).
        </p>
        <ol className="ml-5 list-decimal space-y-1">
          <li>Go to the <strong>Listings</strong> tab and shortlist a job you like.</li>
          <li>On a <strong>shortlisted</strong> job, click <strong>Create Proposal</strong>. The app jumps to your Inbox Drafts.</li>
          <li>Edit the proposal, then click <strong>Approve &amp; Send</strong>.</li>
          <li>The app opens the job's bid page and fills in the <strong>amount</strong>, <strong>delivery days</strong>, and your <strong>proposal</strong>.</li>
          <li><strong>You click Place Bid.</strong> Check the amount first — the app stops and waits for you.</li>
        </ol>
        <Callout>
          The bid amount comes from the job's budget using your <strong>Bid pricing</strong> settings (average of the
          range by default — switch to min/max/percentile, set a floor/ceiling, or a fixed hourly rate). Turn on{" "}
          <strong>Auto-draft proposals for shortlisted listings</strong> to have proposals written for you automatically
          (you still place the bid).
        </Callout>
        <p>
          Proposals (and the Chat) are written from the job's <strong>full description</strong>, not the short preview on
          the card. The first time you use either on a job, the app fetches the job page itself — that can add a few
          seconds — then remembers it, so it's instant afterwards.
        </p>
      </Section>

      <Section title="7. The Auto-Earn dashboard & alerts">
        <p>The <strong>Dashboard</strong> sub-tab is your control room:</p>
        <ul className="ml-5 list-disc space-y-1">
          <li><strong>Metrics</strong> — bids sent, jobs won, delivered, earned, plus your win-rate and average response time.</li>
          <li>
            <strong>Needs attention</strong> — alerts the AI raises. Each reaches you by desktop notification (and your
            connected channels, if enabled). You'll see things like:
            <ul className="ml-5 mt-1 list-disc space-y-1">
              <li><strong>"Ready to deliver — approve"</strong> → click <strong>Approve delivery</strong> and it delivers for you. (It cannot hand over work until you approve.)</li>
              <li>A <strong>sensitive message</strong> (money/contract/off-platform/dispute) handed to you instead of auto-answered.</li>
              <li><strong>"Queue is stuck"</strong> → in Full-auto, nothing has sent for a few hours (usually logged out, outside active hours, or paused).</li>
            </ul>
          </li>
          <li><strong>Jobs</strong> — every opportunity and its stage, with a step-by-step timeline.</li>
        </ul>
      </Section>

      <Section title="8. The settings, in plain words">
        <ul className="ml-5 list-disc space-y-1">
          <li><strong>Default autonomy</strong> — Assisted or Full-auto (see section 4).</li>
          <li><strong>Max sends / hour</strong> &amp; <strong>Min gap between sends</strong> — the safety throttle. Lower = safer/slower. Bids are throttled harder.</li>
          <li><strong>Max bids / day</strong> — a hard daily budget for proposals, separate from the hourly limits. Keeps automated bidding well inside your Freelancer membership's bid quota. 0 = no daily cap.</li>
          <li><strong>Active hours</strong> — the part of the day it's allowed to work (uses your timezone).</li>
          <li><strong>Inbox sync min / max interval</strong> — how often the inbox refreshes itself. The app picks a random time between the two, so the rhythm looks human instead of clockwork.</li>
          <li><strong>Notifications</strong> — desktop popup and/or your connected channels when a client messages.</li>
          <li><strong>Bid pricing / floor / ceiling / hourly rate</strong> — how the bid amount is chosen.</li>
          <li><strong>Default delivery days</strong> — the timeframe prefilled on bids (auto-detected from the job text when it states one).</li>
          <li><strong>Auto-dismiss stale bids</strong> — drops a filled-but-unplaced bid after N hours (the job's usually taken by then).</li>
          <li><strong>Auto-draft proposals for shortlisted listings</strong> — write proposals for promising jobs automatically.</li>
          <li><strong>Client quality filters</strong> — skip jobs from risky clients before any AI analysis runs: block clients with fewer than N reviews, or accounts younger than N days. If the client's info can't be read from the page, the job is <em>not</em> blocked (fail-open).</li>
        </ul>
        <p>
          In the Inbox you'll also see a <strong>Pause…</strong> control (1/3/8/24h) — it stops all sending and the AI
          agent while keeping your inbox syncing — and a small line showing how many sends you've used this hour.
        </p>
      </Section>

      <Section title="9. Staying safe — quick tips">
        <ul className="ml-5 list-disc space-y-1">
          <li>Keep <strong>Assisted mode</strong> unless you accept Full-auto's risk.</li>
          <li>Set realistic <strong>active hours</strong> (your normal day), not 24/7.</li>
          <li><strong>Read every draft</strong> before sending — never send a price or promise you can't keep.</li>
          <li>Let the <strong>Governor pace you</strong>; don't rush past "held" messages.</li>
          <li>If you use Full-auto, check the <strong>Needs attention</strong> list daily.</li>
          <li>Don't run Full-auto on an account you can't afford to lose.</li>
        </ul>
      </Section>

      <Section title="10. Questions & answers">
        <div className="space-y-2">
          <Faq q="Does AgentDesk see my password?">
            No. You log in inside a browser window like any website. AgentDesk only keeps the site's normal "you're logged
            in" cookie — the same as your everyday browser.
          </Faq>
          <Faq q="Will this get my account banned?">
            Used in Assisted mode with sensible settings, the risk is very low — you're doing exactly what the site expects
            (a human clicking Send). Full-auto carries real risk, which is why it's off by default and behind a warning.
          </Faq>
          <Faq q="Do I have to keep the app open? Do I have to stay on the Inbox tab?">
            Keep AgentDesk open, yes. But you do <strong>not</strong> need to stay on the Inbox tab — once Auto-Earn is on,
            syncing, notifications, and (in Full-auto) replies keep running on any page. Closing the app pauses everything.
            First-time login still happens in the Inbox tab.
          </Faq>
          <Faq q="Does it bid on jobs by itself?">
            Not on brand-new listings — you start a bid by clicking <strong>Create Proposal</strong> (or turn on
            "Auto-draft proposals for shortlisted listings"). And you always click <strong>Place Bid</strong> yourself,
            in both modes.
          </Faq>
          <Faq q="In Full-auto, will it deliver work to clients on its own?">
            No. It prepares and quality-checks the work, then asks you to <strong>Approve delivery</strong>. It cannot
            upload or hand over the work until you approve.
          </Faq>
          <Faq q="What happens to a message about money, a contract, or moving off-platform?">
            In Full-auto these are <strong>never auto-answered</strong> — they're handed to you in "Needs attention" so you
            decide.
          </Faq>
          <Faq q="A send said 'Held by governor' — is something broken?">
            No — that's the safety system pacing you (min gap or hourly cap). Wait a bit and try again; your draft is still
            there.
          </Faq>
          <Faq q="It logged me out. What do I do?">
            Open the <strong>Live session</strong> panel in the Inbox and click <strong>Log in</strong> again. Sites log
            you out periodically; the app never tries to solve a login or CAPTCHA for you.
          </Faq>
          <Faq q="How do I stop everything?">
            Use <strong>Pause…</strong> for a break, the <strong>Kill-switch</strong> to clear the queue, or untick
            <strong> Enable Auto-Earn</strong> in Settings to switch it all off. Your data stays put.
          </Faq>
          <Faq q="Which sites work?">Freelancer.com today. More platforms may be added later.</Faq>
        </div>
      </Section>
    </div>
  );
}
