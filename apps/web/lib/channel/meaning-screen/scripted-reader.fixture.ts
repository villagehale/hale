import {
  matchConnectorDisconnectRequest,
  matchConnectorRequest,
  matchFreshConnectorFollowUp,
} from '~/lib/channel/connect/detect';
import { matchDutyStopAsking } from '~/lib/channel/coparent/duty/asks';
import { readDutyUndo } from '~/lib/channel/coparent/duty/undo';
import { readGroupActivityDecision } from '~/lib/channel/linq/activity-decision';
import { matchBothFreeAsk } from '~/lib/channel/linq/group-coparent-copy';
import { asksAboutEyeCare } from '~/lib/channel/off-domain/copy';
import { meaningRefusalsRegex } from '~/lib/channel/router/apology';
import { matchCheckInReply } from '~/lib/registration/sequence/reply';
import type { MeaningScreen, MeaningScreenInput, MeaningScreenReading } from './read';

/**
 * Test stand-in. Production has no word list. Suites that light the sweep
 * inject a reader; this one is a blank miss so a forgotten injection fails
 * closed instead of calling Anthropic.
 */

const BLANK: MeaningScreenReading = {
  hit: false,
  violations: [],
  kind: 'none',
  intent: 'none',
  outcome: 'none',
  decision: 'none',
  action: 'none',
  provider: 'none',
  activity: '',
  kid: '',
  day: '',
  time: '',
  name: '',
  position: null,
};

export function blankMeaningReading(
  over: Partial<MeaningScreenReading> = {},
): MeaningScreenReading {
  return { ...BLANK, ...over };
}

export function scriptedMeaningScreen(
  read: (input: MeaningScreenInput) => MeaningScreenReading | null,
): MeaningScreen {
  return {
    read: async (input) => read(input),
  };
}

export const unreadMeaningScreen: MeaningScreen = {
  read: async () => null,
};

/** Same meaning list `validateReplyCopy` uses when the sweep is dark. */
const COPY_REPLY_BANNED = [
  /\bbooked\b/i,
  /\benrolled\b/i,
  /\bsigned up\b/i,
  /\bregistered\b/i,
  /\bstop\b/i,
  /\bunsubscribe\b/i,
  /\bautomation\b/i,
  /\bAI\b/,
  /\bA\.I\.\b/,
];

/**
 * Default for mechanics tests when MODEL_READ_SWEEP is lit: the same regex /
 * word-list matchers production uses while the sweep is dark. Never a live
 * model. Suites that want unread inject {@link unreadMeaningScreen}.
 */
export const cleanMeaningScreen: MeaningScreen = {
  async read(input) {
    const text = input.text;
    switch (input.screen) {
      case 'copy_friend':
        return blankMeaningReading({ hit: true });
      case 'copy_false_promise':
        return blankMeaningReading({
          hit: meaningRefusalsRegex(text).length > 0,
          violations: meaningRefusalsRegex(text),
        });
      case 'copy_reply_banned':
        return blankMeaningReading({ hit: COPY_REPLY_BANNED.some((pattern) => pattern.test(text)) });
      case 'connect_intent': {
        const connect = matchConnectorRequest(text);
        if (connect) {
          return blankMeaningReading({ hit: true, action: 'connect', provider: connect });
        }
        if (matchFreshConnectorFollowUp(text)) {
          return blankMeaningReading({ hit: true, action: 'fresh_link' });
        }
        const disconnect = matchConnectorDisconnectRequest(text);
        if (disconnect) {
          return blankMeaningReading({ hit: true, action: 'disconnect', provider: disconnect });
        }
        return blankMeaningReading();
      }
      case 'registration_outcome': {
        const match = matchCheckInReply(text);
        if (!match) return blankMeaningReading();
        return blankMeaningReading({
          hit: true,
          outcome: match.outcome,
          position: 'position' in match ? (match.position ?? null) : null,
        });
      }
      case 'activity_decision': {
        const decision = readGroupActivityDecision(text);
        if (!decision) return blankMeaningReading();
        if (decision.decision === 'picked') {
          return blankMeaningReading({
            hit: true,
            decision: 'picked',
            activity: decision.activity,
            kid: decision.kid,
            day: decision.day,
            time: decision.time,
          });
        }
        return blankMeaningReading({
          hit: true,
          decision: 'passed',
          activity: decision.activity,
          kid: decision.kid,
        });
      }
      case 'duty_stop_asking':
        return blankMeaningReading({ hit: matchDutyStopAsking(text) });
      case 'duty_undo': {
        const undo = readDutyUndo(text);
        if (!undo) return blankMeaningReading();
        if (undo.kind === 'clear') return blankMeaningReading({ hit: true, kind: 'clear' });
        return blankMeaningReading({ hit: true, kind: 'reassign', name: undo.name });
      }
      case 'both_free':
        return blankMeaningReading({ hit: matchBothFreeAsk(text) });
      case 'provider_access':
        if (asksAboutEyeCare(text)) return blankMeaningReading({ hit: true, kind: 'eye' });
        return blankMeaningReading();
      default:
        return blankMeaningReading();
    }
  },
};
