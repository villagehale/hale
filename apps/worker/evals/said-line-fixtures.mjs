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
const CAL = 'https://app.villagehale.com/connect?t=Q0FGRUJBQkVDQUZFQkFCRQ&to=gcal';
const GMAIL = 'https://app.villagehale.com/connect?t=R0FGRUJBQkVDQUZFQkFCRg&to=gmail';

const links = (id, language, parentWords) => ({
  id,
  purpose: 'connector_links',
  script: language,
  language,
  parentWords,
  facts: {
    calendarLink: CAL,
    gmailLink: GMAIL,
    minutesValid: 15,
    why: 'so Hale can spot daycare and school notices',
  },
  mustInclude: [CAL, GMAIL],
});

export const SAID_LINE_FIXTURES = [
  identity('identity-en', 'en', 'en', 'who is this? how did you get my number'),
  identity('identity-fr', 'fr', 'fr', "c'est qui? vous êtes une arnaque?"),
  identity('identity-zh', 'zh', 'en', '你是谁？你怎么有我的电话号码？'),
  identity('identity-ar', 'ar', 'en', 'من أنت؟ كيف حصلت على رقمي؟'),
  links('links-en', 'en', 'send me the links to connect my calendar and gmail'),
  links('links-fr', 'fr', 'envoie-moi les liens pour connecter mon agenda et gmail'),
];
