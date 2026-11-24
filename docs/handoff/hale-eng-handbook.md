---
name: Hale eng handbook
description: >-
  Use when shipping code, opening PRs, merging, changing /text or SMS, or
  deciding whether Eng can act during a ship freeze or planning against
  Linear/GitHub.
---
# Hale eng handbook

Shared rules for any bot touching Hale engineering (code, PRs, deploys, SMS/env).

## Goal (Barton 2026-11-18, goal-first)
Dec 1 launches with every feature working and no parent ever seeing a broken message.
Before taking over a new kind of work, restate the goal and the process in plain words to Barton for his correction.

## How Barton judges
- His rules: no fixed or template parent copy (the OTP is the only exception), no STOP/HELP, no regex or word-list intent detection, no char caps, Linq only, new behavior behind default-off flags, economical evals, every red-team finding is launch-blocking, and promo flags and ads stay off until his explicit go.
- Which source wins on conflict: Barton's own words, newest first, beat relays. Relays beat this handbook, and the handbook beats agent memory. Linear records the decision.
- When to ask him: money and spend, new outbound channels, flipping promo or ads, scope or date changes, logins and phone checks only he can do, and anything irreversible in Prod. Everything else, decide and proceed, then report at milestones.
- Feedback sources: eval results, PostHog Prod errors, real conversation records, and CI or revert history. Run a weekly self-review (Mondays) that proposes improvements for Barton's approval, and use routines and triggers so he isn't the bottleneck.

## Approvals
1. Eng admin-merges a PR once lint, typecheck, build and the touched tests pass on a head that contains current main. Full CI and review don't block a merge, but a red main blocks every merge (see Merging).
2. Still no merge, deploy, env write, or outbound send for classes outside Barton's standing clears unless Barton cleared that class. Hale's channel is Linq only; never add or use a Twilio send.
3. Never treat room agreement alone as a ship clear. Only Barton's own words approve (relays must quote him).
4. Outward email/social still goes through Barton (or Yuki routing → Barton clear).
5. Autonomy from blast radius: migrations, deploys, prod data, outbound sends, and secrets always keep a human gate.
6. If Hale #1 SMS changes, `/text` preview greeting must stay **byte-matched** to it. Warm door prefill energy stays; never ship a page showing the old greet.

## Merging
1. One merge at a time. Before `gh pr merge --admin`, run `scripts/ci/merge-ready.mjs <pr>`: the head must contain current main (not BEHIND/DIRTY) and main's latest CI must be green. If the head is behind, update it and let the touched tests pass on the new head.
2. After each merge, wait for main's CI and the Prod deploy before the next merge. If main goes red, stop merging; the fix PR names which merge caused each failure.
3. No integration or "batch" branches that collect many PRs. Each PR lands on its own. PRs that must land together are ordinary PRs based on each other's branches, merged in order.
4. Never use GitHub native stacked PRs (`stack_on`). gh and REST can't merge them and their base can't change. Tell every cloud agent this in its brief.
5. No auto-merge tasks or "merge when green" timers. Every merge is one deliberate command.

## Migrations and shared lists
1. A migration's number is chosen at merge time, not at branch time. Right before merging, rebase on main and run `pnpm db:next-migration`; rename the file and set `when` greater than main's last entry. Never reuse a number.
2. Files that every PR of a kind must touch (the migration journal, `.skills-lock.json`, `AUDIT_VERBS`, the retention and door lists) are regenerated or re-checked after the final rebase, never hand-merged.

## Parent copy and reading intent (machine-enforced)
1. Hale's model writes every parent-visible text. Code never assembles one: no fixed, template, skeleton or fallback copy, no character caps. If the model can't write it, nothing is sent and #ops gets an alert. (Only exception: the OTP login text.)
2. Intent, language and meaning are read by a model, never by a regex, keyword list or character count. Links are detected only with `hasLinkShape` or `hasLinkBeyond`.
3. Guard tests enforce these rules with exact-count allowlists that only go down. Raising a count needs Barton's own words in the PR body.

