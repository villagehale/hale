# October 2026 redesign — copy review draft

Source is the user-supplied homepage/subpage HTML and `subpages/COPY.md`, downloaded from the new Linear design handoff. Supplied copy was carried into the English pages; this is not merge approval.

## Barton review

- Homepage H1: **Your kids’ year, handled.**
- Visible story: kids logistics, co-parent chats and multiple families sharing a thread; finding → watching → reminders → how it went.
- Supplied pricing: **Free / Plus / Max**, with the 19/159 and 39/329 CAD prices and real feature lists. Only Free is available. Sign-ups are described on disabled future paid tiers and FAQ copy, without a live Free auto-booking claim or a permanent “never books” rule.
- Confirm availability wording for group chats, watching spots, calendar sharing, “the same minute,” founding rate, the first-100 badge and centre posters/referral codes against rollout state. The redesign does not implement those backend capabilities.
- October 7 follow-up: the English redesign no longer uses STOP wording in marketing. Plain-language message controls remain; the exact STOP/HELP instructions remain in Privacy and Terms.
- English `/text` uses the settled postal-code greeting from the October handoff by default, reusing the existing `greetingLadderSms` copy. The location-share greeting remains conditional on the ladder/location-card flags and an Apple platform. The outgoing intake prefill and SMS source tokens stay unchanged; tokens remain inside URI/QR payloads. This changes the displayed preview, not backend rollout flags.
- Homepage/social metadata follows the new headline; city-count language is removed from the new English homepage metadata.
- All 15 English guide detail pages now use the October shore/header/footer and reading layout. Published bodies, takeaways, FAQs, sources, review dates and structured data remain unchanged. Privacy and Terms now contain the requested legal-copy review draft described below; it is not approved policy.

## Legal and outward-copy follow-up — ready for Barton review

The user requested these revisions on October 7. Draft policy dates are October 7; no policy has been released and no clearance is recorded.

| Conflict | Proposed resolution in the local pages |
| --- | --- |
| A child's information is never visible to another family | Private profiles stay private. A new group section explains who sees messages voluntarily posted in a co-parent/multi-family thread, the separate consent needed for private contact, and the limits of deleting other participants' copies. Group capabilities are described conditionally on availability. |
| Care logs presented as the core product | Plans, preferences and feedback lead. Feeds/naps remain disclosed only for the optional care-log tools, because those collection paths still exist in `apps/web/lib/companion/log-write.ts`. |
| No paid-plan terms | Only Free can be used today; no Plus/Max purchase or charge is authorized. Before paid plans open, price, taxes, billing period, renewal, cancellation and refund terms must be provided for express agreement. A subscription alone does not authorize a provider booking. Final paid launch terms are still required before charging. |
| Permanent no-booking statements | Privacy, Terms and For centres say: **Today, Hale finds and reminds; parents register themselves. Signing up for them is a future paid feature, only when they say yes.** |
| Unconfirmed Privacy Officer name | Public copy uses **Privacy Officer** and **privacy@villagehale.com**; no personal name is guessed. Barton still needs to confirm the internal appointment/name if it is to be published. |
| STOP wording in marketing | Removed from the English homepage and eight redesigned non-legal subpages. Opt-out instructions remain in the legal pages. |

Privacy wording was checked against the [OPC's meaningful-consent guidance](https://www.priv.gc.ca/en/privacy-topics/privacy-for-businesses/appropriate-handling-of-personal-information/collecting-personal-information-and-consent/consent/gl_omc_201805/). The role/contact presentation follows the [CAI's private-enterprise guidance](https://www.cai.gouv.qc.ca/protection-renseignements-personnels/information-entreprises-privees/responsable-protection-renseignements-personnels-entreprise), which calls for publication of the officer's title and contact details. These references do not approve Hale's policy or verify its product safeguards.

**Clearance still required:** Barton must approve the revised outward copy and legal draft before merge. Availability, founding-rate and response-time claims remain on the review list above. No review request has been sent externally.

## Localization

FR/ZH regeneration waits for the new English copy lock, as requested by the new handoff. Existing translated draft routes remain available locally and should not be presented as completed new-design translations.

Checkpoint `fd5b525f` was committed and pushed at the user's request. This legal/copy and guide-detail follow-up is included in the next commit on the same review branch. Barton clearance remains outstanding; no merge or deployment has been made. FR/ZH received a scope estimate only, with no implementation changes.
