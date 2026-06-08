# Auto-Earn — Simple User Guide

A friendly, step-by-step guide to the **Auto-Earn** feature. No technical knowledge needed.

---

## 1. What is Auto-Earn? (in plain words)

Auto-Earn brings your freelance **inbox right into AgentDesk** and uses AI to help
you **reply to clients and send proposals (bids)** — so you can win and keep work
with much less effort.

Think of it as a smart assistant that:

1. **Reads your messages** from the freelance website (e.g. Freelancer.com) and
   shows them inside AgentDesk.
2. **Writes a draft reply or proposal** for you using AI.
3. **Lets you edit it and send it** — or, if you choose, sends it for you.

The most important promise: it does all this **without getting your account
flagged or banned** as a bot. (More on how, below.)

---

## 2. How it stays safe (why you won't get banned)

Freelance sites ban accounts that *behave* like robots — sending messages too
fast, at 3 a.m., or sending the exact same text over and over. Auto-Earn is built
to behave like a **normal human using a normal browser**:

- It uses **your real login** inside a normal browser window. It does **not** fake
  or hide your identity. (Faking your identity is actually what gets accounts
  flagged.)
- A built-in **"Behavior Governor"** paces everything: it waits a sensible gap
  between messages, limits how many you send per hour, only works during the hours
  you choose, and never sends two identical messages.
- **You stay in control of the "Send" button** (in the default mode). The app
  writes the message; *you* press send — exactly like the site expects.

> **One golden rule:** the safest setting (the default) is **Assisted mode**,
> where you read and click Send yourself. Use it unless you have a strong reason
> not to.

---

## 3. Before you start (what you need)

- An account on a supported freelance site. **Freelancer.com** works today.
- Your normal login (email + password) for that site. You'll type it **once**,
  inside AgentDesk, the same as logging in on any website.
- An AI provider already set up in AgentDesk (the same one the rest of the app
  uses). If you've used the app's chat before, you're good.

You do **not** need any API keys from the freelance site, and you do **not** give
AgentDesk your password — you simply log in in a browser window, like normal.

---

## 4. Step-by-step: first-time setup

### Step 1 — Set your timezone (important!)

Go to **Settings → General** and set your **Timezone** (for example
`Asia/Karachi`). This makes the "active hours" work on *your* clock. If you skip
this, the app uses **UTC**, and "9 to 22" might not match your real day.

### Step 2 — Turn Auto-Earn on