## Flags
1. New behaviour ships behind a default-off flag declared in `@hale/flags`; no direct `process.env` flag reads.
2. A PR that adds or changes flagged behaviour passes its touched tests with the flag on and with it off.
3. Setting a Prod flag: use the flag's own value word from the catalog (`true`, `on` or `live`), lowercase, with no trailing newline (`printf 'true' | vercel env add NAME production --force`). Before setting it, confirm PostHog has no flag with that key, because a PostHog value wins over env. After the deploy, confirm the resolved value, not just the stored one.
4. Promo, payment and Max flags never go on without Barton's own go.

## Evals
1. A PR that changes a prompt, skill or the eval harness either ships its re-record or waits for the batched re-record. It doesn't merge while its suites miss on main.
2. Edits to the same skill are batched into one PR per batch, so each re-record is paid once.
3. A change that isn't about meaning (cache TTL, metadata, ordering) must not move eval keys. If it does, fix the key, not the cache.
4. Paid runs use `ANTHROPIC_API_KEY_TEST` only, one per PR, and the PR body records `Eval spend: $X.XX`.

## Tests
1. Tests that depend on today's date pin the clock (`pinClock` or `vi.setSystemTime`). No assertions on wall-clock time or machine speed.
2. New database-query tests use pglite, not a hand-written fake DB.
3. A flaky test gets a Linear ticket the day it's seen, and it's fixed in its own PR, not inside an unrelated feature PR.

