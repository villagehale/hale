/**
 * CURATED COACHING PLAYBOOKS — the method content behind a full coaching plan.
 *
 * A parent who asks how to get their toddler sleeping through the night does not want a
 * milestone window; they want a NAMED METHOD and the nights it runs on. The companion
 * (companion.ts) answers "what matters at this age"; this answers "what do we actually
 * do, and why that one". Same discipline: deterministic, curated, NO LLM here. The plan
 * composer is handed the matching playbook and grounds every claim in it, so the method
 * a family is told to follow is versioned in this file rather than improvised per send.
 *
 * PROVENANCE. Drafted from CPS / Health Canada / PHAC guidance plus named peer-reviewed
 * sources, then ADVERSARIALLY VERIFIED against re-fetched sources (workflows
 * wf_57d0d6a6 + wf_f89fa87d, 2026-08-12): 161 claims checked and 20 refutations applied,
 * including a fabricated citation author and a US-vs-Canada allergen framing. The text
 * below is that verified content VERBATIM.
 *
 * DO NOT PARAPHRASE OR "IMPROVE" THE CONTENT. A rewrite un-verifies it — these claims
 * are true because they were checked against these sources in these words. Editing the
 * prose is a content change that needs the verification pass run again, not a cleanup.
 * The Canadian allergen framing in `solids` is deliberate and is not the US "big 9".
 *
 * Rule #1 holds as it does in the companion: this is general guidance a parent reads
 * alongside their provider, never a diagnosis. Every playbook carries its own
 * `doctorTriggers`, and the composer is required to surface one.
 */

/** The topics a curated playbook exists for. Deliberately three in v1: a method
 * playbook is only worth having where there IS a named, studied method, and where the
 * cost of improvising one is a family following invented instructions for a week. */
export type PlaybookTopic = 'sleep' | 'potty' | 'solids';

/** The method Hale recommends, and everything needed to say WHAT, WHY and HOW. */
export interface PlaybookMethod {
  /** Named, because a plan that will not name its method is a plan a parent cannot look
   * up, compare, or tell their partner about. */
  name: string;
  what: string;
  why: string;
  /** The sequence itself — the nights, days or weeks, with the intervals. */
  how: string;
  /** Who this method is NOT for, and why. Enforced in code before composing (see the
   * plan composer's age gate) rather than left to the prompt. Prose rather than a
   * number because the boundary is a clinical judgement with reasons attached, and the
   * refusal a parent gets is grounded in those reasons. */
  ageGate: string;
  /** What to expect while it works — including the point where it looks like it is
   * failing and is not. */
  expectations: string;
}

/**
 * The age gate as a MACHINE-CHECKABLE bound — a projection of the `ageGate` prose
 * above, not a second source of truth.
 *
 * It exists because "never sleep train a baby under 6 months" has to be enforced before
 * a model is asked to write anything, and a prompt cannot be trusted with that. The
 * prose stays the authority: a refusal quotes it, and every number here traces to an
 * explicit phrase in it (see the test, which pins each one to its sentence).
 *
 * `maxMonths` is null where the verified prose sets no upper bound. Guessing one would
 * be inventing a clinical boundary, which is the whole thing this module refuses to do.
 */
export interface PlaybookAgeBound {
  minMonths: number;
  maxMonths: number | null;
}

/** The other reasonable choice, named in one clause so the parent can pick. Hale
 * recommends the primary plainly; it does not pretend there is only one way. */
export interface PlaybookAlternative {
  name: string;
  what: string;
  whenPreferred: string;
}

/**
 * A practitioner-educator a parent can go to for more, AFTER the plan.
 *
 * Names only, never a URL (the links doctrine: Hale is the whole product inside the
 * thread, and a link is a handback). The credential rides in the prose so the parent
 * knows why this person is worth their time. The composer may name at most one, and
 * only from this list — anything else is a fabrication, and the eval fails it.
 */
export interface PlaybookCreator {
  name: string;
  credential: string;
  goodFor: string;
  /** How the name and credential were checked. Never sent to a parent; kept so a
   * citation can be re-verified without re-running the research pass. */
  verified: string;
}

export interface CoachingPlaybook {
  /** What this playbook covers, including the guidance bodies behind it. */
  topic: string;
  primaryMethod: PlaybookMethod;
  /** The enforceable form of `primaryMethod.ageGate`. */
  ageBound: PlaybookAgeBound;
  alternativeMethod: PlaybookAlternative;
  readinessSigns: readonly string[];
  neverDo: readonly string[];
  doctorTriggers: readonly string[];
  sources: readonly string[];
  /** Practitioner-educators vetted for THIS topic. */
  goDeeper: readonly PlaybookCreator[];
}

/**
 * The verified practitioner-educators, each tied to the topics they were checked
 * against.
 *
 * The mapping from the research pass's own topic label to a PlaybookTopic is written out
 * rather than inferred, precisely because a creator vetted for sleep training must never
 * be offered on a solids plan. Note the sleep list deliberately excludes Emma Hubbard:
 * the verification note records that her flagship sleep video argues AGAINST sleep
 * training, which would read against the plan Hale just sent.
 */
