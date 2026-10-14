// Opt-out reader fixtures (#868). Each row is one inbound text and the intent a
// careful human would read. `stop` rows cover blunt, polite, indirect and
// non-English wording; `none` rows are close calls that must not revoke.
// No row carries required or banned words: the intent is a label, and the
// confirmation is graded by a judge model.
export const OPT_OUT_FIXTURES = [
  { id: 'en-blunt', text: 'stop texting me', language: 'en', expect: 'stop' },
  {
    id: 'en-polite',
    text: 'Thanks, but please take me off this, I no longer need it',
    language: 'en',
    expect: 'stop',
  },
  {
    id: 'en-indirect',
    text: 'who gave you this number?? leave me alone',
    language: 'en',
    expect: 'stop',
  },
  { id: 'en-lowercase-unsub', text: 'unsub pls', language: 'en', expect: 'stop' },
  { id: 'fr-stop', text: "Arrêtez de m'écrire s'il vous plaît", language: 'fr', expect: 'stop' },
  { id: 'zh-stop', text: '请不要再给我发短信了', language: 'zh', expect: 'stop' },
  { id: 'ar-stop', text: 'من فضلك توقف عن مراسلتي', language: 'ar', expect: 'stop' },
  { id: 'hi-stop', text: 'मुझे और मैसेज मत भेजिए', language: 'hi', expect: 'stop' },
  {
    id: 'en-start',
    text: 'ok I changed my mind, you can text me again',
    language: 'en',
    expect: 'start',
  },
  {
    id: 'en-none-one-thing',
    text: 'stop sending the swim reminders but keep the rest',
    language: 'en',
    expect: 'none',
  },
  {
    id: 'en-none-question',
    text: 'how do I stop the camp from emailing me?',
    language: 'en',
    expect: 'none',
  },
  {
    id: 'en-none-bus',
    text: 'what stop does the 52 bus leave from for the library?',
    language: 'en',
    expect: 'none',
  },
  {
    id: 'fr-none',
    text: "On arrête le soccer en mars, tu peux me rappeler l'inscription au printemps?",
    language: 'fr',
    expect: 'none',
  },
  // #868: the identity question is read by the model in any language, not matched.
  {
    id: 'en-identity',
    text: 'who is this? how did you get my number',
    language: 'en',
    expect: 'identity',
  },
  { id: 'fr-identity', text: "c'est qui? c'est une arnaque?", language: 'fr', expect: 'identity' },
  { id: 'zh-identity', text: '你是谁？你怎么有我的电话号码？', language: 'zh', expect: 'identity' },
  { id: 'ar-identity', text: 'من أنت؟ كيف حصلت على رقمي؟', language: 'ar', expect: 'identity' },
  {
    id: 'zh-identity-scam',
    text: '这是诈骗吗？你们是哪家公司？',
    language: 'zh',
    expect: 'identity',
  },
  {
    id: 'ar-identity-company',
    text: 'هل هذه رسالة احتيال؟ ما اسم شركتكم؟',
    language: 'ar',
    expect: 'identity',
  },
  { id: 'zh-not-identity', text: '游泳老师叫什么名字？', language: 'zh', expect: 'none' },
  { id: 'ar-not-identity', text: 'ما هو عنوان المسبح؟', language: 'ar', expect: 'none' },
];