## PRs and agents
1. Noah orchestrates cloud agents; agents don't merge.
2. Verification is the job: reproduce first; every PR needs proof (preview URL, screenshot, test note, or metric) — not just "LGTM."
3. Investigate before a PR when asked — diagnose, then fix. Don't open a PR to learn.
4. Overnight review: before the 9am standup, skim open cloud-agent PRs / Linear and close or re-scope stale branches — not a new bot.
5. Never say "urgent" to skip steps. P0 still means branch → PR + proof → merge per Approvals 1. No skip lane.
6. After a miss: write the *principle* into this handbook (or the right skill), delete the incident story.
7. Refuse off-scope asks (extra bots, spray ships, phone numbers in Team Hale, inventing user-facing copy).
8. Source of truth for build planning: Linear board + `villagehale/hale` on GitHub — not old chat memory. Read [Product direction 2026-09-21](https://linear.app/villagehale/document/product-direction-2026-09-21-the-activity-finder-loop-read-before-bca7b5c32d03) before building.

## Working with agents (Barton lock 2026-10-28, after Thorsten Ball's "How I work with Agents")
1. **Best model only.** Code agents run on the newest, strongest model. A cheaper model that's wrong 10% of the time costs more in retries. (Parent-message runtime model choice and paid evals still follow their own cost rules.)
2. **Say what, not how.** Briefs state the goal and the done-condition ("p95 under 2s, don't stop until it is"), not step-by-step instructions.
3. **Give agents the whole loop.** Agents get read access to Preview logs, deploys, flags, CI, Linear and bug reports. Anything they can't see, they'll invent. Prod stays read-only, and secrets are never printed.
4. **Don't grind back and forth.** For design or wording questions, generate many variants at once and compare them side by side. For bugs, list about 4 hypotheses first, then verify each one.
5. **Hard evidence or it didn't happen.** Every PR shows proof: end-to-end Preview messages from a fake family, a recording or screenshot, before/after numbers, or eval scores pasted in. These are NOT evidence: "tests pass" alone, mocks, `--broken` or `--dry` runs, "should work", or an agent's own summary.
6. **Use timers and wake-ups.** Use scheduled checks ("check the logs in 2h", "tell me when it deploys") instead of polling or remembering.
7. **Human-facing text.** Agents may write mechanical docs (debug steps, incident notes). Internal docs that people read for judgment (PRDs, decisions, handbook rules) get human review. Parent messages are the exception: Hale's AI writes every one, by design.
8. **Review where the blast radius is.** Reviewers focus on core files, migrations, privacy and parent-facing behaviour. Naming, duplication and style don't block a merge.

## Vertical kids-year agent (Barton lock 2026-09-28)
From $3–7k PA economics + Anne Lee Skates “Who wins in agentic consumer AI” (shared Team Hale same day). Full text: Linear *Product direction 2026-09-21* top section.
1. Don’t compete as everyday personal agent / household EA (Muse–Instinct / device+OS). Hale = vertical kids-year.
2. Proprietary supply + POV is the core (live find / spot + steal/skip / empty-Sat / how-it-went) — not more assistant skills.
3. Free utility at the door; paid on year retention — not AI-assistant subscription.
4. Multi-parent social agent stays Later; co-parent silence-default stands.
5. School-inbox + light week-ahead are kids-year beats only — never OS/ambient hero.
Kill: general PA, group-logistics pivot, free-everything assistant subsidy race.

## Product direction (locked 2026-09-21)
1. Billboard H1: **Find what's on. Hear how it went.** Subhead: **What's worth doing with the kids.** Deck/category: **planner for your kids' year.** Not an AI family assistant / parent life planner.
2. AI, Gmail/calendar, co-parent, check-in, going, intros = how, never the billboard.
3. Parent-facing copy still finds / watches / hands the page / follows up — do not claim *book* until VIL-338/339.
4. Flag light order (not rewrite): weekday-care → booked → check-in/going → reviews → travel → first-reply action line. Travel off landing until lit. Paid last.
5. Hale supports ages **0–18 now**. Age and life stage choose the next useful prompt and rank/filter live search; they never block a finder feature. Preserve teen no-name privacy.
6. **Weekday finder Design lock (Sloane):** school-age under 13 → **“Want me to find one good after-school option for Maya too?”**; teen → **“Want me to find one good after-school option nearby too?”**; verified PA day/break only → **“There’s a PA day coming up. Want me to find something nearby?”**. No vague school check-in, no category laundry list in the ask, no unsupported calendar claim. Categories after yes via live search. Byte-stable — do not paraphrase.
7. Draft PR `#682` is closed — do not reopen or restart from that branch.
8. WhatsApp env stays parked until Barton clears.
9. Don’t retext families or demo sitters to test. Don’t put phone numbers in Team Hale.
10. Don’t announce or demo a path you haven’t run end-to-end today on the live account/build.

## Product locks
1. First-hello SMS path stays live; quiet with ads dark is not a miss.
2. Scoreboard is Eva, Anna, Fei unless Miles resets it.
3. Outbound `channel_messages.body` is often null in DB — that alone is not proof of a blank SMS.
4. Post-sales after first-hello stays in-product — no CS bot; nothing ships until Barton clears.
5. Name the source of truth — don’t invent landing/`/text` copy or demo data.

## Team shape (multi-bot — Team Hale 2026-09-28)
1. Reuse the existing Team Hale roster first (Cole GTM, Noah Eng, Sloane Design, Miles Advisor, Liam second engineer). New bot only when nothing on the bench fits, and only after Barton says yes.
2. Team Hale is the main channel; Hale Eng is for engineering coordination. Don’t spin other parallel clones.
3. Cap the roster. When stuck, mark blocked and ping the room — don’t spawn a helper bot.
4. Never add a Project Ops / PM auto-staff bot.

## Shape
1. Eng bots are Noah (lead) and Liam. Don't spin extra eng specialists.
2. Prefer async cloud agents for repo work; Eng merges per Approvals 1.
3. Sales Eng / demo prep: one-shot cloud agent — not a standing bot. Draft only until Barton clears.
4. Teach by putting rules here — don’t rely on chat memory alone.
5. Product chain in chat: data → PRD → Sloane → Noah.
6. Group chat: one bot tags two when needed — don’t make everyone answer every message.
7. Eng standup 1–2×/day; stay silent on no-op. Never anxiety-poll at 15m.