const CREATORS: readonly (PlaybookCreator & { forTopics: readonly PlaybookTopic[] })[] = [
  {
    name: 'The Doctors Bjorkman (Dr. Kurt Bjorkman, with Dr. Sarah Bjorkman)',
    credential: 'Board-certified pediatrician (Kurt) and board-certified OB/GYN (Sarah); youtube.com/c/TheDoctorsBjorkman',
    goodFor: 'The \'is sleep training safe and does it work\' deep-dive: their sleep-training video reviews the actual RCT literature (Mindell 2006, Hiscock 2007) on benefits and harms, then gives 6 practical steps — put baby down awake, brief mid-night reassurance checks, consistency — which matches the playbook\'s graduated check-in method rather than straight cry-it-out.',
    verified: 'Confirmed names/specialties on thedoctorsbjorkman.com and pulled the video description (youtube KUIWt80Ef9g): pro-sleep-training evidence review with put-down-awake + \'Mid-Night Reassurances\' steps and Ferber among cited resources — aligned with graduated check-ins; Emma Hubbard was left off this topic because her flagship sleep video is \'4 Steps To Great Sleep Without Sleep Training\', which would read against the plan.',
    forTopics: ['sleep'],
  },
  {
    name: 'Emma Hubbard',
    credential: 'Paediatric occupational therapist (occupational therapy degree, University of Newcastle AU, 2008; 12+ years clinical practice; founder of Brightest Beginning); youtube.com/c/EmmaHubbard',
    goodFor: 'A readiness-first, fast-intensive walkthrough that mirrors the playbook: \'Potty Training In Days, Not Weeks (8 Essential Steps to Toilet Train Your Toddler Fast!)\' opens with how to tell your child is ready before starting the short intensive, plus companion videos on the 6 common mistakes and on stopping a regression becoming an ongoing problem.',
    verified: 'Confirmed the paediatric-OT credential via brightestbeginning.com/about and her channel; pulled the video description (youtube FuEOVu6U4CI, channel: Emma Hubbard) — readiness-gated, days-long method aligned with the 3-day playbook; the Bjorkmans were excluded from this topic because their \'3-Day Potty Training? | Potty Learning Myth #1\' video (0UOtLwhRZOY) directly contradicts the 3-day method.',
    forTopics: ['potty'],
  },
  {
    name: 'The Doctors Bjorkman (Dr. Kurt Bjorkman, with Dr. Sarah Bjorkman)',
    credential: 'Board-certified pediatrician (Kurt) and board-certified OB/GYN (Sarah); youtube.com/c/TheDoctorsBjorkman',
    goodFor: 'The medical half of starting solids: a 3-part series covering when to start (~6 months, AAP/WHO readiness signs), baby-led weaning benefits/risks with a dedicated allergens segment, and 10 best first foods / 13 foods to avoid — and they explicitly teach early allergen introduction (peanut, egg, soy, shellfish) to prevent allergies, matching the playbook\'s CPS/Health Canada approach.',
    verified: 'Pulled all three series video descriptions (tOiXWDG44wU: ~6 months per AAP/WHO; N8gLcrPEhB4: \'Allergens\' chapter at 11:11; KGvorfE_iDA: first foods/foods to avoid) plus their short O7yk8dNECOQ stating peanut butter, soy, shellfish and eggs \'are all great things to introduce to your baby early to help prevent allergies\' — aligned with early-introduction guidance.',
    forTopics: ['solids'],
  },
  {
    name: 'Emma Hubbard',
    credential: 'Paediatric occupational therapist (occupational therapy degree, University of Newcastle AU, 2008; 12+ years clinical practice; founder of Brightest Beginning); youtube.com/c/EmmaHubbard',
    goodFor: 'The feeding-skills half: \'Baby\'s First Food — The Complete Guide to Starting Solids\' plus a deep library on readiness signs, BLW vs spoon-feeding, high-chair positioning for a safe swallow, gagging vs choking, foods never to give a baby, and troubleshooting refusal/mess — practical OT territory that complements (and nowhere contradicts) the playbook\'s allergen schedule.',
    verified: 'Enumerated her channel\'s solids videos via channel search and pulled the Complete Guide description (LAfn4s8Jcps: readiness, method choice, equipment, safety); found no allergen-delaying content, so her entry is scoped to feeding mechanics while the allergen protocol is carried by the Bjorkman/CPS references.',
    forTopics: ['solids'],
  },
];

