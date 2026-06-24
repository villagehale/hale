# Hale — Design Spec

An AI-readable design spec for Hale's UI (hale-web + the marketing site). Agents
building or revising UI **follow these rules** so every surface looks like one
product, not N different ones.

**Source of truth:** the tokens live in `apps/web/app/globals.css` (and
`apps/site/app/globals.css`). This file is the *usage rules* — which token for
which role/state, the rhythm, the copy, the motion. If a value here and the CSS
ever disagree, the CSS wins and this file is fixed. Never hardcode a hex, px
radius, or duration in a component — reference a token.

---

## 0. Who we design for (the only test that matters)

The customer is a **busy parent**, often one-handed on a phone, tired, scanning.
Every screen is judged by: *does this lower the load on that parent right now?*

- **Calm over busy.** One clear thing per screen. Whitespace is a feature.
- **Trust by default.** This is newborn/childhood data — visibly careful,
  never salesy, never alarmist. Privacy posture is felt, not buried.
- **Low-effort.** Inputs are forgiving; the next action is obvious; nothing
  demands a manual.
- **Warm, not childish.** Warmth comes from voice + the brand (turtle, Prussian,
  apricot) — not cartoons, emoji-as-icons, or baby-talk.
- **Mobile-first.** Design the 375px view first; the desktop is the easy case.
- **Stage-aware.** The same surface serves a newborn parent and a teen's parent;
  copy and emphasis shift by `deriveStage`, layout does not.

---

## 1. Color — roles, not decoration

