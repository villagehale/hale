import type { Database } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import type { PendingAction, SpineOutcome } from '~/lib/channel/router/approval';
import { nothingPendingReply, nothingToUndoReply } from '~/lib/channel/router/copy';
import { approvalHandler, planReplyHandler, villageIntroHandler } from '~/lib/channel/router/handlers';
import type { OpenQuestion } from '~/lib/channel/router/open-questions';
import type { ReplyReading, ReplyResolver } from '~/lib/channel/router/resolve';
import type { DeterministicHandler } from '~/lib/channel/router/route';
import { VOICE_NOTHING_PENDING, VOICE_NOTHING_TO_UNDO } from './copy';
import { type SpokenAnswerDeps, answerSpokenReply } from './voice-answer';

/**
 * A parent answering Hale out loud. The subject is the WIRING — that a call reaches the
 * router's real approval handler, with the router's real claim rules, and that nothing
 * spoken is a line only a screen could use.
 *
 * The handlers under test are the REAL ones (handlers.ts): a fake handler here would
 * assert this file's idea of the rules rather than the rules, and the whole point of the
 * stage is that a call and a text are read by one grammar.
 */

const FAMILY_ID = '00000000-0000-4000-8000-0000000000f1';
const PARENT_ID = '00000000-0000-4000-8000-0000000000a1';
const CONVERSATION_ID = '00000000-0000-4000-8000-0000000000c1';
const PHONE = '+14165551234';
const NOW = new Date('2026-08-19T15:00:00.000Z');
const DRAFT: PendingAction = { actionId: 'act-1', actionType: 'calendar_move', reviewerApproved: true };

const OK: SpineOutcome = { ok: true };

function spine(pending: PendingAction[], undoable: PendingAction | null = null) {
  const approve = vi.fn(async () => OK);
  const decline = vi.fn(async () => OK);
  const undo = vi.fn(async () => OK);
  return {
    approve,
    decline,
    undo,
    spine: {
      listPending: async () => pending,
      latestUndoable: async () => undoable,
      approve,
      decline,
      undo,
    },
  };
}

function resolver(reading: ReplyReading): ReplyResolver & { read: ReturnType<typeof vi.fn> } {
  const read = vi.fn(async () => reading);
  return { read } as unknown as ReplyResolver & { read: ReturnType<typeof vi.fn> };
}

const NOTHING_RESOLVED: ReplyReading = { status: 'unresolved', reason: 'no_target' };

function build(options: {
  handlers: DeterministicHandler[];
  questions?: OpenQuestion[];
  reading?: ReplyReading;
  phone?: string | null;
}) {
  const log = { info: vi.fn(), error: vi.fn() };
  const replyResolver = resolver(options.reading ?? NOTHING_RESOLVED);
  const deps: SpokenAnswerDeps = {
    database: {} as Database,
    handlers: options.handlers,
    questions: { open: async () => options.questions ?? [] },
    replyResolver,
    sendablePhone: async () => (options.phone === undefined ? PHONE : options.phone),
    log,
  };
  return { deps, log, replyResolver };
}

const turn = (utterance: string) => ({
  familyId: FAMILY_ID,
  parentUserId: PARENT_ID,
  conversationId: CONVERSATION_ID,
  utterance,
  now: NOW,
});

const approvalQuestion: OpenQuestion = {
  id: DRAFT.actionId,
  kind: 'approval',
  description: 'Move a calendar item',
  subject: 'the calendar move',
  answerable: { yes: true, no: true },
};

const introQuestion: OpenQuestion = {
  id: 'proposal-1',
  kind: 'intro_proposal',
  description: 'Whether to meet one nearby Hale family',
  subject: 'meeting the family nearby',
  answerable: { yes: true, no: true },
};

