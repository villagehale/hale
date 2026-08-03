import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MessageView } from '~/lib/messages/mappers';
import { MessagesMasterDetail } from './messages-master-detail';

/**
 * The rule-#1 branch of the Messages detail pane, at the render.
 *
 * A parent can reply to a Hale note; they cannot reply to a note that was withheld
 * because it concerns a 13+ child. The composer's absence there is not cosmetic — a
 * reply carries the note view to the agent as grounding (`sourceNote`), and inviting
 * a parent to ask around a withholding the product just made is exactly what the
 * teen-privacy rule forbids. So the guard is asserted on the rendered markup, not
 * only on the predicate.
 *
 * The server action the thread loads its transcript from is a server edge (its module
 * graph reaches Auth.js) — stubbed; what is under test is which notes get a thread.
 */

vi.mock('~/lib/messages/note-thread-action', () => ({
  loadNoteThreadAction: async () => ({ conversationId: null, turns: [] }),
}));

const DIGEST: MessageView = {
  id: 'digest-11111111-1111-4111-8111-111111111111',
  kind: 'digest',
  eyebrow: 'Daily brief',
  body: 'Naps shortened this week — a common 4-month shift.',
  when: 'Today, 8:02 AM',
};

const REDACTED: MessageView = {
  id: 'action-22222222-2222-4222-8222-222222222222',
  kind: 'action',
  eyebrow: 'Private',
  body: 'Redacted · teen privacy',
  when: 'Yesterday, 6:15 PM',
  actionState: 'drafted_for_approval',
  teenRedacted: true,
};

const render = (messages: MessageView[]) =>
  renderToStaticMarkup(h(MessagesMasterDetail, { messages }));

describe('Messages detail — who gets a reply thread', () => {
  it('opens a composer on an ordinary note', () => {
    const html = render([DIGEST]);
    expect(html).toContain('note-composer');
    expect(html).toContain('Reply to Hale');
  });

  it('shows NO composer on a teen-redacted note (rule #1)', () => {
    const html = render([REDACTED]);
    expect(html).not.toContain('note-composer');
    // The note itself still reads exactly as the loader redacted it.
    expect(html).toContain('Redacted · teen privacy');
  });

  it('still shows the redacted note with no composer when it is selected beside a repliable one', () => {
    // The first note is the default selection, so this pins the branch on the ACTIVE
    // note rather than on "any redacted note is present".
    expect(render([REDACTED, DIGEST])).not.toContain('note-composer');
    expect(render([DIGEST, REDACTED])).toContain('note-composer');
  });
});
