/**
 * Group onboarding v2 — the only two locked sentences in this flow.
 *
 * Every other group onboarding line is written by the model from facts code owns. These
 * two are consent-critical: when the model cannot write the who's-who ask (after its
 * retry) or a STOP acknowledgement, a person must still be asked, or told they were
 * heard, so the locked sentence goes out once, tagged `source: 'locked'` and audited
 * `group_line_locked_fallback`. Bilingual because the group's members may not share the
 * family's language, and slot-free so nothing about the family is in them.
 */

export const GROUP_ROLE_ASK_LOCKED =
  "I'm Hale, the kids' year planner for this family. Please each reply for yourself: mom, dad, grandparent, nanny, babysitter, or not family. / Je suis Hale, le planificateur de l'année des enfants de cette famille. Répondez chacun pour vous : maman, papa, grand-parent, nounou, gardienne ou pas de la famille.";

export const GROUP_STOP_ACK_LOCKED =
  "Got it, I won't write to you in this group. / C'est compris, je ne vous écrirai plus dans ce groupe.";
