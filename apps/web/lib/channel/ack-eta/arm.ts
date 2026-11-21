import type { Database } from '@hale/db';
import type { ReplyLanguage } from '~/lib/channel/language';
import type { ParentReaction } from '~/lib/channel/linq/tapback';
import type { HoldingLineRead, HoldingLineWithheld } from '~/lib/channel/router/holding-line';
import type { HoldingTapbackComposer } from '~/lib/channel/router/holding-tapback';
import type { AckComposeFallback, AckLineWriter } from './compose';
import type { AckPromiseInput, AckPromiseRecordOutcome } from './promise';
import type { AckTask, AckTaskReader, AckTaskUnread } from './read';

/**
 * VIL-717 · THE ACK, ARMED ON ONE SLOW 1:1 TURN — built on the holding line, not beside it.
 *
 * Armed where the holding tapback is armed (route.ts, past every gate, never on a re-drive,
 * never in a group), on the same clock (HOLDING_LINE_AFTER_MS less the burst wait), with
 * the same read of the screen when it is due: a crisis or medical text, or one the screen
 * has not read, gets nothing at all. An answer that lands first cancels it, so a quick
 * answer never has one.
 *
 * When it is due:
 *   1. the slow-job read (read.ts) says which kind of slow work the text asks for;
 *   2. for a registration, research or a find, the writer (compose.ts) writes the ack from
 *      that category, the window and the language, and it goes out as a text on SMS and on
 *      iMessage alike, in place of the tapback (one ack per turn, never two). Once the
 *      transport took it, the promise is written down (promise.ts) for the deadline sweep;
 *   3. otherwise the holding tapback goes exactly as it would with the flag off: on 1:1
 *      iMessage when reactions are lit, and on SMS nothing.
 *
 * When the read or the writer cannot produce a sendable line, no ack is sent and #ops is
 * paged; there is no fixed line underneath. The tapback still goes where it would have gone
 * with the flag off, so turning this on never leaves a parent with less than today.
 */

/** What became of the ack on one turn (rule #11). */
export type AckEtaOutcome =
  /** The answer went first: nothing was due yet, or what was being composed was dropped. */
  | 'answered_first'
  | HoldingLineWithheld
  /** The screen read threw when the ack came due: nobody knows it is not a crisis. */
  | 'read_failed'
  | 'ack_sent'
  /** Linq took the ack and its ledger row failed: no promise, so no late note can follow. */
  | 'ack_sent_unrecorded'
  | 'ack_send_failed'
  /** Not a slow ask, and no tapback is lit for this turn. */
  | 'not_a_slow_ask'
  /** The slow-job read did not answer; #ops was paged and no tapback is lit. */
  | 'task_unread'
  /** No sendable ack came back; #ops was paged and no tapback is lit. */
  | 'ack_unwritten'
  /** The holding tapback went: not a slow ask, or the ack lane could not write one. */
  | 'tapback_sent'
  | 'tapback_unsent';

/** What #ops is told when no ack could be written, from the closed page vocabulary. */
export type AckUnwrittenPage =
  | { stage: 'read'; reason: AckTaskUnread }
  | { stage: 'ack'; reason: AckComposeFallback };

/**
 * What the router needs for the ack (route.ts `ChannelRouterDeps.ackEta`). Non-nullable
 * there (rule #11): dark is the flag's own answer, never an absent port. Production is
 * `ackEtaRouterPorts` (production.ts), on the screen's lazy client.
 */
export interface AckEtaRouterPorts {
  reader: AckTaskReader;
  writer: AckLineWriter;
  record(database: Database, input: AckPromiseInput): Promise<AckPromiseRecordOutcome>;
  page(database: Database, page: AckUnwrittenPage): Promise<unknown>;
}

export interface AckEtaLine {
  /**
   * Called before the turn's answer goes out, and when the turn ends: cancels an ack not
   * yet started, waits for one already being SENT (and its promise write) so it never
   * lands after the answer, and drops one still being composed. Idempotent.
   */
  settle(): Promise<AckEtaOutcome>;
}

