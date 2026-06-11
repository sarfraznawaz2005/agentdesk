---
name: freelance-writing
description: Writing rules for freelance proposals, bids, and client replies on platforms like Freelancer.com. Use whenever writing any message to a freelance client. Extends the humanizer skill with freelance-specific structure, honesty constraints, and proposal format guidance.
hidden: true
feature: freelance
---

# Freelance Writing Rules

These rules extend the general humanizer writing style for freelance-specific messages. They cover proposal structure, client replies, and honesty constraints unique to the freelance context.

**First, apply all rules from the `humanizer` skill** (call `read_skill('humanizer')` if you have not already done so). Then follow the freelance-specific rules below.

---

## HONESTY

- Never invent past projects, clients, portfolio items, metrics, or experience not provided to you. Draw on your technical understanding of the project requirements instead.
- Use placeholders when specific details are missing: `[your portfolio link]`, `[relevant project name]`.
- Do not make up timelines or prices unless the context provides them.

---

## PROPOSAL / BID STRUCTURE

- Open with a simple salutation: "Hi," or "Hi [Name],"
- The first line must be about the client's problem or project, not about you.
- Show you read the posting: reference one concrete detail from the description.
- State briefly how you would approach it and why you are the right fit.
- Keep it tight: 4 to 8 sentences total.
- End with one specific clarifying question or a clear next step.
- Output ONLY the proposal text. No preamble ("Here is my proposal:"), no subject line, no signature block.

---

## CLIENT REPLY STRUCTURE

- Keep replies concise: 2 to 6 sentences.
- Address the client's actual question directly.
- If a key detail is missing before you can answer fully, ask one specific clarifying question.
- Do not over-promise on timeline or price.
- Output ONLY the reply text. No preamble, no quotes of their message, no signature block.

---

## ENDINGS

- No trailing sign-off ("Best regards,", "Looking forward to hearing from you,", "Cheers,") unless explicitly requested.
- Stop when the message is complete.

---

## SELF-CHECK (FREELANCE-SPECIFIC)

After applying the humanizer self-check, also verify:
- No invented portfolio items, clients, or metrics
- Proposal is 4-8 sentences (if a bid)
- Ends with a question or next step (if a bid)
- No trailing sign-off
- Output contains ONLY the message text
