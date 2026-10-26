// said-line eval fixtures (#868). The model writes lines that used to be fixed; the
// code only checks the facts (mustInclude verbatim, no other link). Wording is graded
// by a judge model: nothing here is a required or banned phrase.
//
// `language` is the tag production stored for the family. The parent's own
// words still win when they are writing in another language.

export const IDENTITY_FACTS = {
  assistant: 'Hale',
  company: 'Village Hale Technologies Inc.',
  website: 'villagehale.com',
  accountablePerson: 'Barton Dong',
  contactEmail: 'aloha@villagehale.com',
};

const identity = (id, script, language, parentWords) => ({
  id,
  purpose: 'identity',
  script,
  language,
  parentWords,
  facts: { ...IDENTITY_FACTS },
  mustInclude: [IDENTITY_FACTS.website, IDENTITY_FACTS.contactEmail],
});

// Fixed tokens so the cache key is stable. Same shape as a real mint.
/** GOOGLE_UNVERIFIED_APP_FACT in text-connect.ts: structured, so there is no sentence to copy. */
const GOOGLE_CAUTION = {
  screen: 'unverified app',
  shownBy: 'Google',
  wayPast: ['Advanced', 'continue'],
};

const CAL = 'https://app.villagehale.com/connect?t=Q0FGRUJBQkVDQUZFQkFCRQ&to=gcal';
const GMAIL = 'https://app.villagehale.com/connect?t=R0FGRUJBQkVDQUZFQkFCRg&to=gmail';

const links = (id, language, parentWords) => ({
  id,
  purpose: 'connector_links',
  script: language,
  language,
  parentWords,
  // writeConnectorLinks: the model sees only slots; code fills the URLs (#868).
  facts: {
    calendarLink: '[[calendarLink]]',
    gmailLink: '[[gmailLink]]',
    minutesValid: 15,
    why: 'so Hale can spot daycare and school notices',
    // writeConnectorLinks in said-line.ts carries the same caution, in the parent's language.
    googleCaution: GOOGLE_CAUTION,
  },
  mustInclude: [],
  links: { calendarLink: CAL, gmailLink: GMAIL },
});

const plain = (id, purpose, language, parentWords) => ({
  id,
  purpose,
  script: language,
  language,
  parentWords,
  facts: {},
  mustInclude: [],
});

const ONE = 'https://app.villagehale.com/connect?t=U0FGRUJBQkVDQUZFQkFCRw&to=gcal';

/**
 * INTRO_REPLY_FACTS in apps/web/lib/village/intros/reply.ts, replicated (the eval cannot
 * reach the web app's `~/` alias). reply.test.ts pins this copy to the original, so a
 * drift fails a free unit test before it can mis-key the cache.
 */
const OTHER_FAMILY_UNSAID =
  'never say or hint anything about the other family, including whether they were asked or answered';

export const INTRO_REPLY_FACTS = {
  discoverability_on: {
    situation: 'they just agreed to be introduced to other Hale families nearby',
    shared:
      'nothing about them is shared with anyone until both families say yes to the same introduction',
    offRamp: 'they can switch introductions off any time by just saying so',
  },
  discoverability_off: {
    situation: 'they just switched introductions off; any pending ones are closed',
    next: 'Hale will not bring introductions up again',
  },
  discoverability_already_on: {
    situation: 'they had already said yes to introductions; nothing changed',
    next: 'Hale is still keeping an eye out',
  },
  discoverability_already_off: {
    situation: 'introductions were already off for them; nothing changed',
    next: 'Hale will not bring introductions up again',
  },
  intro_no: {
    situation: 'they said no to this one introduction; it is recorded',
    otherFamily: OTHER_FAMILY_UNSAID,
    next: 'Hale keeps looking for other matches',
  },
  intro_already_yes: {
    situation: 'they had already said yes to this introduction; nothing changed',
    otherFamily: OTHER_FAMILY_UNSAID,
    next: 'Hale tells them if it goes ahead',
  },
  intro_already_no: {
    situation: 'they had already passed on this introduction; nothing changed',
    otherFamily: OTHER_FAMILY_UNSAID,
    next: 'Hale keeps looking for other matches',
  },
  intro_closed: {
    situation: 'they said no to this introduction earlier, so it is closed and cannot be reopened',
    otherFamily: OTHER_FAMILY_UNSAID,
    next: 'Hale is still looking and will text them at the next good match',
  },
  no_open_intro: {
    situation: 'there is no introduction waiting for them right now',
    match: 'none - do not imply a match exists',
    next: 'Hale texts them when there is a match',
  },
  soft_close: {
    situation: 'the introduction Hale asked them about is not happening',
    reason: 'not given - never say or hint why, or anything about the other family',
    next: 'Hale keeps an eye out for another match',
  },
};

