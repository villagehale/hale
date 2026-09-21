import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type CalendarChange,
  eventSpan,
  renderCalendarAlert,
} from '~/lib/integrations/calendar-alert';
import {
  type EmailAlertRenderInput,
  emailAlertOfferDraft,
  renderEmailAlert,
} from '~/lib/integrations/email-alert';
import { MAX_ALERT_SEGMENTS, asideViolations } from './guard';

/**
 * THE GATE THE REPLICATION CONVENTION LEAVES OPEN.
 *
 * `apps/worker/evals/run-alert-aside-eval.mjs` grades asides against the `core` strings in
 * `alert-aside-fixtures.json`. Those strings were produced by the real renderers once, and
 * nothing on the worker side can ever check that they still are: the tsx loader there
 * cannot resolve `~/`, which is why every eval in that directory either replicates its
 * subject or restricts itself to alias-free modules. The cost of that convention is drift
 * — `run-followup-voice-eval.mjs` says so in its own header and accepts it, because it has
 * no way to close it.
 *
 * HERE THERE IS ONE. This test lives on the web side, where the aliases resolve, and
 * re-renders every fixture's stated input through `renderEmailAlert` / `renderCalendarAlert`.
 * Without it the eval would keep grading warmth on sentences the product no longer writes,
 * green, forever.
 *
 * The corpus is a JSON DATA file rather than a module for the same reason: nothing under
 * `apps/web/lib` imports anything from `apps/worker`, and a data file has no resolver
 * question for either side to answer.
 */

interface EmailFixture {
  id: string;
  lane: 'email_alert';
  render: {
    from: string;
    extractionKind: EmailAlertRenderInput['kind'];
    event: EmailAlertRenderInput['event'];
    teenContent: boolean;
    matchedEventRef: EmailAlertRenderInput['matchedEventRef'];
    booked: boolean;
    timeZone: string;
    now: string;
  };
  core: string;
  ctaSuffix: string | null;
  priorAlertsToHousehold24h: number | null;
  matchedAKnownOccasion: boolean;
  expect: 'quiet' | 'clause' | 'either';
  watchFor: string;
}

interface CalendarFixture {
  id: string;
  lane: 'calendar_alert';
  render: {
    change: CalendarChange;
    previous: { startIso: string; allDay: boolean } | null;
    timeZone: string;
    now: string;
  };
  core: string;
  ctaSuffix: null;
  priorAlertsToHousehold24h: number | null;
  matchedAKnownOccasion: boolean;
  expect: 'quiet' | 'clause' | 'either';
  watchFor: string;
}

const CORPUS = join(
  process.cwd(),
  '..',
  'worker',
  'evals',
  'alert-aside-fixtures.json',
);

const { fixtures } = JSON.parse(readFileSync(CORPUS, 'utf8')) as {
  fixtures: Array<EmailFixture | CalendarFixture>;
};

function emailInput(fixture: EmailFixture): EmailAlertRenderInput {
  return {
    from: fixture.render.from,
    kind: fixture.render.extractionKind,
    event: fixture.render.event,
    teenContent: fixture.render.teenContent,
    matchedEventRef: fixture.render.matchedEventRef,
    booked: fixture.render.booked,
    // The going count is the booked chain's clause, never the fixture's: a corpus whose
    // cores were rendered WITH one would be grading the aside against a sentence the
    // going-dark lane does not send.
    going: null,
    timeZone: fixture.render.timeZone,
    now: new Date(fixture.render.now),
  };
}

describe('the eval corpus is still what the lanes render', () => {
  it('carries a corpus at all', () => {
    // The positive control for every `for` loop below: an empty or unreadable corpus
    // would make all of them vacuously green.
    expect(fixtures.length).toBeGreaterThanOrEqual(24);
    // SIX OF TWENTY-FOUR, on the field the corpus actually carries. The first spelling of
    // this read `!f.expectClause` against a field no fixture has, so it counted all 24 and
    // would have passed against a corpus with no restraint arm at all — the founder's
    // restraint bar pinned by an expression that cannot fail.
    expect(fixtures.filter((f) => f.expect === 'quiet').length).toBeGreaterThanOrEqual(6);
  });

  for (const fixture of fixtures) {
    if (fixture.lane === 'email_alert') {
      it(`${fixture.id}: renderEmailAlert still produces this core`, () => {
        const input = emailInput(fixture);
        // `.body`, because the renderer also reports what it did with the booked chain's
        // going count — which is that lane's business, not the aside's.
        expect(renderEmailAlert(input).body).toBe(fixture.core);

        // The fixture's `ctaSuffix` is what the guard builds its allowed-capital set
        // against and what `after_an_ask` reads, so it has to be the lane's own answer
        // and it has to really be the core's tail.
        const offer = emailAlertOfferDraft(input);
        expect(fixture.ctaSuffix === null).toBe(offer === null);
        if (fixture.ctaSuffix !== null) {
          expect(fixture.core.endsWith(fixture.ctaSuffix)).toBe(true);
        }
        expect(fixture.matchedAKnownOccasion).toBe(fixture.render.matchedEventRef !== null);
      });
    } else {
      it(`${fixture.id}: renderCalendarAlert still produces this core`, () => {
        const span = eventSpan(fixture.render.change, fixture.render.timeZone);
        expect(span).not.toBeNull();
        const previous =
          fixture.render.previous === null
            ? null
            : {
                startMs: Date.parse(fixture.render.previous.startIso),
                allDay: fixture.render.previous.allDay,
              };
        expect(
          renderCalendarAlert(
            fixture.render.change,
            // biome-ignore lint/style/noNonNullAssertion: asserted non-null on the line above.
            span!,
            fixture.render.timeZone,
            new Date(fixture.render.now),
            previous,
          ),
        ).toBe(fixture.core);
        // The calendar lane appends no ask today, and the guard derives `after_an_ask`
        // from the core rather than trusting that — so the fixture may not claim one.
        expect(fixture.ctaSuffix).toBeNull();
      });
    }
  }

  it('leaves every core sendable as it stands, with room the aside may spend', () => {
    // What the segment rule is actually protecting, stated as a number rather than as an
    // expectation: the empty aside never changes a core, and the longest core in the
    // corpus still clears the ceiling with a full-length clause on it. If a clamp widens
    // and this goes red, `too_many_segments` stops being a rail and starts being the
    // common refusal — which is a product change, not a test failure.
    for (const fixture of fixtures) {
      const context = {
        core: fixture.core,
        lane: fixture.lane,
        priorAlertsToHousehold24h: fixture.priorAlertsToHousehold24h,
        matchedAKnownOccasion: fixture.matchedAKnownOccasion,
        ctaSuffix: fixture.ctaSuffix,
      };
      expect(asideViolations({ clause: '', place: 'before' }, context)).toEqual([]);
      const sixty = 'A quieter stretch than usual before that one, it seems now.';
      expect(sixty.length).toBeLessThanOrEqual(60);
      expect(asideViolations({ clause: sixty, place: 'before' }, context)).not.toContain(
        'too_many_segments',
      );
    }
    expect(MAX_ALERT_SEGMENTS).toBe(2);
  });
});