1. Open the **Freelance** page.
2. Click the **Settings** tab.
3. Scroll to the bottom — the **Auto-Earn** section is last.
4. Tick **"Enable Auto-Earn (master switch)"**.
5. Leave the other settings at their defaults for now (they're already safe).
   Each field has a small **?** icon — hover it to see what it does.
6. Click the **Save** button at the very bottom. (This one Save button saves
   everything on the page, including Auto-Earn.)

A new **Inbox** tab now appears on the Freelance page.

### Step 3 — Open the Inbox and log in

1. Click the new **Inbox** tab.
2. At the bottom you'll see a **"Live session"** panel — this is a real browser
   window inside the app.
3. Click **Log in** in that panel and sign into Freelancer.com **once**. Your
   login is remembered, even after you restart the app.
4. Click **Open Inbox**, then click into one of your conversations.

As you do this, the top of the page fills in: a **list of your conversations** on
the left, and the **selected conversation** on the right. The status pill near the
top should say **"Connected as <your name>"**.

> **What's happening behind the scenes:** the app is quietly reading the same
> messages the website shows you, and saving them so it can display and work with
> them. Nothing is sent anywhere — it's just reading your own inbox.

---

## 5. Step-by-step: replying to a client

1. In the **Inbox** tab, click a conversation on the left to open it.
2. Read the messages (yours appear on the right, the client's on the left).
3. Click **"Draft reply"** (top-right of the conversation).
4. The AI writes a draft. It appears in a **"Drafts & queue"** box that shows up on
   the page.
5. **Read and edit** the draft — it's a normal text box, change anything you like.
6. When you're happy, click **"Approve & Send"**.
7. The app switches the live session to that conversation, **types your message
   like a person**, and clicks Send. You'll see **"Reply sent."**

That's it. The message now appears in the real conversation, and the client sees a
normal message from you.

> Don't like a draft? Click **Reject** to throw it away, then **Draft reply**
> again for a fresh one.

---

## 6. Step-by-step: sending a proposal (bid) on a job

1. Go to the **Listings** tab (the jobs the app found for you).
2. On a **shortlisted** job, click **"Create Proposal"**. (The button only shows on
   shortlisted listings — shortlist a job first if you don't see it.)
3. You'll get a toast and the app jumps to the **Inbox** tab, where your proposal is
   waiting in the **Drafts & queue** box.
4. **Edit** the proposal text if you like, then click **Approve & Send**.
5. The app opens that job's bid page in the live session and **fills in the bid form
   for you** — the **bid amount**, **delivery days**, and your **proposal**.
6. **You place the bid.** The app stops there and shows *"Bid filled — review it and
   click Place Bid"* (plus a desktop notification). Check the amount, then click
   **Place Bid** yourself in the live session.

> **Bids always need your click — in both modes.** Because a bid commits real money
> and terms, the app **never** presses **Place Bid** for you. Even in Full-auto it
> fills everything in and waits for you. The amount comes from the job's budget (the
> middle of the range, or the single amount); if the job lists no budget, the amount
> is left **blank** for you to type. The default delivery days can be changed in
> Auto-Earn settings.

Bids are paced more carefully than replies (spaced out more), because a flood of
proposals is the biggest "bot" red flag.

---

## 7. The two modes: Assisted vs Full-auto

In **Auto-Earn settings** you choose a **Default autonomy** (and you can set it per
account from the Inbox tab):

### Assisted (recommended, default)
- AI **drafts** → **you edit** → **you click Send**.
- Safest by far. The site sees a normal human pressing Send.
- Use this unless you really know what you're doing.

### Full-auto (advanced, opt-in) — the AI runs the whole job
In Full-auto a built-in **Freelance Expert** AI agent takes over the entire
pipeline, hands-off, paced by the Governor:
- **Replies** to clients on its own, and (when a job is in play) **fills in bids**
  for you — but **you still click Place Bid** (it never commits money for you). Note
  it does **not** go hunting and bidding on brand-new listings by itself today — you
  start a bid by clicking **Create Proposal** on a shortlisted job.
- When you **win** a job, it **creates the project**, gathers the requirements,
  and sets up access — if the client shares a **git repo or FTP/SFTP login**, it
  stores those securely (encrypted) and **downloads the files** to work on.
- It **builds the work**, runs an **automatic quality review**, then **delivers**
  (pushes to their repo / uploads the files) and confirms in the chat.
- If it ever gets **stuck or hits something it must not do** (a contract to sign,
  a payment, a phone call, an off-platform request, or anything unclear) it
  **stops and alerts you** instead of guessing.

Because the app is now pressing Send and acting for you, this crosses the site's
"no automation" line and carries **real account risk**. It **cannot be turned on**
until you tick the **"Full-auto risk acknowledgment"** checkbox — on purpose.

> **Honest advice:** start with Assisted. Only move to Full-auto once you trust the
> drafts, and keep an eye on the **Auto-Earn** tab (below) — especially the
> **Needs attention** list. Two things still need you in the loop today: pressing
> the platform's formal "deliver/milestone" button, and anything the agent
> escalates.

---

## 7b. The Auto-Earn dashboard (your control room)

When Auto-Earn is on, a new **Auto-Earn** tab appears on the Freelance page. It
shows you, at a glance, what the AI is doing on your behalf:

- **Metrics** — bids sent, jobs won, projects delivered, money earned, and how
  many alerts are waiting.
- **Needs attention** — anything the agent got stuck on or refused to do (with the
  reason). Read it, sort it out, and click **Resolve** so the agent can carry on.
  These also reach you by desktop notification (and channels, if enabled).
- **Jobs** — every opportunity and its current stage (lead → negotiating →
  awarded → in progress → delivered → complete). Click a job to see a **timeline**
  of exactly what the agent did, step by step.

This is the screen to glance at once a day if you're running Full-auto.

---

## 8. What to expect (so nothing surprises you)

- **It's not instant, and that's good.** The app waits between sends on purpose
  (the "min gap"), only works during your "active hours", and refreshes your inbox
  at random-ish intervals. Slow and steady is what keeps your account safe.
- **Sometimes a send is held back.** If you click Approve & Send and see a message
  like *"Held by governor: min gap not elapsed"* or *"hourly cap reached"*, that's
  the safety system doing its job. Wait a bit and try again — the draft is still
  there.
- **Background syncing is quiet — and works on any page.** Once Auto-Earn is on,
  the inbox refreshes itself, notifications fire, and (in Full-auto) replies are
  sent **even when you're on a different page** of AgentDesk — just like the
  auto-shortlist feature. You do **not** have to sit on the Inbox tab. (It starts a
  few seconds after the app launches so it never slows startup.)
- **You can stop everything instantly.** The **Kill-switch** button in the Drafts
  box halts anything queued or in progress. To stop the whole thing, untick the
  **Enable Auto-Earn** master switch in Settings and Save.
- **In Full-auto, the AI works quietly in the background** while the app is open —
  on **any page**, reading messages, replying, building, delivering. You don't drive
  it; you **supervise** it from the **Auto-Earn** tab and clear anything in **Needs
  attention**.
- **It will stop and ask you** rather than do something risky. Signing anything,
  any money/payment step, phone/video calls, moving off the platform, or unclear
  requirements all become a **Needs attention** alert — the agent never decides
  these for you.

### Getting notified of new client messages

In **Auto-Earn settings** there are two notification options:

- **Desktop notification on new client reply** (on by default): pops a normal
  desktop/Windows notification when a client sends you a new message, so you don't
  have to keep watching the Inbox. Untick it to stay silent.
- **Notify on channels** (off by default): also forwards new client messages to
  any channels you've connected (Discord, WhatsApp, email, etc.) under the main
  **Settings → Channels**. Handy if you want pings on your phone.

> Notifications only fire for **genuinely new** messages **from the client** — not
> for your own replies, and not for old history when you first connect.

---

## 9. When something goes wrong — what to do

| You see… | What it means | What to do |
|---|---|---|
| **"Not connected" / a logged-out banner** | Your session ended (sites log you out periodically). | Open the **Live session** panel and click **Log in** again. |
| A **login or verification (CAPTCHA) page** | The site wants to confirm it's really you. | Solve it yourself in the **Live session** panel. The app will **never** try to solve it for you. |
| **"Held by governor: …"** | The safety system is pacing your sends. | Just wait — try again in a few minutes. Nothing is broken. |
| **"Send timed out"** | The message box on the page didn't load in time. | Make sure the conversation is open in the Live session, then try Approve & Send again. |
| **Inbox stays empty after syncing** while logged in | The website may have changed its layout. | Click **Sync now**. If it's still empty, let us know so we can re-tune it. |
| A **"Needs attention" alert** (Auto-Earn tab + desktop) | In Full-auto, the AI got stuck or hit something it must not do on its own. | Read the reason, handle it (answer the client, fix access, etc.), then click **Resolve** so the agent continues. |
| A job sits at **"delivered"** but the client hasn't been paid/closed | The AI delivered the files and messaged the client, but pressing the platform's formal **deliver/milestone** button is still your step today. | Open the job on the platform and confirm the milestone yourself. |

---

## 10. Quick safety checklist (best practices)

- ✅ Keep **Assisted mode** unless you accept the risk of Full-auto.
- ✅ Set realistic **active hours** (your normal working day), not 24/7.
- ✅ **Read every draft** before sending — the AI is good, not perfect. Never send
  a price or promise you can't keep.
- ✅ Let the **Governor pace you**. Don't try to rush past "held" messages.
- ✅ **Edit** drafts so your replies vary naturally — the app already blocks
  sending the *exact* same text twice, but personal touches help.
- ✅ **If Full-auto, check the Auto-Earn tab daily** and clear **Needs attention**
  promptly — that's where the AI asks for your help.
- ❌ Don't run it on an account you can't afford to lose if you're using Full-auto.

---

## 11. Frequently asked questions

**Does AgentDesk see my password?**
No. You log in inside a browser window exactly like any website. AgentDesk only
keeps the site's normal "you're logged in" cookie, the same as your everyday
browser.

**Will this get my account banned?**
Used in **Assisted mode** with sensible settings, the risk is very low — you're
doing exactly what the site expects (a human clicking Send). **Full-auto** carries
real risk, which is why it's off by default and behind a warning.

**Do I have to keep the app open? Do I have to stay on the Inbox tab?**
Keep **AgentDesk** open — yes. But you **no longer need to stay on the Inbox tab**:
once Auto-Earn is on, the inbox sync, notifications, and (in Full-auto) replies keep
running in the background on **any page**, like the auto-shortlist feature. Closing
the app pauses everything. (First-time **login** still happens in the Inbox tab's
Live session.)

**Can I turn it off?**
Yes. Untick **Enable Auto-Earn** in Freelance → Settings and click **Save**. The
Inbox tab disappears and all background activity stops. Your data stays put.

**Which sites work?**
**Freelancer.com** today. More platforms may be added later.

---

*Need help or something looks off? Note exactly what you clicked and what message
you saw, and share it — that's usually enough to sort it out quickly.*
