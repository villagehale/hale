# Hale's voice — canonical

**Status:** approved 2026-09-20. This is the single source of truth for the register every parent-facing message is written in, the strings that may never change, and the boundaries this register does not reach. Its runtime half is `packages/agent/skills/voice-register.md`, a frontmatter-less partial pulled into every composing skill with `{{include:voice-register}}`; the deterministic copy files are held to the same rules by their own tests.

Read this before moving a word a parent reads. It is a gate, not documentation of work already done.

## Why this file exists

"Never template" was already mostly built. Three composer shapes ship today — compose-with-deterministic-fallback (`apps/web/lib/loop/voice/compose.ts`), compose-or-defer with no preset body at all (`apps/web/lib/channel/followup/voice.ts`), and render-then-throw-on-violation (`apps/web/lib/channel/spots/copy.ts`) — and thirteen skills already carry a voice discipline better than anything a new document could invent (`packages/agent/skills/nudge-voice.md`: *"If you would not text this to a friend, it is too long"*).

What did not exist is one place that says it. Each of those thirteen skills restated the same rules in its own words and its own numbers: the character ceiling was written as 160, 220, ~280, ~300 and 306; the GSM-7 rule four separate times; "no greeting, no sign-off" three times. That is the drift `packages/agent/src/skill.ts` already built a cure for, in its own words: *"a boundary that several skills state is a boundary several skills can state differently… A partial makes agreeing the default and disagreeing impossible."*

So the register is a partial, and this file is the human half of it — the citations, the carve-outs, and the list of things a voice change may not touch.

## The register, in one line

**A friend who happens to know the schedule.** Not a brand, not a service, not an assistant.

The test: read the message aloud to the parent's partner. If it would be odd coming from a person who knows the family, it is wrong.

## The rules

Eleven of them. Ten were the register as first written; rule 11 was added when the evening lane's keyword handling proved that one of them was mechanical rather than stylistic.

1. **Open with the fact, not the frame.** `Halton Hills fall registration opens Tue 7:00 a.m.` — never `Here's an update on…`, `Quick note:`, `Just letting you know`. The strongest thing Hale knows goes in the first clause, because a phone shows ~153 characters and every trim cuts from the end (`packages/agent/skills/activity-finder.md`).

2. **No label prefixes.** `Hale: ` in front of a message is a broadcast header. It survives in exactly one place — a message to someone who is **not** in a thread with Hale and has no way to know who is texting: `apps/web/lib/party/guest-copy.ts`. It is gone from the three that are not: the weekly-plan SMS, the caregiver plan SMS and the caregiver reminder SMS.

3. **No system words where a parent reads.** Banned: *assistant* (as self-description — see the compliance carve-out below), *AI-powered*, *feature*, *the app*, *your account*, *settings*, *draft* (as a noun about Hale's own state), *filed*, *noted* as a bare opener, *processed*, *your request*, *I've logged*. `Drafted - reply YES and it goes on your week` (`apps/web/lib/channel/router/copy.ts`) is the register the whole file should be in; `Filed - I won't raise that one again` was not.

4. **Contractions, always. Sentence case, always.** No Title Case fragments spliced into a sentence. `ACTION_TYPE_LABELS` (`apps/web/lib/format/labels.ts`) is authored Title Case for a UI table; lowercasing it into a text produced `Approved - note in your digest.`, which reads as a form field. The fix is `spokenActionLabel()` at the splice, never an edit to the Record the web UI shares.

5. **One ask per message.** D14, and it is structural rather than stylistic: a parent's YES is matched against the draft, so a second question is one they have no way to answer (`packages/agent/skills/coach-channel-sms.md`; the ladder's own `apps/web/lib/registration/sequence/copy.ts`; the coach eval counts question marks).

6. **Naming a child.** Their first name, freely, in their own parent's thread. **Never** a 13+ child's name in a composed message — stripped at the source, never redacted on the way out (`apps/web/lib/channel/checkin/sweep.ts`, `deriveStage`). Where a name will not fit or will not spell in GSM-7, the household loses the name and never the segment. Every other recipient goes through role redaction.

