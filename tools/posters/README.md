# Neighborhood poster system

The one poster template. This is the design the founder approved for the
2026-08-26 Toronto pack (`hale-toronto-posters.pdf`) and every plate since —
shore portrait, icon + wordmark lockup, serif headline, frosted neighborhood
card, amber banner, navy scan card, no footer. **Do not redesign it, re-derive
it, or build another renderer.** A new poster is a data entry, not a layout.

## Add a plate (the whole procedure)

1. **Registry first** — add the source code to `SOURCE_VENUES` in
   `apps/web/lib/channel/intake/copy.ts`:
   - `earlyon-<place>` for an indoor board at a partner venue (EarlyON, library,
     daycare); `poster-<place>` for a City postering column.
   - `name` is read back to the parent ("You found me at the …"), `areaCoarse`
     is the venue's FSA (rule #1: coarse only), `poster` is the place name the
     founder-welcome ping speaks.
   - **GSM-7 only** in these strings (hyphens, never em-dashes) — they ride in
     real SMS and `sms-copy-encoding.test.ts` gates them.
   - NOT in `LIFETIME_FAMILY_SOURCE_CODES` unless the founder explicitly grants
     the comp (only the Halton Hills launch pair carries it). Pin it with a test
     beside the Ossington one in `copy.test.ts`.
2. **Plate entry** — add to `PLATES` in `plates.mjs`: `code`, `band` (renders as
   FOR <BAND> FAMILIES), `localLine` (name the actual nearby parks/rec, keep the
   sentence shape), `qrValue`:
   - Indoor board → the sms: deep link:
     `sms:+12892172279?&body=Hi%20(via%20<code>)`
   - Street column → the landing: `https://www.villagehale.com/text?s=<code>`
3. **Cut it** — `node tools/posters/render.mjs <code>` writes
   `print/<code>.{html,pdf,png}`. Commit the pdf + png (not the html — it
   carries machine paths).
4. **Verify** — decode the rendered QR with a real reader (jsQR over the png)
   and confirm the exact payload; run the intake copy tests.
5. **Founder reviews the plate before anyone posts or sends it.** No auto-merge
   on poster PRs.

The attribution only goes live when the registry change deploys — a scan before
that still starts a conversation but drops the venue tag, so merge before print.

## Where the assets come from

Wordmark and icon are read LIVE from `apps/site` at render time (they cannot
drift from the site); fonts are the site's own woff2 files. Only
`assets/shore-portrait.png` lives here — the portrait master of the shore art
(the site ships a wide crop; print needs portrait).
