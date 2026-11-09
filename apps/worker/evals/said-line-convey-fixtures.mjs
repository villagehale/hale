// VIL-530 corpus for the mustConvey judge. Drafts are eval inputs, never a line
// Hale sends. The meaning string is the production fact (pinned to reply.ts by
// reply.test.ts via said-line-fixtures.mjs). Nothing here matches words in a draft.

import {
  INTRO_MUST_CONVEY,
  INTRO_REPLY_FACTS,
  REVOKE_BOTH_OFF,
  REVOKE_GOOGLE_ACCESS,
} from './said-line-fixtures.mjs';

export const CONVEY_SITUATION = 'discoverability_off';

/** The acknowledgement acceptSaidLine still allows. The judge must be able to omit it. */
export const ACK_ONLY = 'わかりました。';

export const SAID_LINE_CONVEY_FIXTURES = [
  {
    id: 'intro-off-ja-conveys',
    draft: '紹介はオフにしました。待っていたものは、全部閉じました。',
    expect: 'send',
  },
  {
    id: 'intro-off-ja-omits',
    draft: ACK_ONLY,
    expect: 'omit',
  },
  {
    id: 'intro-off-en-conveys',
    draft: 'Intros are off for you, and the ones that were waiting are closed.',
    expect: 'send',
  },
  {
    id: 'intro-off-en-omits',
    draft: 'Got it, intros are off for you.',
    expect: 'omit',
  },
  {
    id: 'intro-off-zh-conveys',
    draft: '介绍已经关掉了。之前等着的那些，都结束了。',
    expect: 'send',
  },
  {
    id: 'intro-off-zh-omits',
    draft: '好的，介绍已经关掉了。',
    expect: 'omit',
  },
  {
    id: 'intro-off-fr-conveys',
    draft: 'Les présentations sont coupées pour toi. Celles qui attendaient sont fermées.',
    expect: 'send',
  },
  {
    id: 'intro-off-fr-omits',
    draft: "D'accord, c'est noté.",
    expect: 'omit',
  },
  {
    id: 'intro-off-en-unrelated-closed',
    draft: 'The pool is closed today. Intros are off for you.',
    expect: 'omit',
  },
  // VIL-610: the same unrelated word with the meaning present must still send, and the
  // unrelated word in another language must still omit.
  {
    id: 'intro-off-en-unrelated-closed-conveys',
    draft:
      'The pool is closed today. Intros are off for you, and the ones that were waiting are closed too.',
    expect: 'send',
  },
  {
    id: 'intro-off-es-unrelated-closed',
    draft: 'La piscina está cerrada hoy. Las presentaciones están apagadas para ti.',
    expect: 'omit',
  },
  // VIL-156: a disconnect reply must say both services are off and what Google
  // confirmed. A draft naming only the calendar would tell a parent their Gmail is still
  // connected when it is not.
  {
    id: 'revoke-bothoff-en-conveys',
    draft:
      "Done. Gmail and Google Calendar are both off now, and Google has removed Hale's access to your account. Just ask here if you ever want either back.",
    facts: REVOKE_CONVEY_FACTS(),
    expect: 'send',
  },
  {
    id: 'revoke-bothoff-en-omits',
    draft: 'Done, your Google Calendar is disconnected.',
    facts: REVOKE_CONVEY_FACTS(),
    expect: 'omit',
  },
];

/** The two meanings a confirmed disconnect reply must carry (copy.ts, mustConvey). */
function REVOKE_CONVEY_FACTS() {
  return [
    { key: 'bothOff', meaning: REVOKE_BOTH_OFF },
    { key: 'googleAccess', meaning: REVOKE_GOOGLE_ACCESS.revoked },
  ];
}

export function conveyFacts() {
  const keys = INTRO_MUST_CONVEY[CONVEY_SITUATION] ?? [];
  const facts = INTRO_REPLY_FACTS[CONVEY_SITUATION];
  return keys.map((key) => ({ key, meaning: facts[key] }));
}

/** The meanings one fixture is judged on: its own, or intro off's by default. */
export function fixtureConveyFacts(fixture) {
  return fixture.facts ?? conveyFacts();
}

/** Same JSON the production user message must produce. The dry eval pins them. */
export function conveyUserMessage(draft, facts = conveyFacts()) {
  return JSON.stringify({ draft, mustConvey: facts });
}