export interface AckEtaArm {
  afterMs: number;
  /** The words the turn is answering. Read by the slow-job read only. */
  parentText: string;
  /** The window the ack may state, in minutes (window.ts `ackWindowMinutes`). */
  withinMinutes: number;
  /** Read when the ack is DUE. Waits for this turn's screen, which a burst's wait can put
   * after the clock, and ends with the turn. */
  read: () => Promise<HoldingLineRead>;
  reader: AckTaskReader;
  writer: AckLineWriter;
  /** Sends the ack as this turn's non-answer line and returns its ledger row, or null when
   * the transport took it and the row did not land. Throws only when the transport did not
   * take it. */
  sendLine: (line: string) => Promise<{ channelMessageId: string | null }>;
  /** Writes the promise against the ack's row. Never throws (promise.ts). */
  recordPromise: (input: {
    task: AckTask;
    ackChannelMessageId: string;
    language: ReplyLanguage | null;
  }) => Promise<AckPromiseRecordOutcome>;
  /** Pages #ops once per hour per site (failure-page.ts `pageOps`). Never throws. */
  page: (page: AckUnwrittenPage) => Promise<unknown>;
  /**
   * The holding tapback for a turn the ack does not cover, or null where there is none to
   * send: SMS, reactions dark, no parent message id, or the holding line switched off.
   */
  tapback: {
    composer: HoldingTapbackComposer;
    send: (reaction: ParentReaction) => Promise<void>;
  } | null;
  log: Pick<Console, 'info' | 'warn'>;
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

/** Arm the one ack for one turn. It fires at most once. */
export function armAckEta(input: AckEtaArm): AckEtaLine {
  let settled = false;
  let reported = false;
  let outcome: AckEtaOutcome | null = null;
  let sending: Promise<void> | null = null;

  const holdingTapback = async (why: 'not_a_slow_ask' | 'task_unread' | 'ack_unwritten') => {
    if (settled) return;
    if (!input.tapback) {
      outcome = why;
      input.log.info({ outcome }, 'ack eta: no ack for this turn');
      return;
    }
    const picked = await input.tapback.composer.compose();
    if (settled) return;
    if (picked.status !== 'composed') {
      outcome = 'tapback_unsent';
      input.log.warn(
        { outcome, why, reason: picked.reason },
        'ack eta: no ack, and no tapback either',
      );
      return;
    }
    const tapback = input.tapback;
    sending = tapback.send(picked.reaction).then(
      () => {
        outcome = 'tapback_sent';
        input.log.info({ outcome, why }, 'ack eta: no ack for this turn, the tapback went');
      },
      (err: unknown) => {
        outcome = 'tapback_unsent';
        input.log.warn(
          { outcome, why, err: errName(err) },
          'ack eta: no ack, and the tapback did not land',
        );
      },
    );
  };

  const fire = async () => {
    let read: HoldingLineRead;
    try {
      read = await input.read();
    } catch (err) {
      if (settled) return;
      outcome = 'read_failed';
      input.log.warn(
        { outcome, err: errName(err) },
        'ack eta: the screen read failed, nothing sent, the answer is still coming',
      );
      return;
    }
    if (settled) return;
    if (read.status === 'withheld') {
      outcome = read.reason;
      input.log.info({ outcome }, 'ack eta: withheld, the answer is still coming');
      return;
    }

    const reading = await input.reader.read(input.parentText);
    if (settled) return;
    if (reading.status === 'unread') {
      await input.page({ stage: 'read', reason: reading.reason });
      await holdingTapback('task_unread');
      return;
    }
    if (reading.task === 'none') {
      await holdingTapback('not_a_slow_ask');
      return;
    }

    const task = reading.task;
    const composed = await input.writer.ack({
      task,
      withinMinutes: input.withinMinutes,
      language: read.language,
    });
    if (settled) return;
    if (composed.status !== 'composed') {
      await input.page({ stage: 'ack', reason: composed.reason });
      await holdingTapback('ack_unwritten');
      return;
    }
    const language = read.language;
    sending = (async () => {
      let sent: { channelMessageId: string | null };
      try {
        sent = await input.sendLine(composed.line);
      } catch (err) {
        outcome = 'ack_send_failed';
        input.log.warn(
          { outcome, task, err: errName(err) },
          'ack eta: the ack did not go, the answer is still coming',
        );
        return;
      }
      if (sent.channelMessageId === null) {
        outcome = 'ack_sent_unrecorded';
        input.log.warn(
          { outcome, task },
          'ack eta: the ack went, its ledger row did not, so no late note can follow it',
        );
        return;
      }
      outcome = 'ack_sent';
      const recorded = await input.recordPromise({
        task,
        ackChannelMessageId: sent.channelMessageId,
        language,
      });
      input.log.info(
        {
          outcome,
          task,
          withinMinutes: input.withinMinutes,
          promise: recorded.status,
          ...(recorded.status === 'not_recorded' ? { reason: recorded.reason } : {}),
        },
        'ack eta: the ack went while the answer is composed',
      );
    })();
  };

  const timer = setTimeout(() => {
    void fire();
  }, input.afterMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    async settle() {
      settled = true;
      clearTimeout(timer);
      if (sending) await sending;
      if (outcome) return outcome;
      if (!reported) {
        reported = true;
        input.log.info({ outcome: 'answered_first' }, 'ack eta: the answer came first');
      }
      return 'answered_first';
    },
  };
}
