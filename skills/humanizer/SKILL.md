---
name: humanizer
description: Remove AI writing patterns and make text sound natural and human-written. Use whenever editing or reviewing any text that will be read by a real person — emails, messages, docs, proposals, reports. Fixes em-dash overuse, AI vocabulary, sycophancy, passive voice, filler phrases, and special Unicode characters.
---

# Humanizer: Remove AI Writing Patterns

When given text to write or review, eliminate AI-generated patterns so the result sounds like it was written by a real person. This is based on Wikipedia's "Signs of AI writing" guide.

## Your Process

1. Scan the text for the patterns listed below.
2. Rewrite offending sentences — do not delete content. Keep the same coverage and length.
3. Preserve the meaning and intended tone (formal, casual, technical).
4. Run the self-check at the bottom before outputting the final version.

---

## LANGUAGE PATTERNS

**1. No AI vocabulary.**
Never use: utilize, leverage, delve, seamlessly, groundbreaking, revolutionize, comprehensive, robust, streamline, synergy, paradigm shift, cutting-edge, game-changing, facilitate, testament, landscape, boasts, showcases, underscores, pivotal, vibrant, thriving, foster, spearhead, embark, unleash, unlock, furthermore, additionally, notably, crucially, intricate, tapestry, interplay, garner, align with, enhance, enduring, valuable, impactful.

**2. No copula avoidance.**
Write "is" and "has". Not "serves as", "boasts", "stands as", "marks", "represents".

**3. No negative parallelisms.**
"It's not just X, it's Y" — just say Y.

**4. No forced rule of three.**
Use as many items as the content needs.

**5. No synonym cycling.**
Use the clearest word every time, even if it repeats.

**6. Active voice.**
Name the actor. "I built X" not "X was built".

---

## STYLE PATTERNS — CRITICAL

**7. No em dashes or en dashes. Hard constraint.**
Zero `—` or `–` in the final output — including ` — `, ` – `, and `--` used as dashes. Replace each one with: a comma (tight aside), a period (start a new sentence), a colon (introducing an explanation), or parentheses (a true aside). Before outputting, scan for `—` and `–`. Any hit means the draft is not finished.

**8. Plain ASCII punctuation only.**
No smart/curly quotes (`'` `'` `"` `"`), no Unicode bullets (`•`), no arrows (`→`), no middle dots (`·`), no special symbols. Use straight apostrophes and straight quotes only. Characters outside basic ASCII punctuation can render as garbage in some clients.

**9. No unnecessary bold.**
Only bold what a real plain-text message would emphasize.

**10. No inline-header lists.**
Not "**Reliability:** I deliver on time". Write prose instead.

**11. Sentence case headings. No emojis.**

**12. No persuasive authority tropes.**
Not "As a seasoned professional..." or "With years of experience...".

**13. No signposting.**
Not "Let's dive in", "Here's what I found", "Let me walk you through", "In this section".

---

## CONTENT PATTERNS

**14. No significance inflation.**
Not "a pivotal moment", "a game-changing opportunity". State the actual fact.

**15. No vague attributions.**
Not "experts say", "studies show". Be specific or drop it.

**16. No hollow -ing analysis.**
Not "showcasing their expertise", "highlighting its potential". Say the actual thing.

**17. No promotional fluff.**
Not "breathtaking", "innovative", "passionate", "dedicated", "vibrant", "stunning".

**18. No formulaic challenge framing.**
Not "Despite challenges, X continues to thrive". Just say what happened.

---

## COMMUNICATION PATTERNS

**19. No chatbot artifacts.**
Not "I hope this helps!", "Happy to assist!", "Feel free to ask", "Let me know if you need anything else", "Please don't hesitate to reach out", "Is there anything else I can help you with?".

**20. No sycophancy.**
Not "Great question!", "That's a really interesting challenge", "What a fascinating topic!".

**21. No hedge disclaimers.**
No knowledge-cutoff caveats, no "I may be wrong but...", no excessive qualifications.

---

## FILLER

**22. No filler.**
"To" not "In order to". "Because" not "Due to the fact that". "If" not "In the event that". "Now" not "At this point in time".

**23. One qualifier is enough.**
No stacking: not "very clearly quite important".

**24. Specific endings.**
End with a fact, number, question, or next step. Not "Overall, this looks promising."

---

## VOICE

- Use contractions (don't, can't, I'll, it's, we're). They are normal in human writing.
- Mix sentence lengths. Short ones. Then longer ones that develop a point with more detail.
- Have opinions when the content calls for it. Neutral reporting every time is also a tell.

---

## SELF-CHECK BEFORE OUTPUTTING

Scan the final text for:
- `—` or `–` character (must be zero)
- Curly/smart quote characters `'` `'` `"` `"` (must be zero)
- Unicode bullet `•` or any non-ASCII punctuation (must be zero)
- Any word from the AI vocabulary list in rule 1
- Any chatbot artifact phrase from rule 19
- Any sycophantic opener from rule 20

If any check fails, rewrite the offending sentence before outputting.
