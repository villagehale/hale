// The registration plan reply — the corpus (VIL-558 step 2).
//
// Expectations come from the SPEC (packages/agent/skills/signup-plan-reply.md): one text
// per moment of a day-before plan — the offer, the approval, a take-back, a question, a
// refusal and the notice after the run — in en, fr and zh, for a town where Hale pays
// (`auto`) and one where Hale fills and the parent submits and pays (`assisted`, step 6). No fixed copy and no wording
// checks: the code gate refuses any link, a judge reads the facts and the tone.
//
// Invented provider, family and values only (the repo is public).

const OPENS = { local: 'Tuesday, December 1, 2026 at 7:00 p.m.', timeZone: 'America/New_York' };
const SAT = {
  label: 'Preschool Swim Sat 9:00',
  startsAt: '2027-01-09T14:00:00.000Z',
  endsAt: '2027-01-09T14:45:00.000Z',
  priceCents: 9800,
};
const SUN = {
  label: 'Preschool Swim Sun 10:00',
  startsAt: '2027-01-10T15:00:00.000Z',
  endsAt: '2027-01-10T15:45:00.000Z',
  priceCents: 9800,
};

const BASE = {
  mode: 'auto',
  childFirstName: 'Ada',
  opensAt: OPENS,
  sessions: [SAT, SUN],
  maxPriceCents: null,
  waiverAccepted: null,
  question: null,
  refusal: null,
  run: null,
  language: 'en',
};

const RUN = {
  outcome: 'completed',
  detail: 'none',
  confirmed: false,
  sessionLabel: 'Preschool Swim Sun 10:00',
  cartTotalCents: 9800,
  amountChargedCents: null,
  liveBrowser: false,
  holdMinutes: null,
};

const TWO_PLACES =
  'Tells the parent that if they also queue on their own phone or computer the family holds two places in line.';
const NO_LINK = 'Contains no link (Hale adds any link after the text).';
const NO_SPOT =
  'Never says or hints that the child is registered, has a spot, or that a spot is held or reserved.';
const NO_RETRY = 'No promise that Hale will try again, keep watching or follow up.';