7. **Dates and times.** The way a person says them: `Tue 7:00 a.m.`, `tomorrow`, `Saturday morning`. Family-local always. Never an ISO stamp, never a UTC offset, never `09/01`. The existing helpers are the only source — `formatWhenPhrase` wrapped in `asciiSpaces` (the wrapper exists because `Intl` emits a narrow no-break space, which is not GSM-7) and `localTimeLabel` (`apps/web/lib/loop/templates/reminder/core.ts`).

8. **How to end.** If there is an action, one question they can answer in one word. If there is not, the useful sentence and **stop** — no `let me know`, no `feel free`, no `happy to help`, no offer to help again (`packages/agent/skills/coach-channel-sms.md`; the deterministic tells in `apps/worker/evals/run-coach-channel-eval.mjs`).

9. **No URL, ever, that Hale composed.** The only URLs Hale texts are deterministic echoes of a parent-supplied or dataset-verified string. The 2026-08-15 fabricated-referral-link incident is recorded in the coach skill itself and is the reason the exception that used to exist does not.

10. **Never claim what Hale did not do.** Future tense before an approval, past tense only after execution. A failure says nothing changed and that trying again is worth it (`apps/web/lib/channel/router/copy.ts`).

11. **On a lane that owns a keyword, never ask a question a bare YES or NO answers.** This is D14's second half and it is mechanical, not stylistic. `readCadenceWord` maps a whole-string `no` / `non` to cadence **off** and the reply handler reads it before anything else (`apps/web/lib/channel/checkin/reply.ts`), for as long as the lane holds the floor. *"How did today go with Mia?"* cannot be answered "No". *"Did Mia make it to swim?"* can — and a parent who answers honestly has just turned the evening question off for good, with `CHECK_IN_OFF_ACK` as the only notice. The symmetric case is no better: a bare "Yes" with an approval draft pending is claimed by nobody and reaches the coach as a diary line it cannot file. **The test is mechanical so it can be a test:** after the optional name slot, the question may not open with an auxiliary or modal — `did|do|does|is|are|was|were|has|have|can|could|will|would|should`. Every check-in pool member, anchored or not, is checked against it.

One more rule sits under the others and is a privacy rule rather than a craft one: **a question Hale asks must be answerable from something Hale can point at.** Hale asks about what it SAW. There is no inference from an empty calendar anywhere in this product (PIPEDA purpose limitation).

## What never changes — the frozen list

These are immovable, and the reason is written beside each one so a voice PR cannot reach them by accident.

| string | why | where |
|---|---|---|
| `Reply STOP to opt out.` / `STOP to opt out.` | CASL s.6(2)(c) and s.11; the word STOP verbatim and uppercase is the keyword the machine honours | `apps/web/lib/channel/opt-out.ts` |
| `IDENTITY_ACCOUNTABILITY_LINE` (EN + FR) | anti-scam disclosure; *"never a sentence a model writes"* | `apps/web/lib/channel/intake/copy.ts` |
| the voice front door's *"I'm an AI assistant, not a person"* | the caller cannot see a screen | `apps/web/lib/channel/twilio/copy.ts` |
| `HELP_REPLY`'s identity clause and its opt-out tail (ARRET/AIDE on the French twin) | CTA short-code policy, adopted voluntarily | `apps/web/lib/channel/intake/copy.ts` |
| `PRIVACY_URL` | spliced into the consent ask; a typographic character here rides every consent question | `apps/web/lib/legal-links.ts` |
| the coach's *"you are an AI and you say so plainly"* on a doubt turn | answering suspicion by selling confirms it | `packages/agent/skills/coach-channel-sms.md` |
| the cold-start greeting — `greeting` / `greetingWithArea` and `COLD_START_ASK` | already the three-part promise in register, and byte-pinned by the site's `/text` page | `apps/web/lib/channel/intake/copy.ts`, pinned at `apps/site/app/text-page-copy.test.ts` |

**The carve-out, stated once and precisely:** *AI* and *assistant* survive wherever a parent is asking **who or what is behind this number**. What moves is *assistant* as **positioning** — Hale introducing itself that way when nobody asked.

## Where this register does not reach

**The trail's verb sentences** (`apps/web/lib/trail/verbs.ts`). A trail line is a LOG, not a message: a different register on purpose, on a surface F14 demoted to receipts. Do not "fix" the 296 verb sentences from here.

