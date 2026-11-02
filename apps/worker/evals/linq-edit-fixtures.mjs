/**
 * VIL-479 · Linq edit fixtures. Each one is the input the runtime hands the
 * `linq-edit` skill (apps/web/lib/channel/linq/edit.ts `LinqEditInput`), plus a
 * `situation` the judge reads. Fake families only. Nothing here says which words
 * the replacement must use: the judge scores whether the decision fits.
 *
 * Design (Oct 31): a same-turn self-correction edits; a non-correction follow-up
 * returns null; a parent's question about the old fact returns null; one
 * correction is not in English and is still an edit. The decision is the
 * meaning, in any language. The skill's other decision edges are here too:
 * a follow-up that also asks something new is its own message, and in a group
 * an edit corrects only a fact the bubble already said.
 */

const SENT = '2026-10-31T16:00:00.000Z';

function bubble(messageId, text) {
  return { messageId, partIndex: 0, text, sentAt: SENT, editsUsed: 0 };
}

const swim = bubble('msg-swim-1', 'Saturday swim is at 4 at the Regent Park pool.');

export const LINQ_EDIT_FIXTURES = [
  {
    id: 'correct-time',
    axis: 'edit',
    input: {
      audience: 'direct',
      parentText: 'saturday works',
      followUp: 'Swim is at 5, not 4.',
      editable: [swim],
    },
    situation:
      "Hale sent this bubble in the same turn, after the parent's latest message. The follow-up exists only to correct the time from 4 to 5. An edit of that bubble is right. The replacement is the whole bubble with 5 instead of 4, same place, same language, same easy tone. It is not a remark that the time changed, and it does not add a question. Leaving the wrong time in the bubble and sending a second message is the miss.",
  },
  {
    id: 'ack-not-a-fix',
    axis: 'new',
    input: {
      audience: 'direct',
      parentText: 'perfect, see you saturday',
      followUp: 'See you Saturday.',
      editable: [swim],
    },
    situation:
      'The follow-up only acknowledges the parent. It does not correct a fact in the bubble. edit is null, so the acknowledgement goes out as its own message. Editing would swallow the reply and change a bubble that was already right.',
  },
  {
    id: 'parent-asks',
    axis: 'new',
    input: {
      audience: 'direct',
      parentText: "wait, isn't swim at 5?",
      followUp: "Yes, it's at 5. I've fixed the calendar.",
      editable: [swim],
    },
    situation:
      'The parent asked a question, and the follow-up answers it. edit is null. An edit would change the old bubble and send nothing, so the question gets no reply. iMessage does not alert on an edit.',
  },
  {
    id: 'correct-and-asks',
    axis: 'new',
    input: {
      audience: 'direct',
      parentText: 'saturday works',
      followUp: 'Swim is at 5, not 4. Want me to tell the coach?',
      editable: [swim],
    },
    situation:
      'The follow-up corrects the time and also asks the parent something new. That question belongs in its own message. edit is null. An edit would either drop the question or put it into the bubble, and the parent would not be asked.',
  },
  {
    id: 'correct-time-fr',
    axis: 'edit',
    input: {
      audience: 'direct',
      parentText: 'samedi ça marche',
      followUp: 'La natation est à 17 h, pas à 16 h.',
      editable: [
        bubble('msg-swim-fr', 'La natation de samedi est à 16 h à la piscine Regent Park.'),
      ],
    },
    situation:
      'French. Hale sent this bubble in the same turn, and the follow-up only corrects the time from 16 h to 17 h. An edit is right. The replacement stays in French, keeps the pool and the easy tone, and is the whole bubble with the corrected time. A second message would leave the wrong time standing.',
  },
  {
    id: 'group-correct-place',
    axis: 'edit',
    input: {
      audience: 'group',
      parentText: 'the park one',
      followUp: "It's the east gate, not the main gate.",
      editable: [bubble('msg-park-1', 'Saturday meetup is at the main gate of Regent Park, 10am.')],
    },
    situation:
      'A group chat. The place was already said in the bubble everyone can see, and the follow-up only corrects that place. An edit is right. The replacement keeps the time, the language, and the easy tone, and does not add anything the group bubble did not already concern. Everyone will see the bubble marked Edited.',
  },
  {
    id: 'group-private',
    axis: 'new',
    input: {
      audience: 'group',
      parentText: 'thanks',
      followUp: "Leo's speech therapy moved to Wednesday.",
      editable: [bubble('msg-park-1', 'Saturday meetup is at the main gate of Regent Park, 10am.')],
    },
    situation:
      'A group chat. The follow-up adds a private appointment the bubble never mentioned. That is a new message. edit is null. Editing would put a private fact into a bubble everyone in the chat can see.',
  },
];
