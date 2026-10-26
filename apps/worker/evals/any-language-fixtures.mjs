// Any language (Barton, 2026-10-25: Hale supports any language). RECORDED 2026-10-25 (Barton OK 8:56 PM).
//
// One calendar change is waiting. Each parent answers in their own language, once plainly
// and once with a hedge. Two readers are scored, both on the real skills:
//   1. reply-resolver: a plain yes resolves; a hedged yes comes back as an ask-back
//      (below_grade), never a write. Scored on the structured reading, not on words.
//   2. signup-consent: a hedged answer to a signup offer gets one question back, and a
//      model judge checks it is in the parent's language and settles the offer. No word
//      matching anywhere.

export const ANY_LANGUAGE_FIXTURES = [
  { id: 'en-plain', language: 'English', text: 'yes please, go ahead', kind: 'plain' },
  { id: 'en-hedged', language: 'English', text: 'hmm I guess so? probably ok', kind: 'hedged' },
  { id: 'fr-plain', language: 'French', text: 'oui, vas-y stp', kind: 'plain' },
  { id: 'fr-hedged', language: 'French', text: 'euh… je pense que oui ?', kind: 'hedged' },
  { id: 'zh-plain', language: 'Chinese', text: '好的，就这么办吧', kind: 'plain' },
  { id: 'zh-hedged', language: 'Chinese', text: '嗯…应该可以吧？', kind: 'hedged' },
  { id: 'ja-plain', language: 'Japanese', text: 'はい、お願いします', kind: 'plain' },
  { id: 'ja-hedged', language: 'Japanese', text: 'うーん、たぶん大丈夫かな…？', kind: 'hedged' },
  { id: 'es-plain', language: 'Spanish', text: 'sí, adelante por favor', kind: 'plain' },
  { id: 'es-hedged', language: 'Spanish', text: 'mmm creo que sí… ¿supongo?', kind: 'hedged' },
  { id: 'ar-plain', language: 'Arabic', text: 'نعم، تفضل وامضِ في ذلك', kind: 'plain' },
  { id: 'ar-hedged', language: 'Arabic', text: 'امم، أظن ذلك؟ ربما لا بأس', kind: 'hedged' },
];
