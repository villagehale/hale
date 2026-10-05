import {
  type SpokenLineComposer,
  type SpokenLineFallback,
  type SpokenLineOptions,
  type SpokenLineResult,
  defaultSpokenLineComposer,
  speakLine,
} from '~/lib/channel/voice/spoken-line';
import { type DutyLineKind, type DutyLineRequest, dutyLineInput } from './line-input';

export {
  DUTY_MAX_CHARS,
  DUTY_OVERVIEW_MAX_CHARS,
  DUTY_OVERVIEW_MAX_ENTRIES,
  DUTY_VOICE_SKILL,
  type DutyLineKind,
  type DutyLineRequest,
  type DutyWeekEntry,
  dutyLineInput,
  overviewEntries,
} from './line-input';

/**
 * VIL-413 / VIL-417 · every word the duty lane says, written by the model from real facts
 * through the shared spoken-line engine: judged, retried once on a short prompt, and
 * otherwise NOT SENT with #ops paged. There is no sentence underneath.
 */

export type DutyVoice = SpokenLineComposer;

/** The production composer, or undefined when no model key is set (then nothing is sent and #ops is paged). */
export function defaultDutyVoice(): DutyVoice | undefined {
  return defaultSpokenLineComposer();
}

/** One duty line, or nothing. */
export function speakDutyLine(
  voice: DutyVoice | undefined,
  request: DutyLineRequest,
  language: 'en' | 'fr',
  options: SpokenLineOptions = {},
): Promise<SpokenLineResult> {
  return speakLine(voice, dutyLineInput(request, language), options);
}

export type DutyBubble =
  | { text: string; source: 'composed' | 'retry'; unsent: null }
  | { text: null; source: 'unsent'; unsent: { kind: DutyLineKind; fallback: SpokenLineFallback } };

/**
 * One bubble carrying several duty lines, one per line break, ALL OR NOTHING: a bubble
 * that said who has Tuesday but silently lost the question about Thursday would read as
 * if Thursday were settled. The first line the model could not write names the bubble
 * unsent (#ops has been paged by the engine) and nothing is sent.
 */
export async function speakDutyBubble(
  voice: DutyVoice | undefined,
  requests: readonly DutyLineRequest[],
  language: 'en' | 'fr',
  options: SpokenLineOptions = {},
): Promise<DutyBubble> {
  if (requests.length === 0) throw new Error('speakDutyBubble: nothing to say');
  const parts: string[] = [];
  let source: 'composed' | 'retry' = 'composed';
  for (const request of requests) {
    const spoken = await speakDutyLine(voice, request, language, options);
    if (spoken.source === 'unsent') {
      return {
        text: null,
        source: 'unsent',
        unsent: { kind: request.kind, fallback: spoken.fallback ?? 'unusable' },
      };
    }
    if (spoken.source === 'retry') source = 'retry';
    parts.push(spoken.body);
  }
  return { text: parts.join('\n'), source, unsent: null };
}