describe('a spoken yes', () => {
  it('approves through the SAME spine a texted yes does, and says so out loud', async () => {
    const s = spine([DRAFT]);
    const { deps } = build({ handlers: [approvalHandler(s.spine)] });

    const answer = await answerSpokenReply(deps, turn('yes'));

    expect(s.approve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actionId: DRAFT.actionId, approvedBy: PARENT_ID }),
    );
    expect(answer).toMatchObject({ status: 'answered', handler: 'approval', outcome: 'approved' });
  });

  it('resolves the words a parent actually used, by ID, through the same resolver a text uses', async () => {
    const s = spine([DRAFT]);
    const { deps, replyResolver } = build({
      handlers: [approvalHandler(s.spine)],
      questions: [approvalQuestion],
      reading: {
        status: 'resolved',
        questionId: DRAFT.actionId,
        kind: 'approval',
        polarity: 'yes',
        confidence: 'high',
      },
    });

    const answer = await answerSpokenReply(deps, turn('yeah, go ahead and do that one'));

    expect(replyResolver.read).toHaveBeenCalledWith({
      text: 'yeah, go ahead and do that one',
      questions: [approvalQuestion],
    });
    expect(s.approve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actionId: DRAFT.actionId }),
    );
    expect(answer.status).toBe('answered');
  });

  it('settles nothing when another kind of question is also open — the coach takes the turn', async () => {
    const s = spine([DRAFT]);
    const { deps } = build({
      handlers: [approvalHandler(s.spine)],
      questions: [approvalQuestion, introQuestion],
    });

    const answer = await answerSpokenReply(deps, turn('yes'));

    // The bare word names neither question, and a call may not guess between an
    // approval and a disclosure (soleOpenKind, open-questions.ts).
    expect(answer).toEqual({ status: 'not_an_answer' });
    expect(s.approve).not.toHaveBeenCalled();
  });

  it('hands an ordinary question to the coach without touching the spine', async () => {
    const s = spine([DRAFT]);
    const { deps } = build({ handlers: [approvalHandler(s.spine)], questions: [approvalQuestion] });

    const answer = await answerSpokenReply(deps, turn('what time is swim on Thursday'));

    expect(answer).toEqual({ status: 'not_an_answer' });
    expect(s.approve).not.toHaveBeenCalled();
    expect(s.decline).not.toHaveBeenCalled();
  });
});

describe('what a call may settle', () => {
  it('never settles a cross-household introduction, even when the resolver is sure', async () => {
    const introDeps = {
      answerableProposal: vi.fn(),
    } as never;
    const { deps, log } = build({
      handlers: [villageIntroHandler(introDeps), approvalHandler(spine([]).spine)],
      questions: [introQuestion],
      reading: {
        status: 'resolved',
        questionId: introQuestion.id,
        kind: 'intro_proposal',
        polarity: 'yes',
        confidence: 'high',
      },
    });

    const answer = await answerSpokenReply(deps, turn('yes, introduce us'));

    expect(answer).toEqual({ status: 'not_an_answer' });
    // Named, not silently dropped: the coach answers it and the text lane can settle it.
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'intro_proposal' }),
      expect.stringContaining('a call cannot settle'),
    );
  });

  it('runs no handler at all when none of them owns a spoken question kind', async () => {
    const planDeps = {} as never;
    const handler = planReplyHandler(planDeps);
    const handle = vi.spyOn(handler, 'handle');
    const { deps } = build({ handlers: [handler] });

    const answer = await answerSpokenReply(deps, turn('yes'));

    expect(answer).toEqual({ status: 'not_an_answer' });
    expect(handle).not.toHaveBeenCalled();
  });
});

describe('what a caller hears', () => {
  it('speaks the two receipts that would otherwise read an app URL out loud', async () => {
    const empty = spine([], null);
    const { deps } = build({ handlers: [approvalHandler(empty.spine)] });

    const ordinal = await answerSpokenReply(deps, turn('yes 2'));
    const undo = await answerSpokenReply(deps, turn('undo'));

    expect(ordinal).toMatchObject({ status: 'answered', spoken: VOICE_NOTHING_PENDING });
    expect(undo).toMatchObject({ status: 'answered', spoken: VOICE_NOTHING_TO_UNDO });
    // The positive control: the texted twins DO carry the link this lane must not speak,
    // so the assertion below is testing a substitution rather than passing vacuously.
    expect(nothingPendingReply()).toMatch(/https?:\/\//);
    expect(nothingToUndoReply()).toMatch(/https?:\/\//);
    for (const spokenAnswer of [ordinal, undo]) {
      if (spokenAnswer.status !== 'answered') throw new Error('expected a spoken answer');
      expect(spokenAnswer.spoken).not.toMatch(/https?:\/\/|www\./);
    }
  });

  it('speaks the approvals grammar verbatim everywhere it is already one plain sentence', async () => {
    const s = spine([DRAFT]);
    const { deps } = build({ handlers: [approvalHandler(s.spine)] });

    const answer = await answerSpokenReply(deps, turn('no'));

    if (answer.status !== 'answered') throw new Error('expected a spoken answer');
    expect(s.decline).toHaveBeenCalled();
    expect(answer.spoken).toContain('Dropped it');
    expect(answer.spoken).not.toMatch(/https?:\/\/|www\./);
  });

  it('settles nothing, loudly, when the caller has no channel a handler could answer on', async () => {
    const s = spine([DRAFT]);
    const { deps, log } = build({ handlers: [approvalHandler(s.spine)], phone: null });

    const answer = await answerSpokenReply(deps, turn('yes'));

    expect(answer).toEqual({ status: 'not_an_answer' });
    expect(s.approve).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });
});