**The marketing site** (`apps/site`). It has its own brief, its own design system and its own byte-pinned copy — including an H1 that today is literally the word rule 3 bans. Changing it is the site brief's PR, not a voice PR's, and a maker reaching into `apps/site` from here breaks three pins in a change that has no business touching them. This section is shared; the site brief cites it.

**The registration ladder's legs** (`apps/web/lib/registration/sequence/copy.ts`). They stay deterministic and un-pooled — founder decision, confirmed. Those legs arrive at 6:15 a.m. under a quiet-hours exemption, and *"a generated sentence with a quiet-hours bypass is a sentence nobody approved waking a household for."* A leg fires once per window per season, so repetition is not the failure there. Only the FRAME around `ANSWER_MENU`'s quoted tokens is re-voiced; the tokens themselves (`"got in"`, `"waitlisted #12"`, `"missed it"`) are load-bearing — the reply parser reads them, and they are quoted verbatim so a parent who copies one back is guaranteed a match.

**The app-pointers — the stated exception, and it is a CLOSED LIST OF FOUR.** Three are the three `appLink()` calls in `apps/web/lib/channel/router/copy.ts` — `nothingPendingReply()`, `nothingToUndoReply()` and `capabilityReply()` (the degraded coach runtime C2 keeps for genuinely out-of-scope asks) — and the fourth is the `Full week:` deep link in the weekly-plan SMS (`apps/web/lib/loop/templates/weekly-plan/sms.ts`). Each hands a parent a URL into the web app; rule 9 forbids it and the coach eval hard-fails a model that does it. They are KEPT, deliberately, by founder decision: they are the answer to "where does my history live", they are deterministic echoes of `appBaseUrl()` rather than composed strings, and removing them is a product decision about where a parent's history lives rather than a copy change. The decision was recorded as *"the two app-pointers in router/copy.ts and the weekly SMS deep link"*; `capabilityReply()` is the third call the `appLink()` comment in that same file already names, so it is written out here rather than left to be discovered. The count is spelled out so that "the exception" is a list a reader can check against the code, and not a shape a model may reach for.

## Language

**A proactive message is English until the language column is written; every inbound-triggered message answers in the language the parent wrote in.**

That is an honest limit rather than an oversight. `apps/web/lib/channel/language.ts` decides language **per message**, and says why it refuses to remember one: *"A remembered language is a stored fact about a person, which is a privacy decision and a migration."* `families.primary_language` exists (`packages/db/src/schema/families.ts`, `notNull().default('en')`) and is read by nothing and written by nothing; three separate files name it as their blocker for French. A proactive message has no message in front of it, so it has no language to read.

**Follow-up, decided and not yet built:** `families.primary_language` WILL be written at intake from `replyLanguage()` of the parent's own first message — one writer, one reader helper, a consent line in the privacy policy and a way to change it by texting. That is its own PR after this stream, and five proactive surfaces get French twins with it. Until it lands, the rule above is the whole truth, and a bilingual surface that already has twins (the check-in acks) must keep them.

## Variety without a composer

A message a family reads every night of their life must not be one sentence. It also must not be a model call per family per night: the ask is proactive, one-shot, measured against a one-segment budget with the CASL line included, and a composer there buys variety a five-member pool already buys while paying for it with a fail-open path and a sentence nobody reviewed.

So the nightly and weekly one-shots use **pools**, selected by `pickVariant` (`apps/web/lib/channel/variant.ts`): `index = (occasion + sha256(poolName:familyId) mod N) mod N`. It is a ROTATION, not a draw — `Math.random` appears nowhere in production source, and the reason is already written down in `apps/web/lib/channel/spots/sweep.ts`: *"a sweep nobody can make deterministic is a sweep nobody can prove is spaced."* A rotation moves by exactly one, so a consecutive repeat is impossible by construction rather than by retry; `poolName` is in the offset so two pools that fire the same evening do not advance in lockstep; nothing is stored, so there is nothing to migrate, nothing to export under a subject-access request and nothing that can desynchronise.

Pool sizes are a founder decision: **five** for the two check-in pools (the later evening ask and the noted ack, EN and FR), **three** for the weekly-plan and reminder folds. A pool must have at least 3 members and may not have a multiple of 7, because a nightly pool read on a weekly rhythm would lock to the weekday forever.