const SLEEP_PLAYBOOK: CoachingPlaybook = {
  topic: 'Sleep training for children 6 months to 3 years (Canadian guidance: CPS, PHAC/Health Canada, peer-reviewed evidence)',
  primaryMethod: {
    name: 'Graduated check-ins (Ferber method)',
    what: 'You do your normal bedtime routine, put your child in their crib drowsy but awake, and leave. When they cry, you wait a set number of minutes before going back for a brief, calm check — no pickup, no feeding — and the waits get a little longer each night. Over about a week, your child learns to fall asleep on their own, which is the same skill they need to fall BACK asleep at 2 a.m. without you.',
    why: 'It\'s one of the best-studied sleep methods there is. An American Academy of Sleep Medicine review of 52 studies found behavioural sleep interventions effective in 94% of studies — the review\'s strongest support goes to unmodified extinction and preventive parent education, with clear additional support for graduated extinction (this method) — and across behavioural interventions as a whole, over 80% of children clinically improved, with gains holding 3–6 months (Mindell 2006). In one randomized trial, controlled crying improved infant sleep at 2 months (the difference vs control wasn\'t sustained at 4 months) and reduced depression symptoms in the mothers who started out depressed (Hiscock & Wake, BMJ 2002); a later cluster-randomized trial of graduated check-ins and camping out found both fewer sleep problems AND lower maternal depression scores at 10 and 12 months (Hiscock 2007). A 2016 RCT found children\'s stress hormone (cortisol) went down, not up, and attachment security was no different from controls a year later (Gradisar, Pediatrics 2016). And the five-year follow-up found no differences, positive or negative, in emotional health, behaviour, sleep, parent-child relationship, or chronic stress between sleep-trained and non-sleep-trained children (Price, Pediatrics 2012). Many families see clear improvement within the first week.',
    how: 'Pick a start night that opens a clear week — no travel, no illness, no daycare transition. Set a consistent bedtime (6:30–8:00 works for most kids this age) and do the same 20–30 minute wind-down every night: bath, feed, book, song — CPS calls it the 3 Bs: bath, book, bed. Keep the feed BEFORE the book so eating unhooks from falling asleep. Put your child in the crib drowsy but awake, say your goodnight phrase, and leave.\n\nWhen they cry, wait before going back. Night 1: wait 3 minutes, then 5, then 10 — and 10 for every check after that. Checks last 1–2 minutes: lights off, calm voice, the same short phrase (\'I love you — it\'s sleep time\'), maybe a brief pat, then leave, even mid-cry. You\'re proving you exist, not soothing them to sleep. No pickup, no feed, no lights.\n\nNight 2: 5 / 10 / 12 minutes. Night 3: 10 / 12 / 15. Treat every middle-of-the-night waking exactly like bedtime, restarting that night\'s sequence from its first interval. From your set morning time onward, start the day — cheerful, lights on, out of the crib.\n\nNights 1–3 are the hard part. Expect 30–60+ minutes of protest, and expect night 2 or 3 to be WORSE than night 1. That spike is the extinction burst — the old pattern breaking, not the method failing. In our experience, that spike is exactly when quitting feels most tempting — often one night before it breaks.\n\nNights 4–7, keep stretching: Night 4: 12 / 15 / 17. Night 5: 15 / 17 / 20. Night 6: 17 / 20 / 25. Night 7: 20 / 25 / 30. By this point, expect that many children are falling asleep in minutes and you may rarely reach the long waits.\n\nIf your child vomits from crying, go in right away, clean up calmly with minimal fuss, then resume. Decide in advance which parent handles checks each night, so nobody caves at 2 a.m. Little progress after 7 consistent nights? Stop and text us — we\'ll troubleshoot naps, schedule, or fit.',
    ageGate: '6 months or older — never younger. Under 6 months, babies still legitimately need night feeds, their circadian rhythm isn\'t consolidated, and PHAC recommends they sleep in your room for the first 6 months anyway; the trials showing safety and effectiveness started at 6 months or later. For premature babies, count from the due date, not the birth date. If there\'s any question about weight gain or whether your baby still needs a night feed, get your doctor\'s or nurse practitioner\'s OK before starting. Works up to about age 3 (toddlers in beds usually need the chair method or a modified version instead).',
    expectations: 'Crying is front-loaded: hardest on nights 1–3, with a likely extinction burst — a worse night 2 or 3 — before it breaks. Expect falling-asleep time to shorten noticeably within the first week and nights to consolidate soon after; across behavioural sleep interventions as a whole, over 80% of children show clinically significant improvement that holds for 3–6 months. Consistency is the whole mechanism: intermittent giving-in (caving at minute 9) teaches your child to cry longer, so a half-done attempt is harder on everyone than not starting. Naps can be trained the same way or left alone at first — nights come first. Expect brief regressions after illness, travel, or big milestones; re-run 2–3 nights of the table and it comes back fast. And expect to feel awful listening — that\'s normal and not a sign of harm; the five-year follow-up found no differences, positive or negative, between sleep-trained and non-sleep-trained children.',
  },
  // '6 months or older - never younger' ... 'Works up to about age 3'.
  ageBound: { minMonths: 6, maxMonths: 36 },
  alternativeMethod: {
    name: 'Chair method (camping out / parental fading)',
    what: 'You stay in the room while your child falls asleep, sitting in a chair beside the crib, offering calm presence and minimal touch — but not feeding or rocking to sleep. Every 3 nights or so, you move the chair farther away: beside the crib, mid-room, by the door, in the hallway in view, then gone. Takes about 2–3 weeks. This \'camping out\' approach was one of the two arms in the Hiscock 2007 trial (Arch Dis Child) — the same program whose five-year follow-up found no differences, positive or negative — so it\'s trial-tested, just slower.',
    whenPreferred: 'Choose this when a parent genuinely can\'t tolerate timed crying from another room — a parent who will cave at minute 4 will do more harm with Ferber than good, because intermittent rescuing teaches longer crying. Also the better fit when: you\'re still room-sharing (one-bedroom home, or just past the 6-month PHAC room-sharing window and not ready to move baby out); your child is temperamentally intense or highly sensitive; your toddler is in a bed rather than a crib (they can follow you out — presence-fading works, closed-door waits don\'t); or you tried graduated check-ins before and abandoned them mid-burst, which can make a repeat attempt harder. Trade-off to say out loud: less intense crying per night, but more total nights of protest, and it demands the same consistency for 2–3 weeks instead of one.',
  },
  readinessSigns: [
    'Child is at least 6 months old (corrected for prematurity), gaining weight well, and your provider hasn\'t asked you to keep night feeds',
    'Currently falls asleep only with feeding, rocking, or a parent present, and wakes 2+ times a night wanting the same help — that\'s the sleep-onset association this method fixes',
    'No active illness, fever, new teeth breaking through this week, or recent vaccination reaction',
    'No major disruption in the next 2 weeks: no travel, move, new sibling arriving, or daycare start',
    'Both caregivers agree on the plan and can commit to 7 consecutive nights (Ferber) or 2–3 weeks (chair) without caving',
    'Child has their own safe sleep space per PHAC: crib, cradle, or bassinet with a firm flat mattress and nothing else in it',
    'Daytime schedule is roughly settled — naps not running past ~4 p.m., bedtime landing at a consistent hour',
    'Parents are ready to hear crying without rescuing — if not, start with the chair method instead',
  ],
  neverDo: [
    'Never sleep train a baby under 6 months (corrected age) — younger infants need night feeds and are still in the PHAC room-sharing window',
    'Never trade away safe sleep to reduce crying: always on the back, in their own crib/cradle/bassinet on a firm flat surface, with nothing soft in the sleep space — no blankets, pillows, bumper pads, sleep positioners, or stuffed toys (PHAC)',
    'Never move a crying baby to an adult bed, couch, armchair, or swing to finish the night — that\'s where the real danger is, not the crying',
    'Never run timed check-ins in a bed-sharing setup — this method requires the child\'s own safe sleep surface',
    'Never drop night feeds against your provider\'s advice or while weight gain is in question',
    'Never lock, latch, or hold shut a toddler\'s door, and never physically restrain a child in bed',
    'Never give melatonin, sedating antihistamines, or any medication to force sleep at this age without a physician directing it',
    'Never start or push through during fever, vomiting illness, or laboured breathing — pause, comfort freely, restart when well',
    'Never ignore a cry that changes character — sudden shrieking, pain pitch, or unusual silence means go in and check now',
    'Never put a bottle in the crib (choking and tooth-decay risk — CPS)',
  ],
  doctorTriggers: [
    'Snoring, mouth breathing, gasping, or pauses in breathing during sleep — possible obstructive sleep apnea, and no behavioural method fixes it',
    'Poor weight gain, feeding difficulties, or any provider instruction to maintain night feeds — coaching pauses until the provider clears night-weaning',
    'Signs of pain driving the waking: back-arching or crying during/after feeds (reflux), relentless night scratching (eczema/allergy), ear-pulling, or fever',
    'Vomiting at every session, or crying that stays extreme with zero progress after 7 consistently-executed nights — stop and get the child assessed before pushing harder',
    'Night episodes with screaming plus stiffening, rhythmic jerking, unresponsiveness, or confusion — needs a physician to distinguish night terrors from seizures',
    'Any loss of previously-mastered skills or developmental regression around the same time',
    'A parent experiencing worsening depression, rage, or thoughts of harming themselves or the baby — parental sleep deprivation and postpartum depression are medical issues; the parent sees their own provider, and coaching pauses',
    'Child born very premature, or with a chronic medical condition or neurodevelopmental disability — needs an individualized plan from their care team, not a standard protocol',
    'Still no improvement after 2 weeks of consistent, correctly-executed coaching — time for a clinical look at what else is going on',
  ],
  sources: [
    'Ferber R. Solve Your Child\'s Sleep Problems, revised edition. Fireside/Simon & Schuster, 2006 — canonical night-by-night graduated check-in interval table (3/5/10 through 20/25/30)',
    'Canadian Paediatric Society, Caring for Kids: \'Healthy sleep for your baby and child\' — drowsy-but-awake, comfort-in-crib without pickup from 6 months, 3 Bs bedtime routine, no bottles in bed. https://caringforkids.cps.ca/handouts/healthy-living/healthy_sleep_for_your_baby_and_child (accessed 2026-08-12)',
    'Public Health Agency of Canada: \'Safe Sleep for Your Baby\' — back to sleep every sleep, own crib/cradle/bassinet on a firm flat surface, room-sharing for the first 6 months, nothing soft in the sleep space (no blankets, pillows, bumper pads, sleep positioners, or stuffed toys). https://www.canada.ca/en/public-health/services/publications/healthy-living/safe-sleep-your-baby-brochure.html (accessed 2026-08-12)',
    'Mindell JA, Kuhn B, Lewin DS, Meltzer LJ, Sadeh A. \'Behavioral treatment of bedtime problems and night wakings in infants and young children\' — American Academy of Sleep Medicine review. Sleep. 2006;29(10):1263–1276 — 52 studies; 94% found behavioural interventions efficacious; strongest support for unmodified extinction and preventive parent education, with additional support for graduated extinction, bedtime fading/positive routines, and scheduled awakenings; >80% of children clinically improved across behavioural interventions, maintained 3–6 months',
    'Hiscock H, Wake M. \'Randomised controlled trial of behavioural infant sleep intervention to improve infant sleep and maternal mood.\' BMJ. 2002;324:1062 — controlled crying improved infant sleep at 2 months (not sustained vs control at 4 months); depression symptoms improved significantly only in mothers with EPDS ≥10 at 2 and 4 months (overall depression difference P=0.06)',
    'Hiscock H, Bayer J, Gold L, Hampton A, Ukoumunne OC, Wake M. \'Improving infant sleep and maternal mental health: a cluster randomised trial.\' Arch Dis Child. 2007;92(11):952–958 — parents at 8–10 months chose controlled comforting (graduated check-ins) or camping out (chair method); both delivered; fewer sleep problems (OR 0.58 at 10 months, 0.50 at 12 months) and lower maternal depression scores (adjusted mean difference −1.4 and −1.7) vs control',
    'Price AM, Wake M, Ukoumunne OC, Hiscock H. \'Five-Year Follow-up of Harms and Benefits of Behavioral Infant Sleep Intervention: Randomized Trial.\' Pediatrics. 2012;130(4):643–651 — at age 6 (69% follow-up, 225/326 families), no differences between sleep-trained and control children on emotional/behavioural scores, sleep, psychosocial functioning, parent-child relationship, or chronic stress (cortisol); the authors conclude behavioural sleep techniques have no marked long-lasting effects, positive or negative',
    'Gradisar M, Jackson K, Spurrier NJ, et al. \'Behavioral Interventions for Infant Sleep Problems: A Randomized Controlled Trial.\' Pediatrics. 2016;137(6):e20151486 — infants 6–16 months; graduated extinction and bedtime fading improved sleep vs control; salivary cortisol showed small-to-moderate DECLINES; no differences in attachment security or emotional/behavioural problems at 12-month follow-up',
  ],
  goDeeper: CREATORS.filter((creator) => creator.forTopics.includes('sleep')),
};

