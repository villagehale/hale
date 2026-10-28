import type { GroupReminderReadInput, GroupReminderReader, GroupReminderReading } from './read';
import type { GroupReminderFacts, GroupReminderVoice } from './voice';

/**
 * Deterministic stand-ins for the reminder reader and voice. Tests of the rows, the
 * ledger and the sends inject these. They call no model and judge no prose: what the
 * model reads and writes is the eval's job (apps/worker/evals/group-reminder-eval.mjs).
 */

export interface FakeGroupReminderReader extends GroupReminderReader {
  readonly calls: GroupReminderReadInput[];
}

export function fakeGroupReminderReader(
  reading:
    | GroupReminderReading
    | null
    | ((input: GroupReminderReadInput) => GroupReminderReading | null),
): FakeGroupReminderReader {
  const calls: GroupReminderReadInput[] = [];
  return {
    calls,
    async read(input) {
      calls.push(input);
      return typeof reading === 'function' ? reading(input) : reading;
    },
  };
}

export interface FakeGroupReminderVoice extends GroupReminderVoice {
  readonly calls: GroupReminderFacts[];
}

/** Writes a line that names the kind and the facts it was handed, or nothing. */
export function fakeGroupReminderVoice(options: { fail?: boolean } = {}): FakeGroupReminderVoice {
  const calls: GroupReminderFacts[] = [];
  return {
    calls,
    async write(facts) {
      calls.push(facts);
      if (options.fail) return null;
      if (facts.kind === 'reminder') {
        return `reminder for ${facts.forEveryone ? 'everyone' : (facts.forName ?? 'the asker')}`;
      }
      return `confirm ${facts.set.length} set, ${facts.cancelled.length} cancelled, ${facts.needsTime.length} asked`;
    },
  };
}
