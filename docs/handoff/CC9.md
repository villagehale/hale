Original Claude Code brief for VIL-706 (written Nov 20, 2026, for a headless session). Parts that only applied to that machine are rewritten for a fresh clone of villagehale/hale on a Mac. The ticket's current state (branch, PR, what is done and left) is in the handoff file next to this brief and in the Linear ticket; it wins over this brief where they differ. Make reasonable decisions and record them in the PR body.

## Where you are
- Working directory: your clone of villagehale/hale. Branch: cc/vil-706-join-door-model-copy. Run `pnpm install` first. Base is main. Run `git fetch origin` and make sure your head contains origin/main before opening the PR.
- Flag for the new behavior (default off, declared in @hale/flags, enabled only when the value is exactly 'true'; no direct process.env flag reads): JOIN_DOOR_MODEL_COPY_ENABLED (exists in the PR). The final name is yours to pick if the proposed one is wrong; declare it and say so in the PR.
- PR title: "fix: compose join and caregiver door lines from facts (VIL-706)" (opened as DRAFT, base main).

## READ FIRST
1. Read the full handoff file: docs/handoff/README.md (item table, workflow, and the hard rules). Also docs/handoff/hale-eng-handbook.md. Then in the repo: CLAUDE.md, REVIEW.md, docs/voice.md, docs/flag-rollout-checklist.md, plus the files named in your Linear issue.
2. The hard rules (section 3 of the handoff), quoted verbatim:

## 3. Hard rules (non-negotiable)