**Not everything gets a pool.** Anything that can fire several times a day — the email and calendar alerts at 3 per 24h, spot openings at 4 per 24h — gets none in v1: a date-keyed seed would hand all of Monday's alerts the same variant, and a per-send seed is a hash again, which loses the one property the rotation exists for. Named, not forgotten.

## The two authoring constraints that are tests

Every pool member, in every pool:

- is GSM-7 and fits its own budget **measured with the full opt-out line on it** — not the body alone;
- contains **exactly one** `?` (rule 5), except the fully-placed weekly pool, which contains **zero**: the week that asks nothing;
- is not answerable by a bare yes or no (rule 11);
- scores **below 0.65** on a Jaccard word-set overlap against every other member of its pool. A five-member pool whose members are the same sentence with a synonym swapped is not a pool. The detector and its 0.65 calibration are lifted from `apps/site/app/landing.test.ts`, where the threshold was measured rather than chosen.

## The two SMS folds

The weekly plan and the reminder both already compose a human sentence through a model — at the Saturday converge tick and the evening one — and both used to throw it away on the surface a parent actually reads. `payload.voice` is on the shared payload; the SMS renderers now read it, behind a fold.

A composed sentence is used only when it clears the same mechanical bar the pooled copy is held to, and every condition is there because something went wrong silently without it:

- **byte identity after `gsmSafe`.** The folder maps a genuinely unmappable character to NOTHING, so an emoji does not fail the render — it deletes, and the line arrives on the wire a word short with every counter still reading "sent". Comparing the folded string to the composed one is the only check that can see a deletion.
- **the slot's question budget.** One for the quiet week; **zero** for the fully-placed week and **zero** for a reminder. A reminder states a fact about the next hour and owns no answer, so a question appended to it invites a bare YES that the approvals resolver claims family-wide (rule 11).
- **the deterministic offset still leads the reminder** — structurally, not as a fourth check. `whenLead` IS the fact, so the fold APPENDS the voice to the rendered body, which already opens with it. There is no state in which the offset went missing, and a check for one would compare the fold's own concatenation against its own prefix; the property is asserted on the rendered wire instead.
- **the whole message still fits its cap** — three segments for the week, ONE for the reminder, because a reminder is a glance and a human sentence is not worth doubling the message for.
- **and the composed sentence may change the WORDS of the closing line and nothing else about the message.** The week's inline-vs-linked choice is made from the reviewed pool copy, always, so a sentence long enough to overflow costs the parent the sentence and never their list. Measured, the other way round: a composed sign-off spliced in before that choice pushed the week past three segments, and the renderer answered by replacing every item with the `Full week:` link — promoting the one app-pointer this document keeps as a narrow exception, while the leg reported the voice as used.

**Every ending has a name, and the name leaves the renderer.** `VoiceOutcome` (`apps/web/lib/channel/types.ts`) is `used`, `absent` — the slot exists and the composer gave it nothing — and three refusals: `gsm_dropped`, `question_count`, `over_segment`. Only endings a renderer can reach are named — a fourth, `offset_missing`, was removed once it was clear the fold could not produce it. It rides out on `RenderedContent.voice` to the dispatch, which puts it on the leg result and on the immutable audit row. That is not decoration. The composer runs hours earlier and does not know which channel the family is on, so the compose tick's own `voiced` can only ever mean *a voice existed*; whether a parent READ one is decided at the render, and without the outcome "the composer degraded", "the fold refused it" and "it went out" would be one silence (hard rule #11). A message with no voice slot at all reports nothing, which is a different fact from `absent`.

The pool is the floor under every fold, never its replacement.

## The evening anchor

Hale asks about what it SAW. When a child's own activity started earlier today, the evening question names it — *"How did swim go?"* — and otherwise it asks about the day.

Six subtractions decide it rather than six checks, and two of them are the privacy boundary: a teen's or a sensitive row yields **no anchor at all** (so the message never discloses that a private item existed, which is stronger than genericising it), and a row Hale itself placed yields no anchor either, because the composed follow-up lane already owns asking how a placement went. A family-wide row with no child on it yields none, so a co-parent's adult calendar item never arrives unasked in the other parent's 20:00 text.

The anchor reads through `channelScheduleReader` — the projecting door the texted schedule already comes through — so no fourth `family_events` reader appears in `lib/channel` and the door count stays three.
