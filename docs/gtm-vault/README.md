# GTM vault

A linked knowledge base for the **business/GTM** side of Hale — the knowledge where the *code* is not the ground truth: who we sell to, who we compete with, what we've decided about pricing and positioning, and what we've learned from real users. Agents read it before writing anything customer-facing (a launch email, a landing page, a pitch, a positioning decision) so outputs are grounded in *our* reality, not generic personas.

This complements — does not replace — the code repo (the ground truth for how Hale works) and `~/.claude/.../memory/MEMORY.md` (facts about how the user works). Use this for durable *business* knowledge that would otherwise live in scattered chats.

## Structure (four pieces, nothing else)
- **`raw/`** — everything captured untouched: user-interview transcripts, competitor pages, ad-test results, call notes, survey exports. Read-only history; the agent never rewrites it. Ground truth.
- **`entities/`** — one page per concrete thing: a competitor, a customer segment, a channel, a person, a tool.
- **`concepts/`** — one page per idea: a positioning angle, a pricing model, a lesson, a strategy.
- **`INDEX.md`** — the front door: every page listed with a one-line description, so an agent knows what exists without opening everything.

## Writing rules (four lines)
1. One idea per file, with a one-line summary at the top.
2. Update the existing page instead of creating a duplicate.
3. Delete pages that turn out to be wrong.
4. Keep `raw/` sources and compiled pages separate, always.

Link liberally with `[[wikilinks]]` (e.g. a segment page links to the concepts it cares about). The links are the value: a linked wiki gets *stronger* as it grows (walk the links), where a flat pile of notes gets noisier.

## How agents read it (cheaply)
- Start at `INDEX.md`, follow the links the question points at, open only those pages. Never sweep the whole folder.
- For a big question, send a subagent to read many pages in its own context and return one paragraph of conclusions.
- Every claim about our business/customers/competitors in a customer-facing deliverable must cite a vault page.

## How it stays alive
- **On capture:** drop new material into `raw/` (transcript, competitor screenshot-to-text, ad result). Nothing else required.
- **Weekly compile:** an agent reads new `raw/` and updates the `entities/` + `concepts/` pages, linking as it goes, and prunes dead links / duplicates. Route this to a cheap model — it's routine.
- **Research sweeps** land verified, **dated + sourced** findings as pages (each carries an expiry, so stale intel announces itself). Use an adversarial skeptic pass (see `loop-mode`) before a finding is trusted.

## Rule #1 (Hale-specific)
This vault is BUSINESS knowledge. **No family/child PII, no raw newborn data, no user names or precise locations** ever enter it — segments and personas are aggregate, sourced from de-identified research. If a raw interview transcript contains PII, redact before it lands in `raw/`.
