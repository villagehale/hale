/**
 * VIL-415. Natural replies the intent resolver should read.
 *
 * Not recorded. There is no cached Anthropic response for these cases in this
 * change. A later recording run should use
 * `node --import @anthropic-ai/sdk/shims/web` and the parent-intent skill.
 * The gate tests in apps/web/lib/channel/intent/decide.test.ts cover the same
 * six readings without a model call.
 */
export const PARENT_INTENT_FIXTURES = [
  {
    id: 'sure-go-ahead',
    text: 'sure go ahead',
    pending: [{ id: 'q1', kind: 'plan_offer', description: 'Want me to send the full plan?' }],
    expect: { intent: 'affirm', confidence: 'high', targetId: 'q1' },
  },
  {
    id: 'nah',
    text: 'nah',
    pending: [{ id: 'q1', kind: 'approval', description: 'Move swim to Tuesday?' }],
    expect: { intent: 'decline', targetId: 'q1' },
  },
  {
    id: 'less-often',
    text: 'less often pls',
    pending: [],
    expect: { intent: 'cadence', value: 'weekly' },
  },
  {
    id: 'oui',
    text: 'oui',
    pending: [{ id: 'q1', kind: 'plan_offer', description: 'Je t envoie le plan complet?' }],
    expect: { intent: 'affirm', targetId: 'q1' },
  },
  {
    id: 'hao-de',
    text: '好的',
    pending: [{ id: 'q1', kind: 'checkup_offer', description: 'Want this visit on your week?' }],
    expect: { intent: 'affirm', targetId: 'q1' },
  },
  {
    id: 'what',
    text: 'what?',
    pending: [{ id: 'q1', kind: 'plan_offer', description: 'Want me to send the full plan?' }],
    expect: { intent: 'unclear' },
  },
];
