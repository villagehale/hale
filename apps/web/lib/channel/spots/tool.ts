import { type RegisteredTool, defineTool } from '@hale/agent';
import { z } from 'zod';
import { deidentifyActivityQuery } from '~/lib/channel/activity/deidentify';
import type { BoundActivityReader } from '~/lib/channel/activity/reader';
import { isGsm7 } from '~/lib/channel/sms-segments';
import type { FetchPage } from '~/lib/registration/verify-sweep';
import { type SpotReading, readSpot } from './availability';
import type { SpotWatchIntent } from './store';
import { SPOT_PORTAL_HOSTS, type SpotUrlRefusal, sanitizeSpotUrl } from './url';

/**
 * VIL-337 · `watch_for_opening` — the one verb that starts a watch.
 *
 * IT WRITES NOTHING, like the two verbs it is built on (`promise_activity_followup`,
 * `offer_full_plan`): the row is minted against the outbound message that carried the
 * arming sentence, and that message is still being composed while this runs. So the
 * handler decides, and the intent rides out of the turn to the router.
 *
 * EVERY REFUSAL IS A SENTENCE THE MODEL READS MID-TURN, never a boolean. A watch is a
 * standing promise to text a household for sixty days, and the four ways it can be
 * wrong are four different true things to say — "they never agreed to be texted", "that
 * is not a page I can read", "that class is not full, here is the link", "give me a
 * label without a name in it". A tool that answered `{ watching: false }` would let the
 * model choose which of those to tell the parent, and the one it chose on 2026-08-20
 * was the comfortable one.
 *
 * THE READ IS LIVE AND IN THIS TURN, which is the property that makes the ack honest: a
 * watch is armed only against a page that a fetch, six seconds ago, said was FULL with
 * registration OPEN. Everything cheaper than that fetch — consent, the registry, the
 * label gate — is asked first, so a refusal costs a municipal server nothing.
 */

/**
 * The arming read's budget. Deliberately under the coach's own turn budget and well
 * under the sweep's: a parent is holding a phone, and a portal that cannot answer in six
 * seconds is one this turn declines to wait for rather than one it fails over.
 */
export const MINT_FETCH_TIMEOUT_MS = 6_000;

export interface SpotWatchPorts {
  /** The RAW body, not the stripped page: a BookMe4 course carries its availability in
   * a <script> block that `createFetchPage`'s strip deletes (verify-sweep.ts). */
  fetchBody: FetchPage;
  /** The household's own names, for the label gate. The same reader phase 0 uses, so
   * the set of labels refused here is exactly the set the outbound redactor replaces. */
  reader: Pick<BoundActivityReader, 'householdNames'>;
  /** Has this parent said yes to Hale texting first? Read through the port the outbound
   * gate itself uses, so a watch cannot be armed for a household the gate would then
   * silently refuse to text (outbound-gate.ts). */
  watchConsentGranted: (parentUserId: string) => Promise<boolean>;
}

export interface SpotWatchToolArgs extends SpotWatchPorts {
  onWatch: (watch: SpotWatchIntent) => void;
}

