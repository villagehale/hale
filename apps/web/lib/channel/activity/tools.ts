import { type RegisteredTool, defineTool } from '@hale/agent';
import { z } from 'zod';
import { EXAMPLE_CHILD_ID } from '~/lib/coach/tools';
import type { ActivityPromise } from './commitment';
import { deidentifyActivityQuery, refusalSentence } from './deidentify';
import { MAX_ACTIVITY_CALLS_PER_TURN, type ActivityFinder } from './lane';
import type { BoundActivityReader } from './reader';

/**
 * THE TWO VERBS THE 2026-08-20 TRANSCRIPT NEEDED AND DID NOT HAVE.
 *
 * `find_activities` — look on the web, right now, for something a child can actually do.
 * The turn that produced the incident had exactly one activity verb, `search_village`, and
 * it reads finds the radar has ALREADY discovered. When that read comes back empty the
 * coach has nothing left, which is how a parent asking what there is for their toddler in
 * the fall got a sentence about coming back to them. This is the second source, and it is
 * the one that can answer a question nobody has answered before.
 *
 * `promise_activity_followup` — say "I'll come back to you" in a way that is TRUE. The
 * same turn ended with a promise nothing was holding. This verb registers it on the
 * open-loops ledger, and the sweep owes the family the answer within the day.
 *
 * WHY THE COACH REACHES THE LANE THROUGH A TOOL rather than the lane intercepting the turn
 * in front of the coach (the shape the medical answer takes). An activity question is
 * HALE'S OWN JOB, not an off-domain one, and it arrives mixed in with everything else a
 * text can carry — "cancel Thursday swim and find something for the fall" is one message
 * and two verbs. A lane in front would have to re-decide the whole turn to answer half of
 * it. As a tool it composes: the coach still drafts the cancellation, still holds the two
 * draft cap, and still writes ONE message in its own voice with the find in it.
 *
 * SOURCING IS STRUCTURAL, NOT ASKED FOR. Everything `find_activities` returns carries
 * `source: 'web'`, stamped in the lane. There is no argument or field through which a web
 * find could present as one of ours. What the skill then owes the parent is the phrasing —
 * "their site says" — and what it must NOT do is go quiet because a fact is unverified.
 *
 * THE PER-TURN CEILING is a closure, the way the draft cap is: a fresh tool set is built
 * per turn (runtime.ts), so this text's budget can never be spent by the last one's.
 */

export interface ActivityToolArgs {
  /** The three facts phase 0 needs, read from the DATABASE and never from the model —
   * see reader.ts for why the town and the age band may not be model-supplied. */
  reader: BoundActivityReader;
  finder: ActivityFinder;
  /**
   * Told when the turn PROMISES to come back. The mirror of `onOffer` in the coach's own
   * tools and for the same reason: `agent_commitments.created_from` is NOT NULL against
   * the outbound row that carried the promise, and at tool-call time nothing has been
   * sent. So the tool registers an intent and the router writes the row once the transport
   * has taken the reply — a turn that fails in between promised nobody anything.
   */
  onPromise(promise: ActivityPromise): void;
}

/** What a search came back with, in the shape the model reads. `found: false` carries the
 * REASON, because "there is nothing running" and "I could not look just now" are two
 * different true sentences and the skill says a different one for each (rule #11). */
