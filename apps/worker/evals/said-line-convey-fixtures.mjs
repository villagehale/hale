// VIL-530 corpus for the mustConvey judge. Drafts are eval inputs, never a line
// Hale sends. The meaning string is the production fact (pinned to reply.ts by
// reply.test.ts via said-line-fixtures.mjs). Nothing here matches words in a draft.

import { INTRO_MUST_CONVEY, INTRO_REPLY_FACTS } from './said-line-fixtures.mjs';

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
];

export function conveyFacts() {
  const keys = INTRO_MUST_CONVEY[CONVEY_SITUATION] ?? [];
  const facts = INTRO_REPLY_FACTS[CONVEY_SITUATION];
  return keys.map((key) => ({ key, meaning: facts[key] }));
}

/** Same JSON the production user message must produce. The dry eval pins them. */
export function conveyUserMessage(draft) {
  return JSON.stringify({ draft, mustConvey: conveyFacts() });
}