Tokens are **semantic** and carry the **same name in light and dark** (the value
flips; the meaning doesn't). Pick a token by the element's *role + state*.

### Surfaces (elevation — step up as you nest)
| Role | Token | Light | Dark |
|---|---|---|---|
| Canvas (page) | `--color-linen` | `#f6f1e7` | `#0b1626` |
| Card (panel) | `--color-oat` | `#efe7d6` | `#13233a` |
| Raised (lifted/interactive card) | `--color-raised` | (= oat) | `#1d3150` |
| Chrome (app frame: sidebar/header only) | `--color-chrome` | (= oat) | `#021E4E` (logo Prussian) |

Rule: **canvas → card → raised → chrome** is the elevation ladder. A control that
lifts on hover steps **one notch up** the ladder; never invent a new surface.

### Text & ink
| Role | Token | Min contrast |
|---|---|---|
| Primary text/ink | `--color-spruce` | 11.96:1 / 16.12:1 |
| Secondary text | `--color-slate-green` | 7.00:1 / 12.00:1 |
| Tertiary / meta / disclaimers | `--color-faded-sage` | 4.81:1 / 8.22:1 |
| Text/icons on a Prussian fill | `--color-on-spruce` (+ `-soft`/`-faint`) | — |

### Accent & semantics (state meaning)
| Meaning | Fill | Text-safe |
|---|---|---|
| Action / link / CTA | `--color-apricot` (fill only) | `--color-apricot-deep` |
| Done / handled | — | `--color-sage` (`--color-sage-tint` pill) |
| Needs your eye (sparing!) | — | `--color-berry` (`--color-berry-tint` pill) |
| Calm / coach tone | `--color-sky` | `--color-sky-deep` |
| Brand / turtle | — | `--color-sea` |
| Hairline / divider | `--color-rule` / `--color-rule-strong` | — |

**Never** use `apricot`, `apricot` fill, `sky`, etc. for body text — only the
`-deep` text-safe variants meet contrast. `berry` is rationed: if everything is
"needs your eye," nothing is.

---

## 2. Typography — role thinking, not size thinking

Font: **Inter** (`--font-sans`, also `--font-display`/`--font-body`); **JetBrains
Mono** (`--font-mono`) for dates/counts/IDs only. Decide the *role*, the size
follows. **Sentence case, never ALL-CAPS.**

| Role | How | Size / weight |
|---|---|---|
| Display / H1 | `<h1>` | `clamp(2.6rem,6vw,4.75rem)`, 600, tracking `-0.02em`, lh 1.04, `text-wrap: balance` |
| H2 | `<h2>` | `clamp(2rem,4vw,3.1rem)`, 600 |
| H3 | `<h3>` | `clamp(1.3rem,2.2vw,1.85rem)`, lh 1.12 |
| Eyebrow (section label) | `.eyebrow` | 0.8rem, 600, tracking `0.12em`, slate-green |
| Body | default | 16px, 400–500 (16px on inputs — prevents iOS zoom) |
| Meta / caption / disclaimer | `.meta` | 0.85rem, 500, faded-sage |
| Data / numerals | `.tabular` / `--font-mono` | tabular-nums |

Inside the authed app use `.main-stage` headings (tighter clamps) — the sidebar
narrows the column.

---

## 3. Spacing & rhythm

Base unit **4px**. Use this scale only (Tailwind steps): **4, 8, 12, 16, 24, 32,
48, 64**. Rhythm creates the calm:

- **Within a group** (label↔field, icon↔text): **8px** (`gap-2`)
- **Between groups** (field↔field, card items): **16px** (`gap-4`)
- **Between sections** (page blocks): **32–48px** (`gap-8`/`gap-12`)
- Page gutter: `.shell` / `.main-stage` (don't hand-roll page padding)

Don't introduce one-off spacings (no `gap-[13px]`). Fewer values = visible rhythm.

## 4. Radius
`--r-sm 8` (inputs/small) · `--r-md 14` (textarea/cards) · `--r-lg 16` (fields) ·
`--r-xl 18` (panels) · `--r-full` (buttons, pills, avatars). Match the existing
primitive rather than picking a new radius.

---

## 5. Component states (the interaction contract)

Every interactive element defines **default → hover → active → focus**. Reuse the
primitives (`.btn-primary/-secondary/-ghost`, `.field`, `.pill`); don't re-style
from scratch.

- **Primary button** (`.btn-primary`): default `spruce` fill / `linen` text →
  hover `apricot-deep` → active `translateY(1px)`.
- **Field** (`.field`): border `rule-strong` → focus `apricot-deep` border.
- **Focus ring (mandatory, identical everywhere):**
  `box-shadow: 0 0 0 3px var(--color-linen), 0 0 0 5px var(--color-apricot-deep)`
  on `:focus-visible`. Never remove focus styling for "cleanliness."
- Touch targets ≥ 44px; add `cursor-pointer` + `touch-action: manipulation` to
  anything tappable.

---

## 6. Motion — quiet by default

Easing: `--ease-breathe` `cubic-bezier(0.4,0,0.2,1)`. **0ms is often right** — if a
state change (hover color, selection) already reads clearly, don't animate it.

| Use | Duration |
|---|---|
| Color/hover/selection state | 200–240ms (often instant is fine) |
| Layout / disclosure / nav | 260ms |
| Drawer / overlay enter | 240ms |

Bigger change → slightly longer. No bounces, no decorative motion. **Always honor
`prefers-reduced-motion`** (already wired — keep new motion inside it).

---

## 7. Copy rules (text is part of the design)

- **Buttons = action + object:** "Add to plan", "Invite co-parent" — never bare
  "Submit"/"OK"/"Done".
- **Errors = what happened + what to do:** "Couldn't reach Hale — try again in a
  moment." Never "Something went wrong."
- **Success = what changed:** "Sebastian added." Not "Saved successfully" (the
  toast appearing already implies success).
- Sentence case. Warm + plain. No jargon, no hype, no exclamation spam.
- **Privacy/teen copy** states the rule plainly when relevant (rule #1) — e.g. a
  teen's raw content is summarized, with a clear why.

---

## 8. Accessibility (non-negotiable)

- Body/secondary text meets **≥4.5:1** (the tokens above are pre-checked — use the
  `-deep`/text variants).
- **Never encode state by color alone** — pair with an icon, label, or shape
  (done = sage *and* a check; needs-you = berry *and* a label).
- Visible `:focus-visible` on every interactive element (the ring above).
- Inputs ≥16px; labels via `.field-label`; hints via `.field-hint`.
- Respect `prefers-reduced-motion` and `prefers-color-scheme` (system theme).

---

## 9. Anti-patterns (caught in review)

- Hardcoded hex / px radius / ms duration in a component (use tokens).
- A new bespoke surface color instead of the elevation ladder.
- Color-only state; removed focus rings; `<14px` body or `<16px` inputs.
- Emoji used as UI icons; ALL-CAPS headings; decorative animation.
- "Submit/OK/Something went wrong" copy.
- Desktop-first layouts that break at 375px.
