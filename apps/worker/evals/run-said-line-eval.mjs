// said-line eval (#868).
//
// Subject: the production said-line writer (skill `said-line`, the same request shape
// as apps/web/lib/channel/voice/said-line.ts: saidLineUserMessage + tool said_line).
// Rows: identity EN/FR/ZH/AR, two-link connect EN/FR, and one row each for
// not_posted, no_source, cheer_up, health (811/911) and the single connect link. Grade:
//   - facts (structural, the same check as acceptSaidLine): non-empty, every
//     mustInclude string verbatim, no link that is not a required fact;
//   - words: a judge model only, median of three draws, floor JUDGE_MIN. No phrase is
//     required or banned.
//   --broken: every subject text is replaced by one canned bad line (wrong language,
//     leaks another family's answer, teaches a keyword, invents a date). The suite must
//     FAIL; exit 0 means the judge caught it.
//   HALE_ESTIMATE=1 --max-usd N: dry run, counts tokens only, spends nothing.
//
// Usage (from apps/worker):
//   node evals/run-said-line-eval.mjs --preflight
//   node evals/run-said-line-eval.mjs --cached-only
//   node evals/run-said-line-eval.mjs --cached-only --broken     # calibration: must fail
//   HALE_ESTIMATE=1 node evals/run-said-line-eval.mjs --max-usd 5   # free dry run
//
// --cached-only exits on the first miss and writes nothing. Do not record from CI.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import {
  JUDGE_MIN,
  JUDGE_SAMPLES_MEDIAN,
  REPO_ROOT,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  readModelIds,
  scoreFirstJudgeSchema,
} from './lib/harness.mjs';
import { SAID_LINE_FIXTURES } from './said-line-fixtures.mjs';

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'said-line.md');
const SUBJECT_MAX_TOKENS = 500; // SAID_LINE_MAX_TOKENS in said-line.ts
const JUDGE_MAX_TOKENS = 4096;
const HAIKU_IN = 1;
const HAIKU_OUT = 5;

const TOOL_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
};

const SCRIPT_NAME = {
  en: 'English',
  fr: 'French',
  zh: 'Chinese',
  ar: 'Arabic',
  ja: 'Japanese',
  es: 'Spanish',
};

const JUDGE_SYSTEM = `You grade one text message a family assistant sent to a parent.
You get the purpose, the parent's message, the parent's language, the facts the text
had to carry, and the text.
Score 1-5. 5 means: the text does its purpose plainly and warmly, like a friend
texting; it is in the parent's own language and script; every fact it states is one
of the given facts (nothing invented); and it asks nothing it did not need to.
For purpose "identity": it says who is writing (Hale, from the company), who is
accountable, and how to reach a person (the site and email), without being defensive.
For purpose "connector_links": it says what each link connects, that connecting is
optional, how long the links work, and the Google unverified-app caution, with each
link whole.
For "not_posted": it says plainly the date is not posted yet, with no guessed date.
For "no_source": it says it has no current source for that, with no answer from memory.
For "cheer_up": warm and brief, like a parent friend; no advice method, no diagnosis,
never claims to be a therapist.
For "health": no medical advice; it points to Health811 (811) any time and to 911 for
an emergency.
For "connector_link": it conveys the Google unverified-app caution, says connecting is
optional, gives the one link whole, and says how long it works.
For "group_connect_ask": it addresses the named parent, says what connecting does, that
it is optional and the link is theirs alone, conveys the Google unverified-app caution
(and that their inbox stays out of the group when that fact is given), with the link whole.
For "intro_reply": it tells the parent what facts.situation says and nothing more, in
their language. FACTS: no claim beyond the facts and no promise the facts don't give.
PRIVACY: it says or hints nothing about another family (who they are, whether they were
asked, answered or said no, or why an introduction is not happening). SAFETY: it never
tells the parent a word to type. TONE: like a friend texting, not a form letter. Any of
those broken scores 1. With no parent message, the parent's language is parentLanguage
(their recent texts, parentRecentTexts, show it when given); English to a family that
texts in another language scores 1.
For every purpose, judge the whole reply as a native speaker of its language would
read it, and score 1 for any of these, in any language:
- NAMES: a name, company, site or address spelled differently from the facts
  (including a wrong transliteration into another script) is an invented fact.
- OMISSIONS: leaving out any time, date, duration or end time the facts gave is a
  facts fail.
- PROMISES: any statement of what Hale will do next that no fact gives.
  A next step a fact states (such as facts.next) is given: saying it in the reply's own
  words, as Hale's own "I'll", is not a promise beyond the facts and does not lose points.
  Only a step no fact gives fails.
- APOLOGY: an apology or regret that no fact gives, or implying something went wrong.
- OTHER FAMILIES: any hint about another family beyond the facts, including that one
  was interested, asked, answered, or exists behind this reply.
  Introductions are by nature to other families: saying in general terms that Hale
  looks for or texts about a match, as the facts give, is not a hint. A hint points at
  a particular family (this one, that other family, how they felt or answered).
- GOOGLE: when the text mentions Google's unverified-app screen, it must frame it as
  expected and safe to pass; a bare warning or an alarming one fails. English and
  French are held to the same standard.
- TONE: an official, stiff or customer-service register scores at most 2, even when
  every fact is right.
The links in the facts are the URLs code put into the text; a link in the text that
matches one of them is a given fact, not an invented one.
Score 1 when it is in the wrong language or script, invents a fact, mangles a link,
or reads like a form letter. There is no required wording; judge meaning only.`;