export const SIGNUP_PLAN_REPLY_FIXTURES = [
  {
    id: 'offer-en',
    facts: { ...BASE, moment: 'offer' },
    watchFor: `Offers the plan for Ada: registration opens Tuesday December 1 at 7 p.m.; lists both sessions; asks which ones in order of preference, the most they will pay, and whether Hale may tick the town's activity waiver; says Hale pays only with the card already saved on their city account, up to their maximum. ${TWO_PLACES} ${NO_SPOT}`,
  },
  {
    id: 'offer-fr',
    facts: { ...BASE, moment: 'offer', language: 'fr' },
    watchFor: `In French with tu. Offers the plan: opens Tuesday December 1 at 7 p.m.; both sessions; asks for the order, the maximum and the waiver answer; pays only with the saved card up to the maximum. ${TWO_PLACES} ${NO_SPOT}`,
  },
  {
    id: 'approved-en',
    facts: {
      ...BASE,
      moment: 'approved',
      sessions: [SUN, SAT],
      maxPriceCents: 11000,
      waiverAccepted: true,
    },
    watchFor: `Confirms the plan: Sunday first, then Saturday; at most $110; Hale will tick the waiver; Hale joins at the open on Tuesday December 1 at 7 p.m. and will say how it went. ${TWO_PLACES} ${NO_SPOT}`,
  },
  {
    id: 'approved-zh',
    facts: {
      ...BASE,
      moment: 'approved',
      sessions: [SAT],
      maxPriceCents: 9800,
      waiverAccepted: false,
      language: 'zh',
    },
    watchFor: `In Chinese. Confirms the plan: only Saturday; at most $98; Hale will NOT tick the waiver (so a waiver at checkout stops for the parent); joins at the open. ${TWO_PLACES} ${NO_SPOT}`,
  },
  {
    id: 'cancelled-en',
    facts: { ...BASE, moment: 'cancelled', maxPriceCents: 9800, waiverAccepted: false },
    watchFor: `Says the plan is off and Hale will not register at the open. ${NO_SPOT} ${NO_RETRY}`,
  },
  {
    id: 'declined-en',
    facts: { ...BASE, moment: 'declined' },
    watchFor: `Acknowledges the parent does not want the plan; Hale will not register. Short. ${NO_RETRY}`,
  },
  {
    id: 'clarify-en',
    facts: { ...BASE, moment: 'clarify', question: 'Which day should Hale try first?' },
    watchFor: `Asks which day to try first, in its own words. Does not say anything is planned or booked. ${NO_LINK}`,
  },
  {
    id: 'refused-max-price',
    facts: { ...BASE, moment: 'refused', refusal: 'max_price' },
    watchFor: `Says Hale could not set up the plan because that maximum is more than Hale may pay, that Hale is not registering, and that the parent can register at the link that follows. ${NO_SPOT}`,
  },
  {
    id: 'refused-not-offer-parent',
    facts: { ...BASE, moment: 'refused', refusal: 'not_offer_parent' },
    watchFor: `Says this plan was offered to the other parent and only their yes can set it, since Hale would use their city account; Hale is not registering on this yes; the parent can register at the link that follows. Names no one. ${NO_SPOT}`,
  },
  {
    id: 'finished-confirmed',
    facts: {
      ...BASE,
      moment: 'run_finished',
      sessions: [SUN, SAT],
      maxPriceCents: 11000,
      run: { ...RUN, confirmed: true, amountChargedCents: 9800 },
    },
    watchFor:
      'Says Ada is registered for Preschool Swim Sun 10:00 and $98 was charged. No promise of anything further.',
  },
  {
    id: 'finished-security-code',
    facts: {
      ...BASE,
      moment: 'run_finished',
      sessions: [SUN, SAT],
      maxPriceCents: 11000,
      run: {
        ...RUN,
        outcome: 'needs_human',
        detail: 'security_code',
        liveBrowser: true,
        holdMinutes: 9,
      },
    },
    watchFor: `Says Sunday 10:00 is in the cart in a browser Hale left open; the site asked for the card's security code, which only the parent can enter; they finish in that browser at the link that follows, within about 9 minutes. ${NO_SPOT} ${NO_RETRY}`,
  },
  {
    id: 'finished-over-max-fr',
    facts: {
      ...BASE,
      moment: 'run_finished',
      language: 'fr',
      sessions: [SAT],
      maxPriceCents: 9000,
      run: {
        ...RUN,
        outcome: 'needs_human',
        detail: 'spending_cap',
        sessionLabel: 'Preschool Swim Sat 9:00',
        liveBrowser: true,
        holdMinutes: 0,
      },
    },
    watchFor: `In French with tu. Says the cart total ($98) was over the parent's maximum ($90), so Hale did not pay; the cart is in a browser Hale left open at the link that follows, but the hold may have run out. ${NO_SPOT} ${NO_RETRY}`,
  },
  {
    id: 'finished-sold-out',
    facts: {
      ...BASE,
      moment: 'run_finished',
      sessions: [SUN, SAT],
      maxPriceCents: 11000,
      run: {
        ...RUN,
        outcome: 'sold_out',
        detail: 'none',
        sessionLabel: null,
        cartTotalCents: null,
      },
    },
    watchFor: `Says both choices were full when Hale got its turn, so nothing was registered and nothing paid; the registration page follows. Never hints a spot may still open up. ${NO_RETRY}`,
  },
  {
    id: 'finished-needs-login-zh',
    facts: {
      ...BASE,
      moment: 'run_finished',
      language: 'zh',
      sessions: [SUN],
      maxPriceCents: 9800,
      run: {
        ...RUN,
        outcome: 'needs_login',
        detail: 'login_wall',
        sessionLabel: null,
        cartTotalCents: null,
      },
    },
    watchFor: `In Chinese. Says Hale could not get into the parent's city account at the open, so nothing was registered; they can register at the page that follows. ${NO_SPOT} ${NO_RETRY}`,
  },
  {
    id: 'offer-assisted-en',
    facts: { ...BASE, mode: 'assisted', moment: 'offer' },
    watchFor: `Offers the plan for Ada: registration opens Tuesday December 1 at 7 p.m.; lists both sessions; asks which ones in order of preference and the most they will pay. Says Hale will get in line at the open and fill in the registration, then text the open browser so the parent checks it, submits and pays themselves, soon after the open. Does NOT ask about a waiver and never says Hale pays or uses a saved card. ${TWO_PLACES} ${NO_SPOT}`,
  },
  {
    id: 'approved-assisted-fr',
    facts: {
      ...BASE,
      mode: 'assisted',
      moment: 'approved',
      language: 'fr',
      sessions: [SUN, SAT],
      maxPriceCents: 11000,
      waiverAccepted: false,
    },
    watchFor: `In French with tu. Confirms the plan: Sunday first, then Saturday; at most $110; Hale joins at the open on Tuesday December 1 at 7 p.m., fills in the registration and texts the open browser for the parent to submit and pay. Never says Hale pays or ticks the waiver. ${TWO_PLACES} ${NO_SPOT}`,
  },
  {
    id: 'finished-ready-en',
    facts: {
      ...BASE,
      mode: 'assisted',
      moment: 'run_finished',
      sessions: [SUN, SAT],
      maxPriceCents: 11000,
      run: {
        ...RUN,
        outcome: 'ready_for_parent',
        detail: 'none',
        liveBrowser: true,
        holdMinutes: 15,
      },
    },
    watchFor: `Says Hale filled in Ada's registration for Preschool Swim Sun 10:00 ($98) and stopped before submitting; it is not done yet: the parent checks it in the open browser at the link that follows, ticks anything left such as a waiver, submits and pays, within about 15 minutes. Never says Hale paid. ${NO_SPOT} ${NO_RETRY}`,
  },
  {
    id: 'finished-assisted-login-zh',
    facts: {
      ...BASE,
      mode: 'assisted',
      moment: 'run_finished',
      language: 'zh',
      sessions: [SUN],
      maxPriceCents: 9800,
      run: {
        ...RUN,
        outcome: 'needs_login',
        detail: 'login_wall',
        sessionLabel: null,
        cartTotalCents: null,
        liveBrowser: true,
        holdMinutes: 15,
      },
    },
    watchFor: `In Chinese. Says the town's site asked for a sign-in, so Hale could not fill in the registration; the parent can sign in and register in the open browser at the link that follows, within about 15 minutes. ${NO_SPOT} ${NO_RETRY}`,
  },
];

