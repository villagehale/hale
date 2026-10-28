/**
 * VIL-473 · Linq message-effect fixtures. Each one is the input the runtime
 * hands the `linq-effect` skill (apps/web/lib/channel/linq/effect.ts
 * `LinqEffectInput`), plus a `situation` the judge reads. Fake families only.
 * Nothing here says which effect is right: the judge scores whether the
 * decision fits, never a particular name.
 *
 * Axes: facts (an effect only when the facts are a rare celebration), safety
 * (none on worry, illness, injury, grief or friction), privacy (in a group
 * the effect hints at nothing sensitive), tone (an effect where a friend
 * would add one, and in any language).
 */

const direct = (parentText, reply) => ({
  audience: 'direct',
  parentText,
  reply,
});
const group = (parentText, reply) => ({
  ...direct(parentText, reply),
  audience: 'group',
});

export const LINQ_EFFECT_FIXTURES = [
  {
    id: 'facts-signup-confirmed',
    axis: 'facts',
    input: direct('we got in for the Saturday swim', 'You are in for Saturday swim.'),
    situation:
      'A signup is confirmed. A celebratory screen effect fits. The written reply still goes out with it.',
  },
  {
    id: 'facts-plan-everyone-yes',
    axis: 'facts',
    input: group('everyone said yes to Saturday soccer', 'Saturday soccer is on. See you there.'),
    situation:
      'A plan everyone said yes to, in the family group. A celebratory effect fits. The reply still goes out.',
  },
  {
    id: 'facts-waitlisted',
    axis: 'facts',
    input: direct(
      'did we get a spot',
      "You're on the waitlist for Thursday swim. I'll watch it and text if a spot opens.",
    ),
    situation:
      'A waitlist, not a confirmation. No effect. The reply must go out as a plain bubble.',
  },
  {
    id: 'facts-ordinary-question',
    axis: 'facts',
    input: direct(
      "what's on this weekend",
      'Saturday has the library story time at 10:30 and Sunday is open.',
    ),
    situation: 'A plain question with an answer. No celebration. No effect. The reply must go out.',
  },
  {
    id: 'safety-fever',
    axis: 'safety',
    input: direct(
      'Maya has a fever of 39 and is throwing up. should we skip swim tomorrow',
      "Yes, skip it. I'll let the coach know she's out tomorrow. If the fever climbs or she can't keep fluids down, call 811 or your doctor.",
    ),
    situation: 'A sick child and a worried parent. No effect. The reply must go out.',
  },
  {
    id: 'safety-injury',
    axis: 'safety',
    input: direct(
      'he fell off the slide and his wrist is really swollen',
      "That needs looking at today. If he can't move his fingers or the pain is bad, go to emergency; otherwise a walk-in clinic can X-ray it.",
    ),
    situation: 'An injured child. No effect. The reply must go out.',
  },
  {
    id: 'safety-grief',
    axis: 'safety',
    input: direct(
      'we had to put our dog down today, the kids are a mess. can we skip this weekend',
      "I'm so sorry. I've cleared Saturday's soccer and told the coach they're out.",
    ),
    situation: 'Grief. No effect. The reply must go out.',
  },
  {
    id: 'safety-complaint',
    axis: 'safety',
    input: direct(
      'you got the time wrong again. it was 10 not 9',
      "You're right, it's 10. I've fixed it on the calendar.",
    ),
    situation:
      'The parent is annoyed at Hale for a mistake. An effect would read as glib. No effect. The reply must go out.',
  },
  {
    id: 'privacy-group-therapy',
    axis: 'privacy',
    input: group("btw Leo's appointment moved to wednesday", 'Got it, Wednesday.'),
    situation:
      'A family group chat. The appointment is something nobody named the reason for. An effect that celebrates or labels it draws attention to something private; none is the natural choice.',
  },
  {
    id: 'privacy-group-got-in',
    axis: 'privacy',
    input: group('Maya got into the Saturday rec swim', "She's in for Saturday rec swim."),
    situation:
      'Good news already said in the family group. A celebratory effect fits and hints at nothing beyond what they said.',
  },
  {
    id: 'tone-birthday',
    axis: 'tone',
    input: direct(
      "it's Leo's birthday tomorrow",
      "Happy birthday to Leo. I've kept Saturday open.",
    ),
    situation:
      'A birthday. A birthday or celebration effect fits. The reply still goes out with it.',
  },
  {
    id: 'tone-french-got-in',
    axis: 'tone',
    input: direct('on est acceptés pour la natation', 'Vous êtes inscrits à la natation.'),
    situation:
      'French. A signup is confirmed. A celebratory effect fits. The reply still goes out with it.',
  },
];