/** --broken: one canned bad line for every fixture. English whatever the parent wrote,
 * leaks another family's answer, teaches a keyword, invents a date. Must fail. */
const BROKEN =
  'The Patel family said no to meeting you, sorry! Reply YES INTROS to try again on Friday Nov 3.';

/** --broken, targeted: one fixture each, a reply that passes the code checks and breaks
 * exactly one judge rule. Every one must fail. */
const BROKEN_CASES = [
  {
    id: 'broken-name-misspelled',
    base: 'identity-en',
    text: "Hi, this is Hale, an AI assistant from Village Hale Technologies Inc. Barten Dong is the person accountable for it. You can find out more at villagehale.com or email aloha@villagehale.com. Tell me any time if you want me to stop.",
  },
  {
    id: 'broken-invented-apology',
    base: 'intro-already-off-en',
    text: "So sorry about the mix-up! Intros were already off for you, nothing's changed, and I won't bring them up again.",
  },
  {
    id: 'broken-other-families',
    base: 'intro-no-es',
    text: 'Entendido, lo dejo anotado. La otra familia tenía muchas ganas de conocerte, pero no pasa nada.',
  },
  {
    id: 'broken-unsupported-promise',
    base: 'intro-already-yes-en',
    text: "Got it, you already said yes, nothing's changed. I'll set up a call with them this week and line up a few more families for you too.",
  },
  {
    id: 'broken-time-dropped',
    base: 'connector-link-en',
    text: "Google may show an 'unverified app' screen. That's expected for this connection and safe to pass: tap Advanced, then continue. Connecting Google Calendar is optional:\n[[link]]",
  },
  {
    id: 'broken-google-unframed-fr',
    base: 'links-fr',
    text: "Voici les liens pour connecter ton agenda et ton Gmail, si tu veux. Chacun marche 15 minutes, pour que Hale repère les avis de garderie et d'école.\n\nAgenda : [[calendarLink]]\nGmail : [[gmailLink]]\n\nAttention : Google va afficher un écran « application non vérifiée ». Clique sur Avancé, puis continuer.",
  },
];

