/**
 * Judge-only fixtures for the mid-signup screen (signup-step-reply.md).
 *
 * The model decides whether a message answers the open signup step, in any
 * wording and any language. These fixtures are not imported by a CI runner,
 * not listed in package.json, and not a CI step. Scoring them would be a paid
 * model call. `signup-step-reply-eval.mjs --estimate` prices that call and
 * does not make it.
 */

export const SIGNUP_STEP_REPLY_FIXTURES = [
  {
    id: 'en-names-answer',
    step: 'names',
    text: 'Call me Dana',
    expect: { answers: true },
  },
  {
    id: 'en-aside',
    step: 'names',
    text: "what's on this weekend?",
    expect: { answers: false },
  },
  {
    id: 'zh-aside',
    step: 'names',
    text: '你好，周末有什么',
    expect: { answers: false },
  },
  {
    id: 'zh-names-answer',
    step: 'names',
    text: '我叫小美',
    expect: { answers: true },
  },
  {
    id: 'en-signup-answer',
    step: 'signup',
    text: 'sounds good',
    expect: { answers: true },
  },
  {
    id: 'zh-signup-aside',
    step: 'signup',
    text: '周末有什么活动',
    expect: { answers: false },
  },
];
