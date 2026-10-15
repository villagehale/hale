// said-line eval fixtures (#868). The model writes lines that used to be fixed; the
// code only checks the facts (mustInclude verbatim, no other link). Wording is graded
// by a judge model: nothing here is a required or banned phrase.
//
// `language` is what production passes (replyLanguage(): 'en' unless the text proves
// French), so the ZH and AR rows send 'en' and the parent's own script must win.

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
];