1. **Every parent-visible message is fully AI-composed from facts.** No templates, skeletons, code-assembled prefixes, or fallbacks. **If the model cannot write it, send nothing** (and page #ops). Only exception: the OTP login text.
2. **No word lists, regex or keyword matching to understand parent intent.** Use the model's meaning read. Links are detected only with `hasLinkShape` / `hasLinkBeyond`. Guard tests have exact-count allowlists that only go down; raising one needs Barton's own words in the PR body.
3. **Linq only, never Twilio.**
4. **No STOP or HELP** in messages or on the site.
5. **No Sunday week-ahead** (retired). Only the night-before and 1-hour-before reminders.
6. **No referral program, no gift-a-year.** (Barton reaffirmed Nov 19. Do not build item "referral codes".)
7. **Hale reports registration honestly:** say "registered" only after the provider's confirmation. No 7 AM race optimization.
8. **Promo flags and ads stay off until Barton says go.** Payment flows A to F stay flagged off.
9. **Never print secrets.** `ANTHROPIC_API_KEY_TEST` and Stripe keys: never print, echo or paste. No passwords, codes, reset URLs or keys in chat, PRs, logs or Linear.
10. **Paid evals follow the economy rules:** use `ANTHROPIC_API_KEY_TEST` only, develop with `--cached-only` / `--dry`, one paid run per PR, re-record only failures, put `Eval spend: $X.XX` in the PR body.
11. **Group privacy:** say only what every member present may hear. Health and payment details only in DMs. One parent's inbox content is never shown to another parent.
12. Every new behavior ships behind a **default-off flag declared in `@hale/flags`** (no direct `process.env` flag reads). Test with the flag on and off.
13. **Barton (or whoever he names) reviews and merges.** As of Nov 20 Noah is no longer on this work; Barton runs Claude Code himself. Do not message parents, post in group chats, or send outreach.
14. No fixed copy for caregivers, co-parents or anyone else either: the "parent" rule covers every human Hale texts.

## Extra rules from Noah/Barton for this run
- No fixed or template parent copy, ever (the OTP login text is the only exception). Every message a human receives is AI-written from facts; if the model fails, send nothing.
- No STOP or HELP anywhere. No regex or word-list intent detection (use the model's meaning read). No character caps. Linq only, never Twilio.
- All new behavior is behind a default-off flag that is exactly 'true' to enable. Test with the flag on and off.
- No referral codes or gift-a-year. No Sunday week-ahead.
- NEVER use GitHub stacked PRs (no stack_on). Base on main (or the PR branch named below).
- Spend model money only on what is necessary: tests/evals that call the model run with --dry / --cached-only and use cached recordings where the repo supports them. Never use any Anthropic key except ANTHROPIC_API_KEY_TEST, and do not record a paid eval unless Barton says so for this PR. State in the PR body which eval cases you added and that recording is pending ("Eval spend: $0.00, recording pending Barton's OK").
- Never print secrets. Never read, source or load any file holding Production values (a Prod env dump, `vercel env pull` output, a shell profile that exports Prod keys). Tests never run with Prod secrets loaded. Never read env files holding production values. Do not touch Vercel, Prod env, or PostHog/Linq/Stripe production settings; do not flip any flag in Prod; do not message anyone (parents, groups, Slack, email).
- Do not merge anything. Never push to main. Stage files explicitly; conventional commits; no --no-verify.
- Prompts load through loadPrompt (never inline). Dates in tests use pinClock / vi.setSystemTime. New DB-query tests use pglite. If a migration is needed, pick the number via `pnpm db:next-migration` after fetching.
- Raising a guard-test allowlist is forbidden (counts only go down).
- Keep runs light: run only the tests you touched (vitest on specific files, scoped typecheck such as `pnpm --filter <pkg> typecheck`), never the full monorepo test suite or `pnpm build` in parallel with unnecessary work.
- This branch is based on the branch of open PR #1318 (cursor/join-door-model-copy-26fd), and origin/main has already been merged into it locally. Your job is to FINISH PR #1318 in place: push with `git push origin HEAD:cursor/join-door-model-copy-26fd`; do not open a duplicate PR, and do not change its ready/draft state. Scope per VIL-706 plus these additions from Noah:
 (1) Make CAREGIVER_WELCOME, CAREGIVER_DECLINE_ACK, inviteSentAck and inviteDroppedAck in apps/web/lib/channel/caregiver/copy.ts AI-written from facts, send nothing on model failure (page #ops through the existing ops-page helper), drop STOP. Also cover the other fixed strings Linear VIL-706 lists (ADD_EXAMPLE, CO_PARENT_REDIRECT, NUMBER_IN_USE, OWN_NUMBER, ALREADY_INVITED, CANNOT_TEXT_THAT_NUMBER, TOO_MANY_INVITES) if the existing PR has not already.
 (2) apps/web/lib/channel/templates/caregiver/reminder-sms.ts (find the real path with rg) is fixed code-built copy sent to caregivers. Make it AI-written from facts behind a NEW default-off flag (declared in @hale/flags, exactly 'true' enables), with nothing sent on model failure. Tests with flag on and off.
 (3) Correct the outdated VIL-229 "deterministic fallback" comment/contract text in apps/web/lib/channel/types.ts (lines ~13-23): a null voice must hold the send (nothing is sent). Verify the actual send path already behaves that way and add/keep a test proving it.
 (4) Add the VIL-706 guardrail test: a parent-facing send path must not import a string constant containing STOP or HELP.

## Your Linear issue (source of truth for scope), pasted verbatim
# VIL-706: Bug: co-parent join and caregiver doors send fixed template copy that teaches STOP
URL: https://linear.app/villagehale/issue/VIL-706/bug-co-parent-join-and-caregiver-doors-send-fixed-template-copy-that

**Launch-blocking per Barton 11-16 11:05 PM ET (via Sloane).** Source: PR [villagehale/hale#1302](https://linear.app/villagehale/review/launch-red-team-report-c27871874680) launch red team, finding 6, verified by Noah against origin/main 4cd22e825. Verdict: **CONFIRMED**. This breaks Barton's rules: no fixed/template parent copy except the OTP login text, and never teach STOP/HELP.

**Live in Prod:** yes. Neither route has a flag check (`apps/web/lib/channel/join/route.ts`, `apps/web/lib/channel/caregiver/route.ts`).

## Evidence

* `apps/web/lib/channel/join/copy.ts:62-64`: `joinWelcome` returns "You're in - … Reply STOP anytime." It's sent at `join/route.ts:362`. The fixed `JOIN_ACCEPTED_ACK` (`copy.ts:68`) goes to the inviter at `route.ts:384`. `joinInviteForward` (`copy.ts:30`) is also fixed.
* `apps/web/lib/channel/caregiver/copy.ts:41-44`: `CAREGIVER_WELCOME` ("… Reply STOP anytime.") and `CAREGIVER_DECLINE_ACK` are sent at `caregiver/route.ts:516,529`. More fixed strings sit in the same file and go to parents: `ADD_EXAMPLE` (:53), `CO_PARENT_REDIRECT` (:67), `NUMBER_IN_USE` (:71-72, also teaches "reply STOP"), `OWN_NUMBER`, `ALREADY_INVITED`, `CANNOT_TEXT_THAT_NUMBER` and `TOO_MANY_INVITES` (:74-92), used at `route.ts:834,1112-1125`.
* The friend-voice judge already rejects this shape (`friend-voice.test.ts` \~882-888, reason `compliance`), but these doors never call the writer or judge.
* Related: `apps/web/lib/channel/types.ts:13-23` (the [VIL-229](https://linear.app/villagehale/issue/VIL-229/f11-v-llm-voice-layer-every-user-email-personally-composed-no) loop voice contract) still requires a deterministic fallback when voice is null. That's dormant while LOOP_SEND_ENABLED is off, but it reopens fixed copy if the flag is lit.

## Fix

1. Route every one of these sends through the model writer used by onboarding (facts in: inviter name, role, the seat outcome), with no STOP/HELP mention. If the writer returns nothing, send nothing and page #ops; the seat change is already recorded.
2. Delete the copy constants and their snapshot tests, and replace them with eval cases scored by the friend-voice judge.
3. Change the loop voice contract so a null voice holds the send, before LOOP_SEND_ENABLED is ever set.
4. Add a guardrail: a lint/test that fails if a parent-facing send path imports a string constant containing "STOP" or "HELP".

## Done when

* `rg "Reply STOP|reply STOP" apps/web/lib/channel` returns nothing outside tests and the opt-out reader.
* Join/caregiver pglite tests assert a writer call, and that a null draft means no send and one page.
* One paid eval record run (ANTHROPIC_API_KEY_TEST) covers join welcome, inviter ack, and caregiver yes/no.

Size: M. Suggested PR grouping: its own PR. It can share an agent with the opt-out fail-closed bug (finding 7), but keep separate PRs.


## Definition of done
1. Implement the item per the issue, handoff and rules above, flag off by default.
2. Run lint (biome lint on your changed files / `pnpm lint`), typecheck for the touched packages, and the touched tests, with the flag on and off. Fix everything until green locally.
3. Commit, push your branch (`git push -u origin cc/vil-706-join-door-model-copy` unless instructed otherwise above), and open a DRAFT PR against main with `gh pr create --draft --base main` using the title above (check `gh auth status` first). PR body: what changed, the flag name and default and how to turn it on/off, tests run, "Eval spend: $0.00 (recording pending)", open risks, and the Linear link: https://linear.app/villagehale/issue/VIL-706/bug-co-parent-join-and-caregiver-doors-send-fixed-template-copy-that. Do not merge. Do not mark ready.
4. Stop when the PR is open and green locally. Put a short summary (PR URL, flag, tests run, open risks, anything you could not do) in the PR body and as a comment on the Linear ticket, and print it as your final message.

NOTE: for this session, the instructions about reusing the existing PR in place override step 3 of the definition of done (do not open a new PR; push to the existing PR branch).


Also: commit and push a draft PR as soon as a flag-off slice is working; do not wait until the end; do not exit while waiting on background work.
