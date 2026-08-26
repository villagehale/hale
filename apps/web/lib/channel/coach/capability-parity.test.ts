import { describe, expect, it } from 'vitest';
import type { AgentContext } from '~/lib/coach/context';
import { searchVillageTool } from '~/lib/coach/tools';
import { loadCronSkill } from '~/lib/cron/skill';
import { buildChannelCoachTools } from './tools';

/**
 * THE CAPABILITY PARITY GATE (VIL-295).
 *
 * The capability table has THREE readers and only one of them decides anything. At the
 * lane classifier and the provider door the table IS the owner — a row is what routes
 * the text. At the coach it is not: the verifier deleted CAN and CANNOT rows one at a
 * time and the coach's answers did not move, because what the coach can do is what its
 * TOOLS let it do, and the shape of a refusal is what its own doctrine says.
 *
 * That leaves the failure this file exists to prevent, which is not "the coach ignored
 * the table" — it is the table and the coach drifting apart while both look fine. A row
 * that says Hale cannot do a thing it has a tool for is a refusal Hale will never make
 * and a promise the classifier will act on anyway; a row that says Hale can do a thing
 * with no path behind it routes a parent to a coach that has nothing to answer with.
 * Neither shows up in a corpus, because each surface is individually right.
 *
 * So: one owner per surface, and this asserts they cannot contradict each other. It is
 * the same move `skill-parity.test.ts` makes for the tool allowlist — derive one side
 * from the code, read the other out of the prompt, and fail on the difference.
 * Deterministic, no model, no corpus.
 */

/**
 * How the coach actually serves (or does not serve) each row of the table.
 *
 * A path is the reason a CAN row is true. `tool` is the strong kind — the model can
 * literally call it — and it is the one that has to be right, because a tool is also
 * the thing that makes a CANNOT row a lie. `clause` is a sentence of the skill that
 * carries a capability with no verb behind it. `context` is a field the runtime injects,
 * typed as `keyof AgentContext` so deleting the field breaks the build here rather than
 * quietly leaving the table claiming something the coach was never handed.
 */
type CoachPath = { tool: string } | { clause: string } | { context: keyof AgentContext };

/**
 * The join, row by row. This is NOT a third owner: nothing here states what Hale does.
 * It states which two already-existing things — a table row and a coach path — are about
 * the same capability, and every assertion below reads the verdict off the table and the
 * evidence off the code.
 *
 * `row` is a distinctive fragment of the row's first cell rather than the whole cell:
 * rewording a row should not turn this red, but DELETING one or MOVING one between CAN
 * and CANNOT must.
 */
const COACH_PATHS: ReadonlyArray<{ row: string; paths: readonly CoachPath[] }> = [
  {
    row: 'the week:',
    paths: [
      { tool: 'lookup_week' },
      { tool: 'propose_calendar_move' },
      { tool: 'propose_calendar_cancel' },
      { tool: 'propose_calendar_add' },
    ],
  },
  // No verb: the radar's own dates arrive in the prompt already checked, and the skill
  // section that spends them is what makes the row true.
  { row: 'waitlists', paths: [{ clause: '`registrationWindows`' }] },
  {
    row: 'playgrounds',
    paths: [
      { tool: 'search_village' },
      { tool: 'find_activities' },
      { tool: 'promise_activity_followup' },
    ],
  },
  { row: 'raising kids:', paths: [{ tool: 'get_framework_guidance' }, { tool: 'offer_full_plan' }] },
  { row: 'routine health admin', paths: [{ tool: 'lookup_week' }] },
  { row: 'telling a friend', paths: [{ tool: 'share_referral_link' }] },
  // The one capability with neither a verb nor a clause. `save_memory` is deliberately
  // absent from this surface (see tools.ts), so what the parent said before reaches the
  // model as context or not at all.
  { row: 'has told it before', paths: [{ context: 'memoryFacts' }] },

  // Below the line: every row the table says is past Hale. An empty path list is the
  // assertion — see the CANNOT test, which fails the moment one of these acquires a verb.
  { row: 'the forecast', paths: [] },
  { row: 'holding a spot', paths: [] },
  { row: 'a dose', paths: [] },
  { row: 'diagnosis', paths: [] },
  { row: 'specific practitioner', paths: [] },
  { row: 'legal advice', paths: [] },
  { row: 'groceries', paths: [] },
];

/**
 * The rows of one `## ` section of the table, as the first cell of each.
 *
 * Read out of `skill.instructions` rather than off disk on purpose: that string is the
 * partial already substituted in, so this also proves the table reached the coach at all.
 * A dropped `{{include:…}}` empties both sections and every assertion below goes red.
 */
