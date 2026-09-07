import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AuditEntry, compileToolSchema, invokeTool } from '@hale/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpotWatchIntent } from './store';
import { watchForOpeningTool } from './tool';

/**
 * VIL-337 · the mint, and the four things it must refuse.
 *
 * A watch is a standing outbound poll and a standing promise to text, minted from one
 * sentence a parent typed. So the question every test here asks is not "does it store
 * the row" — it stores nothing — but "what does it decline to arm, and does the model
 * hear a sentence it can say".
 *
 * THE ARMING READ IS LIVE AND IN-TURN, which is why the fetch port is counted rather
 * than merely stubbed: a refusal that still went to the portal is a refusal that spent
 * a parent's six seconds and a municipal server's request, and every gate below it
 * (consent, the registry, the label) is cheaper than the page.
 */

const MARKHAM = 'cityofmarkham.perfectmind.com';
const WIDGET = '15f6af07-39c5-473e-b053-96653f77a406';
const FULL_COURSE = '85770d4d-bce9-4e53-b969-cf7e88775180';
const OPEN_COURSE = '961140fe-0866-460f-9973-7c42cbe0a928';
const CLOSED_COURSE = '4241ad2f-9b67-464f-9f19-ad5f46d4a92d';

function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', `${name}.html`), 'utf8');
}

function courseUrl(courseId: string, extra = ''): string {
  return `https://${MARKHAM}/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=${WIDGET}&courseId=${courseId}${extra}`;
}

const CTX = { familyId: 'fam-1', actor: 'parent-1' };

function ports(overrides: Partial<Parameters<typeof watchForOpeningTool>[0]> = {}) {
  const armed: SpotWatchIntent[] = [];
  const fetchBody = vi.fn(async () => fixture('open-window-markham'));
  const tool = watchForOpeningTool({
    fetchBody,
    reader: { householdNames: async () => [] },
    watchConsentGranted: async () => true,
    onWatch: (watch) => armed.push(watch),
    ...overrides,
  });
  return { tool, fetchBody, armed };
}