export function findActivitiesTool(args: Omit<ActivityToolArgs, 'onPromise'>): RegisteredTool {
  let callsThisTurn = 0;

  return defineTool({
    name: 'find_activities',
    description:
      "Look on the LIVE WEB, right now, for real programs, classes, camps or drop-ins a child could actually do — the second source alongside `search_village`, and the one to use when the radar has nothing or the parent names a place you have no find for. `subject` is the activity in a short phrase and NOTHING ELSE: no name, no age, no address, no postal code — the child's age band and the family's town are attached for you from their record and are the only location and age that ever leave the building. Returns at most three picks, each with a name, an age fit and `sourceName` — whose page the facts were read off — plus `when` and `price` WHERE THAT PAGE PUBLISHED THEM. A null `when` or `price` means it had not (fall times not up yet, schedule behind a registration login); the program is still real, so hand it over and say what the site did not say, and never fill the gap with a day or a figure of your own. Every pick is `source: 'web'`: these are things their own site says, NOT finds we have verified, and saying so is the honest way to hand them over. Never claim a web find is confirmed, and never withhold one because it is not. `found: false` with `reason: 'no_picks'` means the search ran and there is genuinely nothing — say so plainly; any other reason means the search itself could not run.",
    inputSchema: z.object({
      subject: z.string().min(1),
      /** The season or window the parent asked about, in their own general terms. */
      window: z.string().optional(),
      childId: z.string().min(1).optional(),
    }),
    // Invented placeholder only — examples are compiled into a cached tool grammar that
    // sits outside the protections message content gets (rule #1; see EXAMPLE_CHILD_ID).
    inputExamples: [
      { subject: 'toddler gymnastics', window: 'this fall' },
      { subject: 'indoor swim lessons', childId: EXAMPLE_CHILD_ID },
    ],
    monetary: false,
    // A child-scoped search names a child, so the guarded invoker's teen check runs BEFORE
    // this handler — a 13+ child's activities are not a thing Hale searches the web about
    // on a parent's behalf (rule #1/#5). A household-wide search names nobody and passes.
    touchesChildContent: true,
    handler: async (input, ctx) => {
      // The per-turn ceiling, refused as a sentence the model reads mid-turn rather than
      // as a silent empty result: a model that has looked twice and wants a third go is
      // told to answer with what it has (rule #11 — never a no-op dressed as an outcome).
      if (callsThisTurn >= MAX_ACTIVITY_CALLS_PER_TURN) {
        throw new Error(
          `You have already searched the web ${MAX_ACTIVITY_CALLS_PER_TURN} times this turn. Answer with what those searches found.`,
        );
      }
      callsThisTurn += 1;

      const childId = input.childId ?? null;
      const [municipality, stage, householdNames] = await Promise.all([
        args.reader.municipality(ctx.familyId),
        args.reader.stage(ctx.familyId, childId),
        args.reader.householdNames(ctx.familyId),
      ]);

      const deidentified = deidentifyActivityQuery({
        subject: input.subject,
        window: input.window ?? null,
        municipality,
        stage,
        householdNames,
      });
      if (!deidentified.ok) {
        // The recompose loop, exactly as `offer_full_plan` runs it: the refusal is a
        // sentence the model answers by calling again with a subject that is about the
        // activity. Nothing has been searched, so nothing has been spent.
        throw new Error(refusalSentence(deidentified.refusal));
      }

      const result = await args.finder.find(deidentified.query);
      if (!result.found) return { found: false as const, reason: result.reason };
      return { found: true as const, picks: result.picks };
    },
  });
}

/**
 * `promise_activity_followup` — register that Hale is coming back about this.
 *
 * IT DOES NOT WRITE THE ROW, for the reason `offer_full_plan` does not: nothing has been
 * sent at tool-call time, and a promise minted against a message that never reached a
 * transport is a debt for a sentence nobody read.
 *
 * IT WRITES NO COPY EITHER. The model says the coming-back sentence in its own voice, in
 * the message it is already composing — this verb only makes the sentence true. A tool
 * that handed back finished copy would put two authors on one message, which the offer
 * tool learned the hard way.
 */
export function promiseActivityFollowUpTool(args: {
  reader: Pick<BoundActivityReader, 'householdNames'>;
  onPromise(promise: ActivityPromise): void;
}): RegisteredTool {
  return defineTool({
    name: 'promise_activity_followup',
    description:
      "Register that you are telling this parent you will COME BACK to them about an activity search - because the web search could not run, because what you found needs checking, or because what they want is not out yet. Call it in the same turn you say so, and only when you actually say so. `subject` is the short, de-identified phrase you will search again on ('toddler gymnastics this fall'): no name, no age, no address. A sweep owes this family an answer within a day - the finds, or an honest account of not finding them - so a promise registered here is one Hale is on the hook for. Do NOT call it when you have already answered: a find you just handed over needs no follow-up. Say the coming-back sentence yourself, in your own words, in this message.",
    inputSchema: z.object({
      subject: z.string().min(1),
      childId: z.string().min(1).optional(),
    }),
    inputExamples: [
      { subject: 'toddler gymnastics this fall' },
      { subject: 'weekend swim lessons', childId: EXAMPLE_CHILD_ID },
    ],
    monetary: false,
    // `{promised:true}` and nothing else, so the message the model writes beside this
    // call is the finished one — the loop ends on it rather than asking for it again
    // (tool.ts registersOnly; this tool is why the flag exists).
    registersOnly: true,
    // A child-scoped promise names a child, so the teen gate runs before the handler —
    // the same refusal `offer_full_plan` takes (rule #1/#5).
    touchesChildContent: true,
    handler: async (input, ctx) => {
      // PHASE 0 ON THE WAY IN, not on the way out. The subject is stored and then handed
      // to `web_search` by the sweep a day later, with no model between it and the border
      // — so it has to clear the same de-identification the live search does, HERE, where
      // there is still a model to hand the refusal back to (rule #1).
      const householdNames = await args.reader.householdNames(ctx.familyId);
      const deidentified = deidentifyActivityQuery({
        subject: input.subject,
        municipality: null,
        stage: null,
        householdNames,
      });
      if (!deidentified.ok) throw new Error(refusalSentence(deidentified.refusal));

      args.onPromise({ subject: deidentified.query.subject, childId: input.childId ?? null });
      return { promised: true as const };
    },
  });
}