function tableRows(instructions: string, heading: string): string[] {
  const section = instructions.split(`## ${heading}`)[1];
  if (section === undefined) throw new Error(`capability table: no '## ${heading}' section`);
  return section
    .split('\n## ')[0]!
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) => line.split('|')[1]!.trim())
    .filter((cell) => cell !== '' && cell !== 'the ask' && !/^-+$/.test(cell));
}

describe('capability table ↔ the coach that has to honour it', () => {
  const registered = () =>
    buildChannelCoachTools({
      familyId: 'f',
      reader: {} as never,
      draftPort: {} as never,
      villageTool: searchVillageTool({} as never),
      activity: { reader: {} as never, finder: {} as never },
      onOffer: () => {},
      onShare: () => {},
      onPromise: () => {},
      now: new Date(),
    }).map((t) => t.name);

  const sections = async () => {
    const skill = await loadCronSkill('coach-channel-sms');
    return {
      can: tableRows(skill.instructions, 'CAN'),
      cannot: tableRows(skill.instructions, 'CANNOT'),
      instructions: skill.instructions,
    };
  };

  const matching = (rows: string[], fragment: string) =>
    rows.filter((row) => row.toLowerCase().includes(fragment.toLowerCase()));

  /**
   * Both completeness directions at once. A row nobody claimed is a capability the table
   * promises and nothing in the coach answers; an entry that matches no row is a claim
   * about a table that no longer says it.
   */
  it('accounts for every row of the table exactly once, and claims no row that is gone', async () => {
    const { can, cannot } = await sections();
    const all = [...can, ...cannot];

    expect(
      COACH_PATHS.map((entry) => `${entry.row} → ${matching(all, entry.row).length}`).filter(
        (line) => !line.endsWith('→ 1'),
      ),
    ).toEqual([]);

    const claimed = all.filter((row) =>
      COACH_PATHS.some((entry) => row.toLowerCase().includes(entry.row.toLowerCase())),
    );
    expect(all.filter((row) => !claimed.includes(row))).toEqual([]);
  });

  /** A CAN with no path behind it is a promise the coach cannot keep. */
  it('has a real coach path behind every CAN row', async () => {
    const { can, instructions } = await sections();
    const tools = new Set(registered());

    const broken: string[] = [];
    for (const entry of COACH_PATHS) {
      if (matching(can, entry.row).length === 0) continue;
      if (entry.paths.length === 0) {
        broken.push(`${entry.row}: table says CAN, no path declared`);
        continue;
      }
      for (const path of entry.paths) {
        if ('tool' in path && !tools.has(path.tool)) {
          broken.push(`${entry.row}: no such tool '${path.tool}'`);
        }
        if ('clause' in path && !instructions.includes(path.clause)) {
          broken.push(`${entry.row}: the skill no longer says '${path.clause}'`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  /**
   * The other direction, and the sharper one. The coach refuses what it has no verb for,
   * so a CANNOT row that HAS a verb is a refusal the model will never make — the parent
   * is told no by the classifier and yes by the coach, which is the split VIL-295 opened
   * with.
   */
  it('leaves every CANNOT row without a tool', async () => {
    const { cannot } = await sections();
    const tools = new Set(registered());

    const armed: string[] = [];
    for (const entry of COACH_PATHS) {
      if (matching(cannot, entry.row).length === 0) continue;
      for (const path of entry.paths) {
        if ('tool' in path && tools.has(path.tool)) {
          armed.push(`${entry.row}: table says CANNOT, but the coach registers '${path.tool}'`);
        }
      }
    }
    expect(armed).toEqual([]);
  });

  /**
   * Every verb the coach owns is somewhere in the CAN column. This is the direction that
   * catches the drift nobody notices: a tool added months after the table was written,
   * doing work the table never admitted Hale does.
   */
  it('finds a CAN row for every tool the coach registers', async () => {
    const { can } = await sections();
    const declared = new Set(
      COACH_PATHS.filter((entry) => matching(can, entry.row).length > 0).flatMap((entry) =>
        entry.paths.flatMap((path) => ('tool' in path ? [path.tool] : [])),
      ),
    );

    expect(registered().filter((name) => !declared.has(name))).toEqual([]);
  });

  /**
   * One table, two readers. The classifier is where the rows actually decide something,
   * so a coach reading a table the classifier does not read is back to two opinions.
   */
  it('shows the lane classifier the same table', async () => {
    const coach = await sections();
    const lane = await loadCronSkill('inbound-lane');

    expect(tableRows(lane.instructions, 'CAN')).toEqual(coach.can);
    expect(tableRows(lane.instructions, 'CANNOT')).toEqual(coach.cannot);
  });
});