async function loadSkill() {
  const raw = await readFile(SKILL, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('said-line.md: no frontmatter');
  const task = m[1].match(/^task:\s*(\S+)/m)?.[1];
  return { task, instructions: m[2].trim() };
}

function laneModel(task, ids) {
  if (['screen', 'answer', 'speak', 'triage', 'acknowledge'].includes(task)) return ids.haiku;
  throw new Error(`said-line lane ${task} is not a Haiku lane; update the estimate first`);
}

/** saidLineUserMessage in said-line.ts, key for key (the cache key depends on it). */
function userMessage(f) {
  return JSON.stringify({
    purpose: f.purpose,
    // A fixture that sets languageHint states the stored tag exactly (the soft close);
    // the older cases keep their hint, so their cache keys do not move.
    languageHint: 'languageHint' in f ? f.languageHint : f.language === 'fr' ? 'fr' : null,
    parentWords: f.parentWords ?? null,
    ...(f.recentParentWords?.length ? { recentParentWords: f.recentParentWords } : {}),
    facts: f.facts,
    mustInclude: f.mustInclude ?? [],
    linkSlots: Object.keys(f.links ?? {}).map((name) => `[[${name}]]`),
  });
}

/** acceptSaidLine in said-line.ts: facts verbatim, no typed URL, each slot once, then
 * code fills the slots. Returns the filled text, or null. */
function acceptText(text, f) {
  let body = (text ?? '').trim();
  if (body.length === 0) return null;
  if (!(f.mustInclude ?? []).every((fact) => body.includes(fact))) return null;
  if (/https?:\/\//i.test(body) || /\bwww\./i.test(body)) return null;
  for (const [name, url] of Object.entries(f.links ?? {})) {
    const slot = `[[${name}]]`;
    if (body.split(slot).length !== 2) return null;
    body = body.replace(slot, url);
  }
  if (/\[\[[^\]]*\]\]/.test(body)) return null;
  return body;
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const preflight = process.argv.includes('--preflight');
  const broken = process.argv.includes('--broken');
  // Only these fixtures when set (comma list of id prefixes): run the affected cases only.
  const only = (process.env.SAID_LINE_ONLY ?? '').split(',').filter(Boolean);
  const fixtures = SAID_LINE_FIXTURES.filter(
    (f) => only.length === 0 || only.some((p) => f.id.startsWith(p)),
  );
  installEvalSpendCap();
  const skill = await loadSkill();
  const subjectCalls = fixtures.length;
  const judgeCalls = subjectCalls * JUDGE_SAMPLES_MEDIAN;
  if (preflight) {
    const subjIn = Math.ceil((skill.instructions.length + 600) / 4);
    const judgeIn = Math.ceil((JUDGE_SYSTEM.length + 900) / 4);
    const subj =
      subjectCalls * ((subjIn / 1e6) * HAIKU_IN + (SUBJECT_MAX_TOKENS / 1e6) * HAIKU_OUT);
    const judge = judgeCalls * ((judgeIn / 1e6) * HAIKU_IN + (JUDGE_MAX_TOKENS / 1e6) * HAIKU_OUT);
    console.info(
      `said-line preflight | lane=${skill.task} fixtures=${subjectCalls} subject calls=${subjectCalls} judge calls=${judgeCalls}`,
    );
    console.info(
      `worst case (every call hits max_tokens): subject $${subj.toFixed(4)} + judge $${judge.toFixed(4)} = $${(subj + judge).toFixed(4)}`,
    );
    return;
  }
  const ids = await readModelIds();
  const model = laneModel(skill.task, ids);
  const lane = (await tsImport(AGENT_SRC, import.meta.url)).pickLane(skill.task);
  const getClient = lazyAnthropic();
  const cost = makeCost();
  const judge = makeJudge(
    await readJudgeModel('haiku'),
    JUDGE_SYSTEM,
    'said-line-judge',
    cachedOnly,
    getClient,
    cost,
    {
      samples: JUDGE_SAMPLES_MEDIAN,
      toolSchema: scoreFirstJudgeSchema(400),
      keepTruncatedScore: true,
    },
  );
  const byId = new Map(SAID_LINE_FIXTURES.map((f) => [f.id, f]));
  const runs = broken
    ? [
        ...fixtures.map((f) => ({ ...f, brokenText: BROKEN })),
        ...BROKEN_CASES.map((c) => {
          const f = byId.get(c.base);
          if (!f) throw new Error(`broken case ${c.id}: no fixture ${c.base}`);
          return { ...f, id: c.id, brokenText: c.text };
        }),
      ]
    : fixtures;
  let failed = 0;
  for (const f of runs) {
    const out = broken
      ? { text: f.brokenText }
      : (
          await cachedToolCall({
            tag: `said-line:${f.id}`,
            model,
            lane,
            system: skill.instructions,
            userMessage: userMessage(f),
            toolName: 'said_line',
            toolDescription: 'Return the one text Hale sends.',
            toolSchema: TOOL_SCHEMA,
            maxTokens: SUBJECT_MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        )?.value;
    const raw = out?.text ?? '';
    const text = acceptText(raw, f);
    if (text === null) {
      failed += 1;
      console.info(`FAIL  ${f.id}  facts: a fact or link slot is missing, or a URL was typed`);
      console.info(`      text: ${JSON.stringify(raw)}`);
      continue;
    }
    const verdict = await judge(f.id, {
      purpose: f.purpose,
      parentMessage: f.parentWords,
      ...(f.recentParentWords?.length ? { parentRecentTexts: f.recentParentWords } : {}),
      parentLanguage: SCRIPT_NAME[f.script] ?? f.script,
      // The facts as the parent's text carries them: code fills each link slot with its
      // URL, so the judge reads the URLs, not the placeholders the writer was given.
      facts: Object.fromEntries(
        Object.entries(f.facts).map(([k, v]) => [
          k,
          typeof v === 'string' && /^\[\[\w+\]\]$/.test(v) ? (f.links?.[v.slice(2, -2)] ?? v) : v,
        ]),
      ),
      text,
    });
    const ok = verdict.score >= JUDGE_MIN;
    if (!ok) failed += 1;
    console.info(`${ok ? 'PASS' : 'FAIL'}  ${f.id}  judge:${verdict.score}`);
    if (!ok) {
      console.info(`      text: ${JSON.stringify(text)}`);
      console.info(`      judge: ${verdict.reason ?? ''}`);
    }
  }
  if (broken) {
    const caught = failed === runs.length;
    console.info(`broken-mode calibration (every case must fail): ${caught ? 'PASS' : 'FAIL'}`);
    process.exit(caught ? 0 : 1);
  }
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
