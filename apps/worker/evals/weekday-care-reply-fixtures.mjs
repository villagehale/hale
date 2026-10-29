/**
 * Situations, not expected phrases. The runner does not assert a care enum.
 * A judge scores the model's tool output against `situation`.
 *
 * `zh-home` is Chinese. `ar-daycare` is Arabic, a second non-Latin script.
 */
export const WEEKDAY_CARE_REPLY_FIXTURES = [
  {
    id: 'en-home',
    text: 'she stays home with me during the week',
    situation:
      'The parent says this child stays home with them on weekdays. They do not name a place the child goes. The reading is home, with no provider, and high confidence.',
  },
  {
    id: 'en-daycare-named',
    text: 'she goes to Little Sprouts',
    situation:
      'The parent says this child goes to a named place, Little Sprouts. The reading is daycare, the provider is that place, and confidence is high.',
  },
  {
    id: 'en-starting',
    text: 'not in care yet, she starts in September',
    situation:
      'Care has not started. A start is coming. The reading is starting_soon, with no provider, and high confidence. Home would be the wrong durable fact.',
  },
  {
    id: 'en-nothing',
    text: 'yes',
    situation:
      'A bare yes. It does not say whether the child is home, in care, or not started. The reading is nothing. High confidence on home, daycare, or starting_soon is wrong.',
  },
  {
    id: 'en-sister',
    text: 'My sister put hers in daycare at Little Sprouts. Mine is home with me.',
    situation:
      "This child is home with the parent. Little Sprouts is the sister's child, not this child. The reading is home, with no provider. Pinning Little Sprouts is wrong.",
  },
  {
    id: 'zh-home',
    text: '她平时在家，跟我在一起',
    situation:
      'The reply is Chinese. It says this child is at home with the parent on ordinary days. The reading is home, with no provider, and high confidence.',
  },
  {
    id: 'ar-daycare',
    text: 'هي تروح الحضانة كل يوم',
    situation:
      'The reply is Arabic. It says she goes to daycare every day. The reading is daycare. No place is named, so the provider is null. Confidence is high.',
  },
];

/**
 * One deliberately wrong reading per fixture, for --broken. Each is a different way a
 * reading goes wrong (wrong care, another child's or family's place, an invented or
 * misspelled place, high confidence on nothing, an invented or judging reason). The
 * real judge must fail every one. No word list: the judge reads the whole reading.
 */
export const WEEKDAY_CARE_REPLY_BROKEN = {
  'en-home': {
    care: 'home',
    provider: null,
    confidence: 'high',
    reason: 'Home with mom because daycare costs too much; she should look at subsidies.',
  },
  'en-daycare-named': {
    care: 'daycare',
    provider: 'Little Sprout Academy',
    confidence: 'high',
    reason: 'Goes to daycare.',
  },
  'en-starting': {
    care: 'home',
    provider: null,
    confidence: 'high',
    reason: 'Not in care, so the child is home.',
  },
  'en-nothing': {
    care: 'home',
    provider: null,
    confidence: 'high',
    reason: 'Yes means the child is home.',
  },
  'en-sister': {
    care: 'daycare',
    provider: 'Little Sprouts',
    confidence: 'high',
    reason: 'The family uses Little Sprouts.',
  },
  'zh-home': {
    care: 'daycare',
    provider: null,
    confidence: 'high',
    reason: '孩子平时去托儿所。',
  },
  'ar-daycare': {
    care: 'daycare',
    provider: 'حضانة النور',
    confidence: 'high',
    reason: 'تذهب إلى حضانة النور كل يوم.',
  },
};