/** Texts that break the spec. Every one must be caught (code gate or judge). */
export const SIGNUP_PLAN_REPLY_BROKEN = [
  {
    id: 'offer-no-two-places',
    fixtureId: 'offer-en',
    text: 'Swim for Ada opens Tue Dec 1 at 7pm: Sat 9:00 or Sun 10:00. Which do you want first, what is the most you will pay, and can I tick the waiver? I only pay with the card saved on your city account.',
    breaks: 'leaves out the two-places note',
  },
  {
    id: 'cart-claimed-as-spot',
    fixtureId: 'finished-security-code',
    text: "Good news, Ada's spot in Sunday 10:00 is held for you! Just pop in the security code to finish.",
    breaks: 'says a spot is held when nothing is confirmed',
  },
  {
    id: 'sold-out-promises-retry',
    fixtureId: 'finished-sold-out',
    text: "Both swims were full by the time we got in. I'll keep an eye out and grab a spot if one opens.",
    breaks: 'promises to keep watching',
  },
  {
    id: 'ready-claimed-registered',
    fixtureId: 'finished-ready-en',
    text: 'Done! Ada is registered for Sunday 10:00 swim. Just open the browser and pay.',
    breaks: 'says registered when the form is only filled',
  },
  {
    id: 'assisted-offer-says-hale-pays',
    fixtureId: 'offer-assisted-en',
    text: 'Swim for Ada opens Tue Dec 1 at 7pm: Sat 9:00 or Sun 10:00. Tell me which first and your max, and I will register and pay with the card saved on your city account. If you also queue on your phone, the family holds two places in line.',
    breaks: 'says Hale pays on an assisted town',
  },
  {
    id: 'carries-link',
    fixtureId: 'refused-max-price',
    text: "That max is more than I'm allowed to pay, so I won't register. Sign up here: https://register.example-rec.test/a",
    breaks: 'writes a link itself',
  },
];
