# Human Testing — Post AI-SDK-v7-Migration Validation

> Companion to [`ai-sdk-7-migration-tasks.md`](./ai-sdk-7-migration-tasks.md) and
> [`ai-testing-after-skd-migration.md`](./ai-testing-after-skd-migration.md) (my
> own checklist). Everything here genuinely requires you, for one of these
> reasons:
>
> - **Credentials** — I'm not able to enter API keys/passwords/tokens into any
>   field, regardless of who supplies the value. That's a hard boundary, not a
>   preference.
> - **Real external accounts/data** — your live Freelancer profile, real
>   GitHub issues/PRs. An automated dry run here risks a real-world side
>   effect on something you didn't ask to be touched.
> - **Subjective judgment** — a couple of items are genuinely "does this look
>   right to you," which no script or DOM check can answer for you.
>
> Each section below has: why it needs you, prerequisites, numbered steps,
> and the expected result(s) to confirm against. If a step's result doesn't
> match, note what you actually saw — that's useful signal either way.

---

## 1. Add real provider credentials (unlocks 8 connectivity checks + reasoning-extraction checks)

**Why this needs you**: entering an API key into a form field is something I'm
not able to do under any circumstances.

**Applies to**: Anthropic, OpenAI, Google Gemini, DeepSeek, Groq, xAI Grok,
OpenRouter (all need a real key from that provider's own dashboard first —
skip any you don't have/want an account for). Ollama is separate, see §2.

**Steps** (repeat per provider):

1. Open AgentDesk → **Settings** (gear icon) → **AI** tab → **Providers** sub-tab.
2. Click **Add Provider**.
3. **Name**: anything recognizable, e.g. "My Anthropic Account".
4. **Provider Type**: select the matching option from the dropdown (Anthropic / OpenAI / Google Gemini / DeepSeek / Groq / OpenRouter / xAI Grok).
5. **API Key**: paste your real key from that provider's dashboard (starts with `sk-...` for most).
6. **Default Model**: leave blank to use the model list once it loads, or type/select a specific one (e.g. `claude-opus-4-8` for Anthropic, `gpt-5` for OpenAI — whatever you actually want tested).
7. Leave **"Set as default provider"** unchecked, unless you want to actually switch your default (optional — testing connectivity doesn't require it).
8. Click **Test Connection** (amber button, bottom-left of the dialog).
   - **Expected result**: a green toast reading **"Connection is working."** within a few seconds.
   - If it fails: a red toast reading **"Connection failed: <reason>"** — note the reason (invalid key, network error, etc.).
9. Click **Add Provider** to save it (or **Cancel** if you were just testing and don't want to keep it).
   - **Expected result**: a green toast reading **"Provider added."**, dialog closes, a new card for this provider appears in the Providers list.

**Repeat for each provider you want validated.** You don't need all 7 — even
one or two gives real, credentialed coverage beyond what I could verify with
the free/subscription providers already configured.

---

## 2. Set up Ollama (local, optional)

**Why this needs you**: installing new software and running a local service
is something I should not do without being explicitly asked to, given it's a
system-level change outside the project itself.

**Steps**:

1. Install Ollama from [ollama.com](https://ollama.com) if not already installed.
2. In a terminal, run: `ollama pull llama3.1` (or any model you prefer) and confirm it downloads.
3. Confirm Ollama is running: `ollama list` should show the model you just pulled.
4. In AgentDesk: **Settings → AI → Providers → Add Provider**.
5. **Name**: "Local Ollama".
6. **Provider Type**: select **Ollama**.
7. **API Key**: Ollama doesn't check this, but the form requires *something* typed in — enter any placeholder text, e.g. `not-needed`.
8. **Base URL**: `http://localhost:11434/v1` (Ollama's default OpenAI-compatible endpoint).
9. **Default Model**: type the exact model name you pulled, e.g. `llama3.1`.
10. Click **Test Connection**.
    - **Expected result**: green toast **"Connection is working."**
11. Click **Add Provider** to save.

If you'd rather I did the install myself, just say so explicitly and I can —
I'm just not defaulting to it unprompted.

---

## 3. Freelance chat & Freelance wizard

**Why this needs you**: this touches your real Freelancer.com account and
real project data — not something to dry-run with synthetic input.

**Steps — Freelance chat**:

1. Open AgentDesk → navigate to a project with the Freelance feature configured (or set one up if you haven't).
2. Open the Freelance chat surface and send a message relevant to your actual freelance work (e.g. ask about a real listed project or draft a real bid).
3. Confirm the response streams in normally and reflects real data from your account (not stale/cached/wrong data).

**Expected result**: response streams without error; any data referenced
(projects, bids, messages) matches what you see on Freelancer.com directly.

**Steps — Freelance wizard**:

1. Open the Freelance wizard flow (project setup / bid-pipeline configuration, wherever it lives in your current workflow).
2. Walk through it with real inputs for a project you actually intend to work on (or a throwaway test one, your call).
3. Confirm each step's output looks sane before advancing (skill matching, generated description/bid draft, etc.).

**Expected result**: no step throws an unhandled error; generated content
(descriptions, bid drafts) is coherent and relevant to what you entered.

---

## 4. Council

**Why this needs you**: you specifically asked to test this one yourself
rather than have it automated.

**Steps**:

1. Open the Council feature for a project.
2. Start a session with a real question you want a multi-agent decision on.
3. Watch it run through its rounds (agent selection → round-start → convergence → final answer).

**Expected result**: multiple agents respond across at least one round; a
final synthesized answer is produced; no session-ending error (watch for
anything like "No AI provider configured" or "No agents responded
successfully" — if you see either, it means the providers Council picked
aren't actually reachable, which is itself useful to know).

---

## 5. Issue Fixer — one dry-run cycle

**Why this needs you**: this operates against a real GitHub repo's real
issues, and while the tool set is designed to never merge or force-push, a
live dry run against your actual repo is something you should watch happen
rather than have run unattended.

**Steps**:

1. Open the Issue Fixer feature for a project connected to a real GitHub repo you're comfortable testing against.
2. Trigger (or wait for) one poll → trigger → fix → PR cycle on a real, ideally low-stakes issue.
3. Watch the agent's tool calls as it works — confirm it never calls `git merge`, `git push --force`, or anything destructive.
4. Once it opens a PR, check the PR on GitHub directly.

**Expected result**: a real PR is opened against the issue, containing a
plausible fix; no direct push to a protected branch; no merge attempted by
the agent itself (that decision stays with you); `git_pr`/`git_push` calls
(if any) go through the normal PR-creation path, not a direct push to
`main`.

---

## 6. Optional — subjective visual/quality spot-checks

These aren't blockers (I can verify the *plumbing* works — request succeeds,
image data is well-formed, tool result persists correctly), but only you can
judge whether the actual output is good enough to trust:

- **Generated images** (`generate_image` in chat): do the images actually
  look reasonable for what you asked for, not just "technically an image"?
- **Reasoning-effort depth**: with the reasoning-effort selector set to
  "High" vs. "Low" on a provider that supports it, does the visible
  thinking/reasoning text actually look meaningfully deeper on "High"?

Skip these if you're not concerned about output quality specifically — they're
optional polish checks, not correctness checks.

---

## Result log

Note what you actually found here as you go — useful even (especially) when
something doesn't match the expected result:

- *(none yet — this document was just created)*