const intro = (id, script, situation, parentWords) => ({
  id,
  purpose: 'intro_reply',
  script,
  language: null,
  parentWords,
  facts: { ...INTRO_REPLY_FACTS[situation] },
  mustInclude: [],
});

function INTRO_REPLY_FIXTURES() {
  return [
    intro('intro-optin-zh', 'zh', 'discoverability_on', '好的，可以帮我介绍附近的家庭'),
    intro('intro-optout-ja', 'ja', 'discoverability_off', '紹介はもういらないです、やめてください'),
    intro('intro-no-es', 'es', 'intro_no', 'No, gracias, esta vez no'),
    intro('intro-closed-ar', 'ar', 'intro_closed', 'في الحقيقة نعم، أريد هذا التعارف'),
    intro('intro-no-open-fr', 'fr', 'no_open_intro', "Oui, je veux bien qu'on me présente"),
    intro('intro-already-yes-en', 'en', 'intro_already_yes', 'yes intro!! did you get that'),
    intro('intro-already-off-en', 'en', 'discoverability_already_off', 'no intros, I said'),
    // The sweep's soft close: no parent words, and the reason is never a fact.
    intro('intro-soft-close-en', 'en', 'soft_close', null),
  ];
}

export const SAID_LINE_FIXTURES = [
  identity('identity-en', 'en', 'en', 'who is this? how did you get my number'),
  identity('identity-fr', 'fr', 'fr', "c'est qui? vous êtes une arnaque?"),
  identity('identity-zh', 'zh', 'en', '你是谁？你怎么有我的电话号码？'),
  identity('identity-ar', 'ar', 'en', 'من أنت؟ كيف حصلت على رقمي؟'),
  links('links-en', 'en', 'send me the links to connect my calendar and gmail'),
  links('links-fr', 'fr', 'envoie-moi les liens pour connecter mon agenda et gmail'),
  plain(
    'not-posted-en',
    'not_posted',
    'en',
    'When does Hamilton swim registration open for winter?',
  ),
  plain(
    'no-source-en',
    'no_source',
    'en',
    'what is the current wait time for a family doctor in Ontario?',
  ),
  plain(
    'cheer-up-en',
    'cheer_up',
    'en',
    "i'm so tired, both kids sick all week and i haven't slept",
  ),
  {
    id: 'health-en',
    purpose: 'health',
    script: 'en',
    language: 'en',
    parentWords: 'my son fell off the couch and his wrist is swollen, should I ice it?',
    facts: { healthLine: 'Health811 (Ontario), call 811, any time', emergency: '911' },
    mustInclude: ['811', '911'],
  },
  {
    id: 'connector-link-en',
    purpose: 'connector_link',
    script: 'en',
    language: 'en',
    parentWords: 'connect my google calendar',
    facts: {
      service: 'Google Calendar',
      link: '[[link]]',
      minutesValid: 15,
      googleCaution: GOOGLE_CAUTION,
    },
    mustInclude: [],
    links: { link: ONE },
  },
  // writeGroupConnectAsk in said-line.ts: the group chat's ask, caution as a fact.
  {
    id: 'group-connect-ask-en',
    purpose: 'group_connect_ask',
    script: 'en',
    language: 'en',
    parentWords: null,
    facts: {
      name: 'Sam',
      service: 'Google Calendar',
      why: "their calendar joins the kids' year Hale keeps for the family",
      linkIsTheirs: 'the link is only for this parent, not the rest of the group',
      minutesValid: 15,
      inboxPrivate: null,
      link: '[[link]]',
      googleCaution: GOOGLE_CAUTION,
    },
    mustInclude: [],
    links: { link: ONE },
  },
  {
    id: 'group-connect-ask-fr',
    purpose: 'group_connect_ask',
    script: 'fr',
    language: 'fr',
    parentWords: null,
    facts: {
      name: 'Sam',
      service: 'Gmail',
      why: 'Hale would catch school and camp emails for them too',
      linkIsTheirs: 'the link is only for this parent, not the rest of the group',
      minutesValid: 15,
      inboxPrivate: 'nothing from their inbox is shown in the group chat',
      link: '[[link]]',
      googleCaution: GOOGLE_CAUTION,
    },
    mustInclude: [],
    links: { link: GMAIL },
  },
  // VIL-450: the intro lane's replies, which were fixed English lines in intros/copy.ts.
  ...INTRO_REPLY_FIXTURES(),
];