const POTTY_PLAYBOOK: CoachingPlaybook = {
  topic: 'Potty training (toilet learning), ages 20 months to 3.5 years',
  primaryMethod: {
    name: 'The 3-Day Method (intensive weekend — popularized by Lora Jensen)',
    what: 'An intensive reset: diapers end on day 1, and your child spends three days bare-bottomed at home learning to feel and act on their own body signals while you load fluids, watch closely, and rush every start to the potty. Popularized by mom-of-six Lora Jensen (\'3 Day Potty Training\'); the naked-then-commando progression comes from Jamie Glowacki\'s \'Oh Crap!\', and the behavioural core — extra fluids, massed practice, immediate praise — traces to Azrin and Foxx\'s 1974 rapid method. One honest note: this protocol deliberately departs from Jensen\'s original, which uses underwear (not bare-bottom) from day 1 and drops night diapers on day 1 too. We keep nights in a pull-up — CPS treats night dryness as a separate, later skill — and we gate the start on readiness signs, which Jensen does not.',
    why: 'Diapers are engineered to hide the feeling of being wet; removing them for a concentrated block lets a ready child connect urge to action fast. Intensive behavioural training is one of the two main approaches reviewed in American Family Physician 2019 (the Azrin-Foxx line — its published support comes from Azrin and Foxx\'s own 1970s trials; AFP\'s outcome data is for the child-led Brazelton line), and a focused start suits families who can hold three consistent days. The catch the evidence insists on: readiness gates the start. Beginning intensive training before about 27 months doesn\'t get you done sooner — early starters just train longer (Blum, Taubman & Nemeth, Pediatrics 2003) — and pressure on an unready child is the road to stool withholding.',
    how: 'Prep (this week): pick 3 clear days at home — a long weekend works. Put a potty in the room where you live, not just the bathroom. Stock salty snacks (crackers, pretzels) and drinks your child loves, plus easy-off pants. Brief every adult on the same scripts. Don\'t start if your child is constipated or a big change (new baby, move, new daycare) is landing — treat or wait first.\n\nDay 1: at wake-up, say goodbye to diapers — let your child help bag them up. "You\'re done with diapers. Now your pee and poop go in the potty." Naked from the waist down all day. Push fluids — water, milk, watery fruit, salty snacks to drive thirst — so there are lots of practice chances. Watch closely; the moment pee starts (the dance, the pause, the trickle), calmly carry them to the potty mid-stream: "Pee goes in the potty." Celebrate anything that lands. Prompt with statements, not questions: "Tell me when you need to go," not "Do you need to go?" Nap and night in a pull-up you call "sleeping pants" — nights are a separate, later skill.\n\nAccident script, every time, flat and warm: "You peed on the floor. Pee goes in the potty. Let\'s clean it up together." Then a quick sit to finish. No sighing, no scolding, ever.\n\nDay 2: same, still bare-bottomed at home. After one successful pee, take one short outing (20–40 minutes), commando — loose pants, no underwear — potty in the car.\n\nDay 3: repeat with a longer outing. Prompt at transitions: after waking, before leaving, before meals.\n\nWeeks 2–4: stay commando (underwear feels like a diaper to little bodies). Keep fibre and fluids up and watch for poop-holding.\n\nBail-out rule: if by the end of day 3 nothing has landed in the potty, or your child is panicking or refusing, stop cheerfully, return to diapers, and retry in 4–6 weeks. That\'s information about readiness, not a failure.',
    ageGate: '20 months to 3.5 years — and the readiness signs gate the start, not the birthday. CPS: some children are ready at 18 months, but most start between 2 and 4; girls are often ready earlier than boys (about 24–26 vs 29 months, AFP 2019). Starting intensive training before ~27 months brings no earlier finish (Blum 2003). Jensen herself pitches starting around 22 months and claims essentially all children are ready by then — a claim we don\'t adopt; here the signs gate the start, not the calendar. Never start a constipated child, or during a major upheaval.',
    expectations: 'Three good days typically buys \'pees in the potty with prompting\' — not \'done.\' Accidents continue for weeks; CPS counts on 3–6 months before a child is reliably out of daytime diapers. Poop usually lags pee — about 1 in 5 children go through a stool-refusal phase (Taubman 1997); it\'s handled with patience, fibre, and zero pressure. Naps and nights are a separate skill that can come months or years later — don\'t chase night dryness now. Regression after stress (new sibling, illness, move) is normal: go back to basics calmly for a few days, or back to diapers without shame and retry in a few weeks.',
  },
  // '20 months to 3.5 years'.
  ageBound: { minMonths: 20, maxMonths: 42 },
  alternativeMethod: {
    name: 'Gradual, child-led toilet learning (Brazelton\'s child-oriented approach — the CPS default)',
    what: 'Over weeks to months, the potty appears early as ordinary furniture: your child sits on it clothed, then bare, then you catch routine-time pees and poops, with diapers still on in between and your child setting the pace. Praise effort, skip pressure and (per CPS) skip rewards; move to training pants after about a week of steady success. Outcome data: 61% of children trained by 36 months and 98% by 48 months in a 482-child prospective cohort (Taubman 1997).',
    whenPreferred: 'When you can\'t clear three consistent days; when readiness signs are only partial or your child is under about 2; when your child is anxious, slow-to-warm, or a previous intensive attempt ended in tears or refusal; after any potty fear or stool-withholding episode (pressure is contraindicated there); and when care is split across homes or daycares that can\'t hold one tight protocol.',
  },
  readinessSigns: [
    'Stays dry in the diaper for several hours (CPS) — a 2-hour dry stretch is the common clinical benchmark (AFP/AAP) — or wakes dry from naps: the bladder can hold.',
    'Knows when it\'s happening: pauses, squats, hides behind the couch, or tells you mid-poop — body-signal awareness is the core skill.',
    'Can walk to the potty, sit steadily and balanced on it, and help pull pants down and up (CPS).',
    'Follows simple instructions and has a word or sign for pee and poop (CPS).',
    'Shows interest: follows you into the bathroom, likes potty books, asks about underwear, dislikes sitting in a dirty diaper (CPS).',
    'Poops are soft, regular, and roughly predictable — a constipated child is not ready until the constipation is treated.',
    'Wants to do things independently (\'me do it\') — CPS lists desire for independence as a readiness marker.',
    'The calendar is calm: no new sibling, move, daycare change, or illness in the launch window.',
  ],
  neverDo: [
    'Never punish, scold, shame, or visibly react with disgust to an accident — CPS says do not punish or overreact, and AFP 2019 says negative language and punishment should be avoided; the broader continence literature links punitive training with stool withholding, constipation, and voiding problems. The accident script stays neutral, every single time.',
    'Never restrict fluids to prevent accidents. This method runs on more fluids, not fewer; withholding drinks risks dehydration and constipation.',
    'Never force, restrain, or physically hold a child on the potty, and never require them to sit until they produce.',
    'Never start — or keep pushing — while pooping is painful or your child is constipated. Pain creates withholders; treat constipation with your provider first.',
    'Never treat stool withholding as defiance. A child who stops pooping for days has a medical problem forming, not an attitude problem.',
    'Never let day 3 become a deadline you enforce on the child. If it\'s clearly failing, stop cheerfully and retry in 4–6 weeks — escalating pressure is how a stalled weekend becomes a months-long battle.',
  ],
  doctorTriggers: [
    'No daytime toilet use at all by the 4th birthday (CPS threshold for seeing a physician).',
    'Regression after 6+ months of reliable success (CPS flag), especially with no obvious stressor.',
    'Stool withholding: no poop for 3+ days during training, very large, hard, or painful stools, or smears and leaks in underwear — possible constipation heading toward encopresis.',
    'Blood in the stool, or pain when using the potty (CPS); blood in urine also warrants a call (general guidance).',
    'UTI signs: fever with urinary symptoms, foul-smelling urine, crying when peeing, or sudden tiny frequent pees.',
    'Bladder red flags: constant dribbling, a weak or straining stream, or a child past 3 who never manages a 2-hour dry stretch.',
    'No urine at all for 8+ hours, or new extreme thirst with unusually large urine volumes.',
    'Persistent panic or fear of the potty that doesn\'t ease over weeks, or a child with a developmental difference whose progress plateaus — the plan needs professional tailoring, not more repetitions.',
  ],
  sources: [
    'Canadian Paediatric Society, Caring for Kids: \'Toilet learning\' handout (last updated March 2023) — the operative CPS source: readiness signs, 18-month-to-4-year range, 3–6 month timeline, no-punishment rule, regression guidance, when-to-see-a-doctor list. https://caringforkids.cps.ca/handouts/behavior-and-development/toilet_learning',
    'Clifford T, Gorodzinsky FP; Canadian Paediatric Society, Community Paediatrics Committee. \'Toilet learning: anticipatory guidance with a child-oriented approach.\' Paediatrics & Child Health. 2000;5(6):333–335 — historical position statement; no longer listed among current CPS statements, so the March 2023 Caring for Kids handout above is the operative CPS guidance.',
    'Blum NJ, Taubman B, Nemeth N. \'Relationship between age at initiation of toilet training and duration of training: a prospective study.\' Pediatrics. 2003;111(4 Pt 1):810–814 — intensive training begun before 27 months does not finish sooner; early start not linked to constipation or refusal.',
    'Taubman B. \'Toilet training and toileting refusal for stool only: a prospective study.\' Pediatrics. 1997;99(1):54–58 — 22% stool-refusal incidence; 61% trained by 36 months and 98% by 48 months under the child-oriented approach (n=482).',
    'Brazelton TB. \'A child-oriented approach to toilet training.\' Pediatrics. 1962;29(1):121–128 — original child-led method, 1,170-child practice series.',
    'Baird DC, Bybel M, Kowalski AW. \'Toilet Training: Common Questions and Answers.\' American Family Physician. 2019;100(8):468–474 — Brazelton vs Azrin-Foxx review (outcome data for the Brazelton line), girls-before-boys readiness ages, avoid negative language and punishment, encopresis workup.',
    'Kiddoo DA. \'Toilet training children: when to start and how to train.\' CMAJ. 2012;184(5):511–512 — Canadian clinical review of timing and methods.',
    'Jensen L. \'3 Day Potty Training\' (self-published ebook; 2014 edition) — method source, non-clinical: diaper toss ritual, statements-not-questions prompting. Note: Jensen\'s original trains day AND night from day 1 in underwear (not bare-bottom) and claims all children are ready by ~22 months without a readiness gate — this playbook deliberately departs from those elements.',
    'Glowacki J. \'Oh Crap! Potty Training.\' Touchstone, 2015 — naked-then-commando block progression, non-clinical method source.',
    'Azrin NH, Foxx RM. \'Toilet Training in Less Than a Day.\' Simon & Schuster, 1974 — behavioural basis of intensive methods (increased fluids, massed practice, immediate reinforcement); published support is Azrin and Foxx\'s own 1970s trials.',
  ],
  goDeeper: CREATORS.filter((creator) => creator.forTopics.includes('potty')),
};