// LIT, for every test below that expects an arm. The verb refuses outright while the
// feature is dark, so "the sweep is on and this family is armed" is the precondition of
// every other gate in this file rather than a case of its own.
beforeEach(() => {
  vi.stubEnv('WATCHED_SPOTS_ENABLED', 'true');
  vi.stubEnv('F14_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * THE DARK GATE, and it is the first thing the handler asks.
 *
 * Every other refusal here is about whether a watch would be HONEST. This one is about
 * whether anything would poll it at all: while `WATCHED_SPOTS_ENABLED` is off the sweep
 * returns before it loads a single row, and a family outside F14 is skipped unread — so
 * a row armed in either state is a sixty-day promise to text that nothing keeps, and
 * the parent has already been told Hale is watching.
 */
describe('watch_for_opening — the dark gate', () => {
  it('refuses while the sweep is switched off, before it reads anybody’s page', async () => {
    vi.stubEnv('WATCHED_SPOTS_ENABLED', 'false');
    const { tool, fetchBody, armed } = ports();

    await expect(
      tool.handler({ url: courseUrl(FULL_COURSE), label: 'Preschool swim' }, CTX),
    ).rejects.toThrow(/cannot watch class pages/i);
    expect(fetchBody).not.toHaveBeenCalled();
    expect(armed).toEqual([]);
  });

  it('refuses a family the sweep would skip unread, before it reads their page', async () => {
    // The flag is on for the product and this household is not in F14's allowlist:
    // `sweepSpot` never runs for them, so an armed row here polls nothing.
    vi.stubEnv('F14_ENABLED', 'false');
    vi.stubEnv('F14_FAMILY_ALLOWLIST', 'fam-other');
    const { tool, fetchBody, armed } = ports();

    await expect(
      tool.handler({ url: courseUrl(FULL_COURSE), label: 'Preschool swim' }, CTX),
    ).rejects.toThrow(/cannot watch class pages/i);
    expect(fetchBody).not.toHaveBeenCalled();
    expect(armed).toEqual([]);
  });

  it('arms for a family named on the allowlist while the F14 flag is off', async () => {
    // THE POSITIVE CONTROL for the case above: without it the gate could refuse every
    // family and both refusals would still pass.
    vi.stubEnv('F14_ENABLED', 'false');
    vi.stubEnv('F14_FAMILY_ALLOWLIST', `other, ${CTX.familyId}`);
    const { tool, fetchBody, armed } = ports();

    await expect(
      tool.handler({ url: courseUrl(FULL_COURSE), label: 'Preschool swim' }, CTX),
    ).resolves.toEqual({ watching: true });
    expect(fetchBody).toHaveBeenCalledTimes(1);
    expect(armed).toHaveLength(1);
  });
});

describe('watch_for_opening — arms only on a full course page, for a consenting household', () => {
  it('refuses a household that never said yes to Hale texting first, before it reads anything', async () => {
    const { tool, fetchBody, armed } = ports({ watchConsentGranted: async () => false });

    await expect(
      tool.handler({ url: courseUrl(FULL_COURSE), label: 'Preschool swim' }, CTX),
    ).rejects.toThrow(/has not said yes/i);
    // The consent gate runs BEFORE the fetch. A gate that ran after would poll a third
    // party on behalf of a family that never agreed to be texted about it.
    expect(fetchBody).not.toHaveBeenCalled();
    expect(armed).toEqual([]);
  });

  it('asks the consent question about the parent who is texting', async () => {
    const asked: string[] = [];
    const { tool } = ports({
      watchConsentGranted: async (parentUserId) => {
        asked.push(parentUserId);
        return true;
      },
    });

    await tool.handler({ url: courseUrl(FULL_COURSE), label: 'Preschool swim' }, CTX);

    // `ctx.actor` is the parent's own user id on the SMS coach. Reading consent for
    // anyone else — the family, a co-parent — would arm a watch nobody consented to.
    expect(asked).toEqual(['parent-1']);
  });

  it('refuses a link that is not a course page on a portal Hale reads', async () => {
    const { tool, fetchBody } = ports();

    await expect(
      tool.handler({ url: 'https://example.com/swim', label: 'Preschool swim' }, CTX),
    ).rejects.toThrow(/Markham's portal/);
    await expect(
      tool.handler({ url: `https://${MARKHAM}/Clients/BookMe4?widgetId=${WIDGET}`, label: 'x' }, CTX),
    ).rejects.toThrow(/course page/i);
    // A COURSE-SHAPED PATH ON A FOREIGN HOST. Both links above fail the path check
    // first, so neither one reaches the registry: without this third call the host
    // allowlist could be deleted and every test here would still pass.
    await expect(
      tool.handler(
        {
          url: `https://example.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=${WIDGET}&courseId=${FULL_COURSE}`,
          label: 'Preschool swim',
        },
        CTX,
      ),
    ).rejects.toThrow(/not a portal I can read/);
    expect(fetchBody).not.toHaveBeenCalled();
  });

  it('refuses a page it could not read, and never calls it full', async () => {
    const { tool, armed } = ports({ fetchBody: async () => fixture('markham-course-not-found') });

    await expect(
      tool.handler({ url: courseUrl(FULL_COURSE), label: 'Preschool swim' }, CTX),
    ).rejects.toThrow(/cannot read/i);
    expect(armed).toEqual([]);
  });

  it('refuses a class whose registration is closed', async () => {
    const { tool, armed } = ports({ fetchBody: async () => fixture('markham-course') });

    await expect(
      tool.handler({ url: courseUrl(CLOSED_COURSE), label: 'Preschool swim' }, CTX),
    ).rejects.toThrow(/not open/i);
    expect(armed).toEqual([]);
  });

  it('hands over the link with the page’s own count when the class is not full', async () => {
    const { tool, armed } = ports({ fetchBody: async () => fixture('open-window-open-markham') });

    // The refusal a parent most wants: there is nothing to wait for, so the model is
    // told to give them the page rather than to promise a text that would never come.
    await expect(
      tool.handler({ url: courseUrl(OPEN_COURSE), label: 'Preschool swim' }, CTX),
    ).rejects.toThrow(/2 spots left/);
    expect(armed).toEqual([]);
  });

  it('arms on a full page, with the SANITIZED url and the state the read returned', async () => {
    const { tool, armed } = ports();

    const result = await tool.handler(
      {
        url: courseUrl(FULL_COURSE, '&redirectedFromEmbededMode=False&sessionId=SECRET'),
        label: 'Preschool swim',
        instant: true,
      },
      CTX,
    );

    expect(result).toEqual({ watching: true });
    expect(armed).toEqual([
      {
        url: courseUrl(FULL_COURSE),
        host: MARKHAM,
        portalLabel: "Markham's portal",
        label: 'Preschool swim',
        instant: true,
        lastState: 'full',
      },
    ]);
  });

  it('defaults `instant` off — a quiet-hours wake-up is opted into, never inferred', async () => {
    const { tool, armed } = ports();

    await tool.handler({ url: courseUrl(FULL_COURSE), label: 'Preschool swim' }, CTX);

    expect(armed[0]?.instant).toBe(false);
  });
});

describe('watch_for_opening — the label is stored, so the label is gated', () => {
  it('refuses a label naming somebody in the household, without repeating the name', async () => {
    const { tool, fetchBody, armed } = ports({
      reader: { householdNames: async () => ['Maya'] },
    });

    // The refusal is read by the model mid-turn and shapes what it writes next, so a
    // sentence that quoted the name back would put it in the reply this gate exists to
    // keep it out of (rule #1).
    const refused = await tool
      .handler({ url: courseUrl(FULL_COURSE), label: 'Maya swim Tue' }, CTX)
      .catch((err: Error) => err);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).not.toContain('Maya');
    expect((refused as Error).message).toMatch(/names somebody/i);
    expect(fetchBody).not.toHaveBeenCalled();
    expect(armed).toEqual([]);

    // POSITIVE CONTROL: a label that merely shares the page's subject arms. Without it
    // this test passes on a gate that refuses everything.
    await tool.handler({ url: courseUrl(FULL_COURSE), label: 'Milliken swim Tue' }, CTX);
    expect(armed).toHaveLength(1);
  });

  it('refuses a label the outbound scrub would REWRITE rather than storing the rewrite', async () => {
    const { tool, armed } = ports();

    // `scrubResidualPii` turns "3 years" into "[redacted]" and reports ok. Storing that
    // would text the parent about their "Preschool swim [redacted]" class months later.
    await expect(
      tool.handler({ url: courseUrl(FULL_COURSE), label: 'Preschool swim 3 years' }, CTX),
    ).rejects.toThrow(/a name, a school, an address, a date or an age/);
    // THE SAME BRANCH, A DIFFERENT PATTERN: the scrub rewrites named schools, streets
    // and dates too, so a refusal that only says "ages" sends a parent who typed a
    // school looking for an age that was never there.
    await expect(
      tool.handler({ url: courseUrl(FULL_COURSE), label: 'Pineview Montessori swim' }, CTX),
    ).rejects.toThrow(/a name, a school, an address, a date or an age/);
    expect(armed).toEqual([]);

    await tool.handler({ url: courseUrl(FULL_COURSE), label: 'Preschool swim' }, CTX);
    expect(armed).toHaveLength(1);
  });

  it('refuses a label carrying a question mark', async () => {
    const { tool, armed } = ports();

    // The label is printed inside the opening text, and the outbound copy gate refuses
    // any '?' outside the URL: a question in a proactive text is one the parent cannot
    // answer. Refusing here is the only place a parent can still be asked for a better
    // label (copy.ts spotOpenViolations).
    await expect(
      tool.handler({ url: courseUrl(FULL_COURSE), label: 'swim Tue?' }, CTX),
    ).rejects.toThrow(/question mark/i);
    expect(armed).toEqual([]);
  });

  it('refuses a label a text message cannot carry, and takes the same label in plain punctuation', async () => {
    const { tool, armed } = ports();

    // iOS substitutes a curly apostrophe for a straight one as you type, so this is the
    // ordinary paste. One such character flips the whole body to UCS-2 and the
    // deterministic opening copy REFUSES it (copy.ts not_gsm7) — every opening, months
    // later, silently. A watch that can never text is worse than one never armed.
    await expect(
      tool.handler({ url: courseUrl(FULL_COURSE), label: 'Tuesday\u2019s preschool swim' }, CTX),
    ).rejects.toThrow(/plain punctuation/);
    expect(armed).toEqual([]);

    // POSITIVE CONTROL: the same words with a straight apostrophe arm. Without it this
    // passes on a gate that refuses every label with an apostrophe in it.
    await tool.handler({ url: courseUrl(FULL_COURSE), label: "Tuesday's preschool swim" }, CTX);
    expect(armed).toHaveLength(1);
  });

  it('refuses a label that is nothing but whitespace', async () => {
    const { tool } = ports();

    await expect(
      tool.handler({ url: courseUrl(FULL_COURSE), label: '   ' }, CTX),
    ).rejects.toThrow(/few words/i);
  });
});

describe('watch_for_opening — when the portal will not answer', () => {
  it('tells the model the portal is down and leaves a breadcrumb naming only the host', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { tool, armed } = ports({
        fetchBody: async () => {
          throw new Error(`socket hang up ${courseUrl(FULL_COURSE)}`);
        },
      });

      await expect(
        tool.handler({ url: courseUrl(FULL_COURSE), label: 'Preschool swim' }, CTX),
      ).rejects.toThrow(/could not reach/i);
      expect(armed).toEqual([]);

      // A read that failed is an outcome, not a silence (rule #11): without this the
      // only trace of a portal that stopped answering every arming turn is the model's
      // own sentence to one parent.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toEqual({ host: MARKHAM, outcome: 'mint_fetch_failed' });
      // AND NOTHING ELSE. The thrown error carries the full url and the turn carries
      // the label; neither may reach a log line (rule #1).
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain(FULL_COURSE);
      expect(logged).not.toContain('Preschool swim');
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves no breadcrumb on the turn that arms', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { tool } = ports();

      await tool.handler({ url: courseUrl(FULL_COURSE), label: 'Preschool swim' }, CTX);

      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('watch_for_opening — through the guarded invoker', () => {
  const guardDeps = (audit: AuditEntry[], teenRefusal = false) => ({
    writeAudit: async (entry: AuditEntry) => {
      audit.push(entry);
    },
    checkChildContentAccess: async () =>
      teenRefusal
        ? { ok: false, reason: 'teen content is redacted from parents by default (rule #1)' }
        : { ok: true, reason: 'no child-specific content requested' },
  });

  it('refuses a 13+ childId before the page is ever fetched', async () => {
    const { tool, fetchBody, armed } = ports();
    const audit: AuditEntry[] = [];

    await expect(
      invokeTool(
        tool,
        { url: courseUrl(FULL_COURSE), label: 'Preschool swim', childId: 'kid-teen' },
        CTX,
        guardDeps(audit, true),
      ),
    ).rejects.toThrow(/child_content/);
    expect(fetchBody).not.toHaveBeenCalled();
    expect(armed).toEqual([]);
    // The rail refuses BEFORE the audit write, so a blocked call is not recorded as an
    // authorized one (tool.ts invokeTool).
    expect(audit).toEqual([]);
  });

  it('records the pre-gate input in the audit row and passes NONE of it on when refused', async () => {
    const { tool, armed } = ports({ reader: { householdNames: async () => ['Maya'] } });
    const audit: AuditEntry[] = [];

    await expect(
      invokeTool(
        tool,
        { url: courseUrl(FULL_COURSE), label: 'Maya swim Tue' },
        CTX,
        guardDeps(audit),
      ),
    ).rejects.toThrow(/names somebody/i);

    // THE DISCLOSED BOUNDARY: `invokeTool` writes the whole validated input before the
    // handler runs, so the parent's own words are on their own trail (rule #6, and the
    // PIPEDA export renders it) — and nothing downstream of the gate ever sees them.
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actionTaken).toBe('tool:watch_for_opening');
    expect(audit[0]?.after).toMatchObject({ label: 'Maya swim Tue' });
    expect(armed).toEqual([]);
  });

  it('refuses an oversized url at the schema, before anything is written down', async () => {
    const { tool, fetchBody } = ports();
    const audit: AuditEntry[] = [];

    await expect(
      invokeTool(
        tool,
        { url: `https://${MARKHAM}/x?${'a'.repeat(600)}`, label: 'Preschool swim' },
        CTX,
        guardDeps(audit),
      ),
    ).rejects.toThrow();
    // Zod runs first in invokeTool, so an absurd paste never reaches audit_log at all.
    expect(audit).toEqual([]);
    expect(fetchBody).not.toHaveBeenCalled();
  });
});

describe('watch_for_opening — the definition the model reads', () => {
  it('declares the rails it needs and the shape the loop can end on', () => {
    const { tool } = ports();

    expect(tool.name).toBe('watch_for_opening');
    // A childId in the input is what the teen rail resolves from; `registersOnly` is
    // what lets the turn's answer stand rather than being re-composed (tool.ts).
    expect(tool.touchesChildContent).toBe(true);
    expect(tool.monetary).toBe(false);
    expect(tool.registersOnly).toBe(true);
  });

  /**
   * THE GRAMMAR IS PINNED BYTE FOR BYTE, because the dark gate went into the HANDLER on
   * purpose. What the model reads — the description and the compiled input schema — is
   * what `apps/worker/evals/run-coach-channel-eval.mjs` replicates verbatim and what
   * every cached agent entry is keyed on, so a gate that had edited a character of it
   * would have re-keyed the whole eval corpus and, worse, changed the verb's REACH: a
   * dark family would have been refused by a model that no longer offered to watch.
   * Registration is unchanged for the same reason (coach/tools.ts).
   */
  it('leaves the cached tool grammar byte-identical — the gate is in the handler', () => {
    const { tool } = ports();

    expect(tool.description).toBe(
      "Start watching a FULL class for a spot to open, on a course page the parent has sent you. `url` is that page's address, exactly as they pasted it - never one you composed, and never a search or listing page: it has to be the page for the one class. `label` is how the parent will recognise the class months later, in a few words and in their own terms ('Tuesday preschool swim'): no name, no age, no question mark. Pass `instant: true` only when they say they want it even in the middle of the night; the default holds an overnight opening until the morning. This reads the page RIGHT NOW and only arms if it is genuinely full with registration open - anything else throws a sentence telling you what is true instead, and you say that. Once armed, Hale re-reads the page about every ten minutes and texts them itself when a spot shows up, so say you are watching it and stop. Do not call this without a link from the parent: ask them for the link from the course page.",
    );
    expect(JSON.stringify(compileToolSchema(tool.inputSchema).schema)).toBe(
      '{"type":"object","properties":{"url":{"type":"string","description":"At least 1 characters. At most 512 characters."},"label":{"type":"string","description":"At least 1 characters. At most 40 characters."},"childId":{"type":"string","description":"At least 1 characters."},"instant":{"type":"boolean"}},"required":["url","label"],"additionalProperties":false}',
    );
  });

  it('names no real household in its examples, and every example satisfies its schema', () => {
    const { tool } = ports();

    expect(tool.inputExamples?.length ?? 0).toBeGreaterThan(0);
    for (const example of tool.inputExamples ?? []) {
      expect(() => tool.inputSchema.parse(example)).not.toThrow();
      // The examples ride the cached tool grammar, outside the protections message
      // content gets — so the host they carry is invented and refused by the sanitizer.
      expect(JSON.stringify(example)).not.toContain(MARKHAM);
    }
  });
});