/** Every portal Hale has actually read, as a parent would hear them listed. */
function portalList(): string {
  const labels = Object.values(SPOT_PORTAL_HOSTS).map((portal) => portal.portalLabel);
  if (labels.length === 0) return 'no portals yet';
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

/** WHY THIS LINK CANNOT BE WATCHED, in the words the model will use. Per reason rather
 * than one sentence, because "that is not a course page" and "that portal is not one I
 * read" send a parent to two different next moves. */
function urlRefusal(reason: SpotUrlRefusal): string {
  const portals = portalList();
  switch (reason) {
    case 'host_not_allowed':
      return `That link is not a portal I can read. I can only watch ${portals} - tell the parent that plainly, and do not offer to watch anything else.`;
    case 'not_https':
      return 'That link is not a secure address, so I will not poll it. Ask the parent to copy the link out of their browser bar on the course page itself.';
    case 'has_credentials':
      return 'That link carries a sign-in in it, so I will not store or poll it. Ask the parent for the plain course-page address without their login in it.';
    case 'too_long':
      return 'That link is far too long to be a course page. Ask the parent to open the class itself and copy the address from there.';
    case 'not_a_course_page':
      return `That is not a course page I can read. I can only watch ${portals} course pages - ask the parent for the link from the course itself, not from the search results.`;
  }
}

/** WHY THIS LABEL CANNOT BE STORED. It never quotes the label back: the refusal exists
 * because that string held something that must not be repeated (rule #1). */
const LABEL_REFUSAL = {
  names_a_person: `That label names somebody in the family, and a name never goes into a message Hale sends unprompted. Call watch_for_opening again with the class alone - "Tuesday preschool swim", no names.`,
  rewritten:
    'That label carries something I will not store - a name, a school, an address, a date or an age. Call watch_for_opening again with the class in a few words, in plain terms.',
  not_gsm7:
    'That label has a character a text message cannot carry - a curly quote, a long dash or an emoji. Call watch_for_opening again with plain punctuation.',
  question:
    'That label has a question mark in it, and the opening text may not ask a parent anything. Call watch_for_opening again with the class as a plain phrase.',
  empty:
    'That label is empty. Call watch_for_opening again with the class in a few words - it is what the parent will read months from now.',
} as const;

/** WHY THIS PAGE IS NOT WATCHABLE, off what the read actually returned. */
function readingRefusal(reading: SpotReading, portalLabel: string): string | null {
  if (reading.state === 'unreadable') {
    return `I cannot read that page - it does not carry a class ${portalLabel} publishes. Ask the parent to send the link from the course page itself.`;
  }
  if (reading.state === 'not_registrable') {
    if (reading.reason === 'future') {
      return 'Registration for that class is not open yet, so there is no spot to watch for. Tell the parent the doors are not open on it at all.';
    }
    if (reading.reason === 'offline') {
      return 'That class is not bookable online, so watching the page would tell the parent nothing. Tell them they have to take that one up with the city.';
    }
    return `Registration for that class is not open - ${portalLabel} shows it closed. Tell the parent that, and do not offer to watch it.`;
  }
  if (reading.state === 'open') {
    const seats = reading.model.SpotsLeft;
    return `There is nothing to wait for - ${portalLabel} shows ${seats} ${seats === 1 ? 'spot' : 'spots'} left right now. Give the parent that link back and tell them to book it today.`;
  }
  return null;
}

/**
 * `watch_for_opening` — start watching a full course page for a seat.
 *
 * Registered wherever its ports are wired, dark feature or not: `toAnthropicTools`
 * throws when the skill frontmatter names a tool nobody registered (agent.ts), so the
 * verb's existence is a wiring fact and the feature's darkness is the SWEEP's business.
 */
export function watchForOpeningTool(args: SpotWatchToolArgs): RegisteredTool {
  return defineTool({
    name: 'watch_for_opening',
    description:
      "Start watching a FULL class for a spot to open, on a course page the parent has sent you. `url` is that page's address, exactly as they pasted it - never one you composed, and never a search or listing page: it has to be the page for the one class. `label` is how the parent will recognise the class months later, in a few words and in their own terms ('Tuesday preschool swim'): no name, no age, no question mark. Pass `instant: true` only when they say they want it even in the middle of the night; the default holds an overnight opening until the morning. This reads the page RIGHT NOW and only arms if it is genuinely full with registration open - anything else throws a sentence telling you what is true instead, and you say that. Once armed, Hale re-reads the page about every ten minutes and texts them itself when a spot shows up, so say you are watching it and stop. Do not call this without a link from the parent: ask them for the link from the course page.",
    inputSchema: z.object({
      url: z.string().min(1).max(512),
      label: z.string().min(1).max(40),
      childId: z.string().min(1).optional(),
      instant: z.boolean().optional(),
    }),
    // An INVENTED host and invented GUIDs. Examples ride the cached tool grammar, which
    // sits outside the protections message content gets, and a real course link copied
    // in here would be one household's page offered to every turn (tool.ts).
    inputExamples: [
      {
        url: 'https://cityofexample.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=00000000-1111-2222-3333-444444444444&courseId=55555555-6666-7777-8888-999999999999',
        label: 'Tuesday preschool swim',
      },
      {
        url: 'https://cityofexample.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=00000000-1111-2222-3333-444444444444&courseId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        label: 'Saturday skating',
        instant: true,
      },
    ],
    monetary: false,
    // A watch can be asked for on behalf of one child, so the teen rail resolves it
    // before the handler runs (rule #1/#5) — the same refusal the other child-scoped
    // verbs take. The label gate below is what holds when no childId is passed.
    touchesChildContent: true,
    // `{ watching: true }` and nothing else: the model has finished composing by the
    // time it calls this, and the sentence it wrote beside the call is the reply.
    registersOnly: true,
    handler: async (input, ctx) => {
      // CONSENT FIRST, and on the parent who is texting. 'Tell me if a spot opens' is
      // not itself proactive-watch consent in v1: the instrument is the intake watch
      // offer, and a household that never took it is one Hale may not text first.
      if (!(await args.watchConsentGranted(ctx.actor))) {
        throw new Error(
          'This household has not said yes to Hale texting them first, so I cannot watch anything for them. Say so plainly and give them the page to check themselves.',
        );
      }

      const link = sanitizeSpotUrl(input.url);
      if (!link.ok) throw new Error(urlRefusal(link.reason));

      // THE LABEL IS THE ONE FREE-TEXT FIELD THAT SURVIVES THIS TURN. It is stored for
      // sixty days and printed inside a text Hale sends unprompted, so it crosses the
      // same gate as a search subject — and then two more, because that gate is allowed
      // to REWRITE and this field may not be rewritten.
      const householdNames = await args.reader.householdNames(ctx.familyId);
      const collapsed = input.label.replace(/\s+/g, ' ').trim();
      const gated = deidentifyActivityQuery({
        subject: input.label,
        municipality: null,
        stage: null,
        householdNames,
      });
      if (!gated.ok) {
        throw new Error(
          gated.refusal === 'names_a_person'
            ? LABEL_REFUSAL.names_a_person
            : LABEL_REFUSAL.empty,
        );
      }
      // `scrubResidualPii` REWRITES ages ("3 years" → "[redacted]") and gateFreeText
      // returns the rewrite as ok. Storing it would text a parent about their
      // "[redacted]" class; refusing hands the model a sentence it can act on.
      if (gated.query.subject !== collapsed) throw new Error(LABEL_REFUSAL.rewritten);
      // The opening text carries this label and may hold no '?' outside the URL — a
      // proactive text that asks a question is one the parent cannot answer (copy.ts).
      if (collapsed.includes('?')) throw new Error(LABEL_REFUSAL.question);
      // ONE CHARACTER OUTSIDE GSM-7 AND THE OPENING TEXT IS REFUSED - every opening,
      // months from now, by a composer no parent is watching (copy.ts not_gsm7). iOS
      // types a curly apostrophe by default, so a label that arms here and can never be
      // sent is the ordinary case rather than the exotic one.
      if (!isGsm7(collapsed)) throw new Error(LABEL_REFUSAL.not_gsm7);

      let body: string;
      try {
        body = await args.fetchBody(link.url);
      } catch {
        // The portal, not Hale, and the model needs to say so rather than promise a
        // watch. The breadcrumb carries the HOST and nothing else: the error itself
        // holds the parent's url and the turn holds their label (rule #1), and a portal
        // that has stopped answering every arming turn must be visible as more than one
        // sentence to one parent (rule #11).
        console.warn(
          { host: link.host, outcome: 'mint_fetch_failed' },
          'watched spots: the arming read failed',
        );
        throw new Error(
          `I could not reach ${link.portalLabel} just now, so I have not started watching anything. Tell the parent that and ask them to send it again in a bit.`,
        );
      }
      const reading = readSpot(body, link.courseId);
      const refusal = readingRefusal(reading, link.portalLabel);
      if (refusal !== null) throw new Error(refusal);

      args.onWatch({
        url: link.url,
        host: link.host,
        portalLabel: link.portalLabel,
        label: collapsed,
        instant: input.instant ?? false,
        // Never 'open': `readingRefusal` returned null, so this read was full or
        // waitlist_full and the row starts from the state the page actually served.
        lastState: reading.state as 'full' | 'waitlist_full',
      });
      return { watching: true as const };
    },
  });
}