const SOLIDS_PLAYBOOK: CoachingPlaybook = {
  topic: 'Starting solids and allergen introduction, 4-12 months (Canada: Health Canada / CPS guidance)',
  primaryMethod: {
    name: 'Iron-first solids with early-and-often allergen introduction',
    what: 'Start solid food at about 6 months with iron-rich foods twice a day (meat, poultry, fish, cooked egg, tofu, well-cooked lentils and beans, iron-fortified infant cereal), then work through the common allergenic foods one at a time, in baby-safe forms. CPS and CSACI focus on peanut, cooked egg, cow\'s milk protein, sesame, fish, and wheat; Health Canada\'s priority allergen list also includes tree nuts, soy, shellfish (crustaceans and molluscs), and mustard. Keep each one in the rotation about twice a week once tolerated. Textures move from smooth to lumpy to soft finger foods, with lumpy on board no later than 9 months.',
    why: 'Two clocks are running. First, the iron a baby banked before birth runs low around 6 months, which is why Health Canada and CPS name iron-rich foods as the first foods, twice a day or more. Second, waiting on allergens doesn\'t protect — it backfires. The LEAP trial (NEJM 2015) found roughly 80% less peanut allergy in high-risk infants who ate peanut early and regularly instead of avoiding it, and the EAT trial (NEJM 2016) pointed the same way for egg. CPS now recommends introducing allergenic foods at around 6 months (never before 4), at home, one at a time, with no allergy testing needed first — and keeping exposure regular, because introducing a food and then dropping it can increase risk rather than reduce it.',
    how: 'Day 1: pick a calm moment when baby is rested and a little hungry, sit them fully upright in a high chair, and offer a spoon or two of one iron-rich food — iron-fortified oat cereal mixed with breast milk or formula, puréed well-cooked beef, or mashed lentils. Most of it will end up on the tray. That\'s a win.\n\nDays 2-7: build to iron-rich food twice a day. Add puréed or mashed vegetables and fruit alongside. Breast milk or formula continues as usual — solids add to milk right now, they don\'t replace it.\n\nWeek 2, first allergen — peanut: in the morning, thin half a teaspoon of smooth peanut butter with warm water, breast milk, or a purée baby already tolerates (never a glob of straight peanut butter, never whole nuts). Give a small taste on the tip of the spoon, then wait about 10 minutes; if all\'s well, feed the rest. Keep baby where you can see them for the next two hours. No other new foods that day.\n\nThe next day, or the day after: well-cooked egg — hard-scrambled or mashed hard-boiled. Same routine: morning, small first taste, wait about 10 minutes, watch.\n\nKeep going, one new allergenic food per day — waiting a day or two between them is fine, but there\'s no need to space them out by several days (CPS): plain yogurt or cheese (cow milk in food — not as a drink yet), wheat (infant cereal, toast strips), soy (mashed tofu), sesame (tahini stirred into purée), tree nuts (thinned nut butters, one nut at a time), fish (well-cooked, deboned, flaked), shellfish if your family eats it, and mustard if it\'s part of your family\'s cooking. Once a food is tolerated, feed it about twice a week from then on — stopping can undo the protection.\n\nBy 9 months: lumpy, mashed, and soft finger foods, not just smooth purées — soft strips baby can grip.\n\n9-12 months: soft chopped family food, roughly three meals plus snacks, practice with an open cup. Whole (3.25%) cow milk as a drink can start in this window if you\'re moving off breast milk or formula.\n\nOnly allergens need the one-new-food-per-day pacing — fruits, vegetables, and grains can come as fast as baby is interested.',
    ageGate: 'Start at about 6 months, when baby shows readiness signs — never before 4 months, and don\'t drift much past 6 (waiting raises iron-deficiency risk, and delaying allergens raises allergy risk). Lumpy textures no later than 9 months. Aim to have the common allergenic foods introduced and in regular rotation before 12 months. Cow milk as a drink: 9-12 months at the earliest, whole (3.25%) only. Premature babies: timing goes by corrected age — ask your provider.',
    expectations: 'Gagging is normal and is not choking: gagging is noisy — coughing, sputtering, red face — while baby works food forward and keeps breathing; choking is silent. Gagging fades with practice over the first weeks. Refusal is normal too — some babies need to try a food many times before accepting it (CPS), so a turned head today means try again another day, not never. First servings are tiny; milk stays the main source of nutrition well into the 9-12 month stretch. Stools will change colour and texture — expected. On allergens: mild reactions (a few hives near the mouth, some spit-up) are uncommon, and CPS is explicit that the risk of a severe reaction on a first home exposure is extremely low — that\'s why home introduction without prior testing is the standard recommendation. Expect mess; mess is the method.',
  },
  // 'never before 4 months'. No upper bound is stated for STARTING solids, so none
  // is invented here - a late start is still this plan.
  ageBound: { minMonths: 4, maxMonths: null },
  alternativeMethod: {
    name: 'Baby-led weaning (BLISS-style soft finger foods)',
    what: 'Skip the spoon-and-purée stage: from 6 months, baby self-feeds soft, graspable pieces of family food — well-cooked vegetable strips, soft ripe fruit, toast fingers, tender strips of meat — with an iron-rich food offered at every meal and choking-hazard shapes strictly excluded. In the BLISS randomized trial this modified approach produced no more choking than spoon-feeding (Fangupo, Pediatrics 2016) and similar growth (Taylor, JAMA Pediatrics 2017). The allergen schedule, the never-list, and lumpy-by-9-months all still apply — allergens just arrive as self-fed foods (thin peanut butter on a toast strip, egg strips) instead of on a spoon.',
    whenPreferred: 'When baby is a strong independent sitter with good hand-to-mouth control at 6 months or later, the family eats meals together and wants baby at the table from day one, and parents are comfortable riding out the (normal, noisy) gagging phase. Less suited to babies with developmental or motor delays affecting sitting or grasp, or babies born preterm who aren\'t yet at that stage — ask your provider first in those cases. Health Canada explicitly supports self-feeding and finger foods from 6 months, so this is a style choice, not a safety trade-off — provided the iron-at-every-meal and no-choking-shapes rules hold.',
  },
  readinessSigns: [
    'Sits up in a high chair without support, with steady head and neck control',
    'Leans forward and opens their mouth when food comes their way',
    'Picks up food and tries to bring it to their mouth',
    'Holds food in their mouth without pushing it right back out with their tongue',
    'Watches others eat with real interest',
    'Can tell you no — turns their head away or leans back when done (readiness includes being able to refuse)',
  ],
  neverDo: [
    'No honey before 12 months — not raw, not pasteurized, not baked into anything. Infant botulism risk (Health Canada).',
    'No solids of any kind before 4 months, ever — and allergens started only when baby is developmentally ready (around 6 months).',
    'No whole nuts, whole grapes, popcorn, raisins, gummy or hard candy, marshmallows, or fish with bones. Round foods (grapes, hot dogs) get sliced lengthwise; hard raw vegetables get grated or cooked soft. Whole nuts stay off the menu until about age 4 (INSPQ/provincial choking-prevention guidance).',
    'Nut butters never straight off the spoon in a glob — always thinned into purée or spread paper-thin on a toast strip or cracker.',
    'No cow milk as a drink before 9-12 months, and then only whole (3.25%); no skim or low-fat milk before age 2; no rice, almond, oat, or other plant beverages as the main milk under age 2.',
    'No added salt or sugar in baby\'s food, and no sugary drinks; juice isn\'t needed at all.',
    'Nothing unpasteurized — no raw milk, no raw-milk cheese, no unpasteurized juice or cider.',
    'Never leave a baby alone with food — always supervised, always sitting upright. No eating in a moving car, in a reclined seat, or while crawling or walking around (supervision and upright seating per CPS; the moving-vehicle rule per INSPQ/provincial guidance).',
    'No cereal or solids in the bottle.',
    'Don\'t introduce an allergen and then shelve it — irregular exposure after introduction can increase allergy risk rather than reduce it. If you start, keep it regular (about twice a week).',
  ],
  doctorTriggers: [
    'Call 911 now, not the doctor: trouble breathing or noisy breathing, wheeze, repetitive cough, swelling of tongue, lips, or throat, widespread hives, repeated vomiting, or baby becoming pale, floppy, or unusually drowsy after eating — signs of anaphylaxis.',
    'Any milder suspected reaction to a food — a few hives, a spreading rash beyond simple around-the-mouth food irritation, vomiting tied to one food: stop that food and see your provider before offering it again.',
    'Baby has moderate-to-severe eczema or an already-diagnosed food allergy: talk to your provider before starting allergen introduction. CPS guidance supports early introduction even for high-risk babies, without testing first — the visit makes it guided, not delayed.',
    'A true choking episode (silent, needed back blows or other intervention): get baby checked and review food prep before continuing.',
    'Blood in stool, or ongoing vomiting or diarrhea after cow-milk-containing foods — possible cow\'s milk protein issue.',
    'No readiness signs by about 7 months, refusing all solids by 8-9 months, still unable to manage lumpy textures by around 10 months, gagging that isn\'t improving, or any concern about weight gain — these end self-serve coaching and go to the provider. (These month-marks are Hale\'s coaching thresholds for when to escalate, not official CPS/Health Canada cutoffs.)',
    'Baby was born preterm: confirm start timing (corrected age) with your provider before beginning.',
  ],
  sources: [
    'Health Canada, Canadian Paediatric Society, Dietitians of Canada & Breastfeeding Committee for Canada — Nutrition for Healthy Term Infants: Recommendations from Six to 24 Months (joint statement, April 2014; current guidance on canada.ca) — iron-rich first foods, lumpy textures no later than 9 months, cow milk delayed to 9-12 months (whole 3.25%, ~750 mL/day cap after 12 months), no honey under 1 year, little or no added salt or sugar, pasteurized products only. https://www.canada.ca/en/health-canada/services/canada-food-guide/resources/nutrition-healthy-term-infants/nutrition-healthy-term-infants-recommendations-birth-six-months/6-24-months.html',
    'Canadian Paediatric Society, Caring for Kids — Feeding your baby in the first year (last updated January 2020) — readiness signs, iron-rich foods at least twice per day, no more than one new allergenic food per day (waiting a day or two is fine), continue a few times a week, thinned peanut butter method, babies may need to try a food many times before accepting it, choking-hazard list and mealtime safety rules (supervised, sitting upright). https://caringforkids.cps.ca/handouts/pregnancy-and-babies/feeding_your_baby_in_the_first_year',
    'Abrams EM, Hildebrand K, Blair B, Chan ES — Timing of introduction of allergenic solids for infants at high risk, CPS practice point (posted January 24, 2019; updated February 19, 2020) — high-risk definition (personal atopy or first-degree relative), around 6 months and not before 4, one at a time without unnecessary delay, dilute smooth peanut butter, small first amount on the tip of a spoon then wait about 10 minutes before continuing, few-times-a-week maintenance. https://cps.ca/en/documents/position/allergenic-solids',
    'Abrams EM, Orkin J, Cummings C, Blair B, Chan ES — Dietary exposures and allergy prevention in high-risk infants, CPS/CSACI joint statement (December 17, 2021) — early home introduction, pre-emptive screening not recommended, risk of severe first-exposure reaction extremely low, regular ongoing ingestion a few times a week; names peanut, cooked egg, cow\'s milk protein, sesame, fish, and wheat as priority allergenic foods. https://cps.ca/en/documents/position/dietary-exposures-and-allergy-prevention',
    'Health Canada — Common food allergens (priority food allergen list, canada.ca) — the priority allergens include peanut, egg, milk, tree nuts, soy, wheat, sesame, fish, crustaceans and molluscs, and mustard. https://www.canada.ca/en/health-canada/services/food-nutrition/food-safety/food-allergies-intolerances/food-allergies.html',
    'Du Toit G, et al. — Randomized Trial of Peanut Consumption in Infants at Risk for Peanut Allergy (LEAP), New England Journal of Medicine 2015;372:803-813 — ~80% relative reduction in peanut allergy with early regular peanut ingestion in high-risk infants. https://www.nejm.org/doi/full/10.1056/NEJMoa1414850',
    'Perkin MR, et al. — Randomized Trial of Introduction of Allergenic Foods in Breast-Fed Infants (EAT), New England Journal of Medicine 2016;374:1733-1743 (May 5, 2016) — six allergenic foods from 3 months in 1,303 breastfed infants; per-protocol benefit for peanut and egg; early introduction safe. https://www.nejm.org/doi/full/10.1056/NEJMoa1514210',
    'Abrams EM, Singer AG, Chan ES — Food allergy prevention with early food introduction, Canadian Family Physician 2019;65(9):637-638 — one allergen at a time, no need to space new foods out by several days but more than one new allergen per day muddies attribution; infrequent feeding after introduction may increase risk. https://pmc.ncbi.nlm.nih.gov/articles/PMC6741790/',
    'Williams BA, Hughes C, Chan ES, Erdle SC — Early allergen introduction for infants: Tips for breastfeeding parents with food allergies themselves, Paediatrics & Child Health 2025;30(6):450-452 — feed tolerated allergens regularly, at least once and ideally twice or more per week; peanut powder in oatmeal/yogurt as an infant-safe form. https://pmc.ncbi.nlm.nih.gov/articles/PMC12495509/',
    'FAMP-IT (CSACI-aligned early allergen introduction tool) — at least one adult available to watch baby for at least two hours after ingestion of a newly introduced allergen; start small and scale up.',
    'Institut national de santé publique du Québec (INSPQ) — Mieux vivre avec notre enfant / provincial infant-feeding and choking-prevention guidance — whole nuts delayed until about age 4; no eating in a moving vehicle.',
    'Fangupo LJ, et al. — A Baby-Led Approach to Eating Solids and Risk of Choking, Pediatrics 2016;138(4):e20160772 — modified baby-led weaning (BLISS) showed no increase in choking vs usual care when hazard foods are excluded. https://publications.aap.org/pediatrics/article-abstract/138/4/e20160772/52372/',
    'Taylor RW, et al. — Effect of a Baby-Led Approach to Complementary Feeding on Infant Growth and Overweight (BLISS RCT), JAMA Pediatrics 2017;171(9):838-846 — growth outcomes comparable to traditional spoon-feeding.',
  ],
  goDeeper: CREATORS.filter((creator) => creator.forTopics.includes('solids')),
};

const PLAYBOOKS: Record<PlaybookTopic, CoachingPlaybook> = {
  sleep: SLEEP_PLAYBOOK,
  potty: POTTY_PLAYBOOK,
  solids: SOLIDS_PLAYBOOK,
};

/** Whether a topic has a curated method playbook. The plan arc offers more topics than
 * this (tantrums, screen time, routines) and those have none — the caller decides what
 * to do about that rather than being handed an empty playbook to ground on. */
export function hasPlaybook(topic: string): topic is PlaybookTopic {
  return topic in PLAYBOOKS;
}

export function playbookFor(topic: PlaybookTopic): CoachingPlaybook {
  return PLAYBOOKS[topic];
}

/** Every name the composer may cite on this topic. The eval's fabrication gate reads
 * this same function, so "who may Hale name" has one answer rather than two that drift. */
export function goDeeperNames(topic: PlaybookTopic): readonly string[] {
  return PLAYBOOKS[topic].goDeeper.map((creator) => creator.name);
}
