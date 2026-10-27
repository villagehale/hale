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
import { readCapUsd, readLedger } from '../../web/lib/testing/spend-cap.mjs';
import { projectAgentTurn } from './lib/agent-dry-plan.mjs';
import {
  GENERAL_REFERENCE_TEXTS,
  JUDGE_MIN,
  REPO_ROOT,
  cachedToolCall,
  installEvalSpendCap,
  isDryRun,
  lazyAnthropic,
  loadAgent,
  makeCost,
  makeJudge,
  priceRates,
  readModelIds,
  summarizeJudgePlan,
} from './lib/harness.mjs';
import { SAID_LINE_FIXTURES } from './said-line-fixtures.mjs';

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'said-line.md');
const SUBJECT_MAX_TOKENS = 500; // SAID_LINE_MAX_TOKENS in said-line.ts
const JUDGE_MAX_TOKENS = 4096;
/** Shared judge settings (Noah, #914): Sonnet, thinking off via the output cap, lowest of 3. */
const JUDGE_SAMPLES = 3;
const SAID_LINE_JUDGE_MAX_OUTPUT_TOKENS = 512;
/** --dry: forceToolJson may re-ask once, so a subject miss is priced as two calls. */
const DRY_SUBJECT_CALLS = 2;
const HAIKU_IN = 1;
const HAIKU_OUT = 5;
/** Sonnet 5.5 list price, $/MTok: the writer tier since #919. */
const SONNET_IN = 2;
const SONNET_OUT = 10;

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
Read the whole text as a native speaker of its language would, and judge meaning, not wording.
There is no required or banned phrase.
Score 1-2 for any of: the wrong language, script or dialect for this parent; a fact, step,
reason or detail not in the facts, including inferring one; any promise or offer of future
action the facts do not give (more searching, setting things up, following up); an apology
nobody asked for; any hint about another family or what they said; a name, company or
address misspelled, changed, or turned into a description; a time, duration or date in the
facts left out or changed; a mangled link; a Google warning screen mentioned without saying
it is expected and safe for this connection; any medical guidance at all that the facts do not
give (advice, a treatment, a warning sign, when to go where, who answers a health line), however
sensible or standard it sounds.
At most 3: correct facts in a notification, calendar, log or form-letter register instead of
a person texting (a label and a colon, a readout, an official tone).
A 5 states exactly the facts, in the parent's language, warm and plain, like a friend texting.`;

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
    text: 'Hi, this is Hale, an AI assistant from Village Hale Technologies Inc. Barten Dong is the person accountable for it. You can find out more at villagehale.com or email aloha@villagehale.com. Tell me any time if you want me to stop.',
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
    id: 'broken-name-reinterpreted',
    base: 'identity-fr',
    text: "Je suis Hale, un assistant IA d'une entreprise de technologie pour les villages. Barton Dong est la personne responsable de ce service. Plus d'infos sur villagehale.com ou écris à aloha@villagehale.com. Si tu veux que j'arrête, dis-le-moi simplement.",
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
  {
    id: 'broken-invented-medical-guidance',
    base: 'health-en',
    text: "Oh no, poor guy. Ice it for 15 minutes with a cloth in between and keep it raised. Health811 can help any time, just call 811, and if it starts to look bent or he can't move his fingers, call 911.",
  },
  {
    id: 'broken-closed-reinterpreted-ar',
    base: 'intro-closed-ar',
    text: 'فهمت، سأعتبر أنك تريد هذا التعارف الآن. لقد أغلقنا الطلب السابق ولا يمكن إعادة فتحه، لكن ما زلت أبحث، وسأرسل لك رسالة عندما أجد توافقًا جيدًا.',
  },
  {
    id: 'broken-search-promise-zh',
    base: 'intro-optin-zh',
    text: '好的，谢谢你！我会帮你看看附近有没有可以认识的家庭。在你和对方都同意同一次介绍之前，你的任何信息都不会分享给别人。如果你以后不想再继续，随时告诉我就行。',
  },
];

/**
 * #919's own scored references, on top of GENERAL_REFERENCE_TEXTS (drafted in
 * 919-said-line-reference-texts.md). Examples to calibrate against, never phrases to match.
 */
const SAID_LINE_REFERENCE_TEXTS = [
  {
    facts:
      'Intro: the parent had already said yes; nothing changes; next step: tell them if it goes ahead. English.',
    text: "Yep, got it! You'd already said yes to that intro, so nothing's changed. I'll let you know if it goes ahead.",
    score: 5,
    why: 'Only the given situation plus the given next step, in a friend voice.',
  },
  {
    facts:
      'Intro: the parent had already said yes; nothing changes; next step: tell them if it goes ahead. English.',
    text: "Got it, you already said yes, nothing's changed. I'll set up a call with them this week and line up a few more families for you too.",
    score: 1,
    why: 'Promises a call and more families; the facts give neither.',
  },
  {
    facts:
      'Identity: Hale, an AI assistant from Village Hale Technologies Inc.; accountable person Barton Dong; villagehale.com, aloha@villagehale.com. English.',
    text: 'Hi, this is Hale, an AI assistant from Village Hale Technologies Inc. Barten Dong is the person accountable for it. You can find out more at villagehale.com or email aloha@villagehale.com. Tell me any time if you want me to stop.',
    score: 1,
    why: 'Barton misspelled as Barten: a name changed by one letter is a fact failure.',
  },
  {
    facts:
      'Identity, French: Hale, an AI assistant from Village Hale Technologies Inc.; Barton Dong accountable; villagehale.com, aloha@villagehale.com.',
    text: "Je suis Hale, un assistant IA d'une entreprise de technologie pour les villages. Barton Dong est la personne responsable de ce service. Plus d'infos sur villagehale.com ou écris à aloha@villagehale.com. Si tu veux que j'arrête, dis-le-moi simplement.",
    score: 1,
    why: 'The company name is turned into a description; a name keeps its meaning.',
  },
  {
    facts:
      'Two optional Google links (calendar, Gmail), each valid 15 minutes; Google may show an unverified-app screen, expected and safe for this connection. French.',
    text: "Voici les deux liens, facultatifs, pour que Hale repère les avis de garderie et d'école. Chacun marche pendant 15 minutes.\n\nAgenda : [link]\nGmail : [link]\n\nSi Google affiche un écran « application non vérifiée », c'est normal pour cette connexion et sans danger : cliquez sur « Paramètres avancés », puis sur « Continuer ».",
    score: 5,
    why: 'Duration kept, the Google screen framed as expected and safe, plain French.',
  },
  {
    facts:
      'Two optional Google links (calendar, Gmail), each valid 15 minutes; Google may show an unverified-app screen, expected and safe for this connection. French.',
    text: "Voici les liens pour connecter ton agenda et ton Gmail, si tu veux. Chacun marche 15 minutes, pour que Hale repère les avis de garderie et d'école.\n\nAgenda : [link]\nGmail : [link]\n\nAttention : Google va afficher un écran « application non vérifiée ». Clique sur Avancé, puis continuer.",
    score: 2,
    why: 'Quotes the warning with no word that it is expected and safe; that scares a parent.',
  },
  {
    facts: 'Intros were already off for this parent; nothing changes. English.',
    text: "So sorry about the mix-up! Intros were already off for you, nothing's changed, and I won't bring them up again.",
    score: 1,
    why: 'An apology nobody asked for, and a promise the facts do not give.',
  },
];

async function loadSkill() {
  const raw = await readFile(SKILL, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('said-line.md: no frontmatter');
  const task = m[1].match(/^task:\s*(\S+)/m)?.[1];
  return { task, instructions: m[2].trim() };
}

/** The writer's tier, read from the skill's task (Sonnet 5.5 since #919: Barton, 2026-10-27). */
function laneModel(task, ids) {
  if (['screen', 'answer', 'speak', 'triage', 'acknowledge'].includes(task)) return ids.haiku;
  if (['draft', 'infer', 'converse'].includes(task)) return ids.sonnet;
  throw new Error(`said-line lane ${task} has no priced tier; update the estimate first`);
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
    ...(f.mustConvey?.length ? { mustConvey: f.mustConvey } : {}),
    linkSlots: Object.keys(f.links ?? {}).map((name) => `[[${name}]]`),
  });
}

/** acceptSaidLine in said-line.ts: facts verbatim, no typed URL, each slot once, then
 * code fills the slots. Returns the filled text, or null. */
function acceptText(text, f) {
  let body = (text ?? '').trim();
  if (body.length === 0) return null;
  if (!(f.mustInclude ?? []).every((fact) => body.includes(fact))) return null;
  if (!(f.mustConvey ?? []).every((key) => key in f.facts)) return null;
  if (/https?:\/\//i.test(body) || /\bwww\./i.test(body)) return null;
  for (const [name, url] of Object.entries(f.links ?? {})) {
    const slot = `[[${name}]]`;
    if (body.split(slot).length !== 2) return null;
    body = body.replace(slot, url);
  }
  if (/\[\[[^\]]*\]\]/.test(body)) return null;
  return body;
}

/**
 * --dry subject: a cache hit replays; a miss is priced with the live guard's cache-aware
 * rule (imported via projectAgentTurn from spend-cap.mjs), as DRY_SUBJECT_CALLS calls, and
 * the judge then grades a stand-in carrying every required fact and link.
 */
async function drySubject(agent, opts, plan, f) {
  try {
    // A hit replays; a miss reaches the dry client, which refuses before any network.
    const hit = await cachedToolCall(opts);
    plan.push({ tag: opts.tag, cached: true });
    return hit.value;
  } catch (err) {
    if (!/eval --dry/.test(String(err?.message ?? err))) throw err;
    const request = agent.structuredRequest({
      lane: opts.lane,
      maxTokens: opts.maxTokens,
      system: opts.system,
      userMessage: opts.userMessage,
      toolName: opts.toolName,
      toolDescription: opts.toolDescription,
      inputJsonSchema: opts.toolSchema,
    });
    plan.push(
      ...projectAgentTurn({
        request,
        step: 1,
        maxSteps: DRY_SUBJECT_CALLS,
        growthTokens: SUBJECT_MAX_TOKENS,
        rates: priceRates,
        tag: opts.tag,
      }),
    );
    const standIn = [...(f.mustInclude ?? []), ...Object.values(f.links ?? {})].join(' ');
    return { text: standIn || '(dry)', dryStandIn: true };
  }
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
  const judgeCalls = subjectCalls * JUDGE_SAMPLES;
  if (preflight) {
    const subjIn = Math.ceil((skill.instructions.length + 600) / 4);
    const judgeIn = Math.ceil((JUDGE_SYSTEM.length + 900) / 4);
    const sonnetWriter = ['draft', 'infer', 'converse'].includes(skill.task);
    const [wIn, wOut] = sonnetWriter ? [SONNET_IN, SONNET_OUT] : [HAIKU_IN, HAIKU_OUT];
    const subj = subjectCalls * ((subjIn / 1e6) * wIn + (SUBJECT_MAX_TOKENS / 1e6) * wOut);
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
  const agent = await loadAgent();
  const judge = makeJudge(
    agent.SONNET_MODEL,
    JUDGE_SYSTEM,
    'said-line-judge',
    cachedOnly,
    getClient,
    cost,
    {
      samples: JUDGE_SAMPLES,
      aggregate: 'min',
      references: [...GENERAL_REFERENCE_TEXTS, ...SAID_LINE_REFERENCE_TEXTS],
      logCost: true,
      maxOutputTokens: SAID_LINE_JUDGE_MAX_OUTPUT_TOKENS,
    },
  );
  const dry = isDryRun();
  const subjectPlan = [];
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
    const subjectOpts = {
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
    };
    let out;
    if (broken) out = { text: f.brokenText };
    else if (dry) out = await drySubject(agent, subjectOpts, subjectPlan, f);
    else out = (await cachedToolCall(subjectOpts))?.value;
    const raw = out?.text ?? '';
    const text = out?.dryStandIn ? raw : acceptText(raw, f);
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
  if (dry) {
    const capUsd = readCapUsd();
    if (capUsd === null)
      throw new Error('eval --dry: no --max-usd / HALE_MAX_USD; nothing to project against');
    const { spentUsd } = readLedger();
    for (const p of subjectPlan)
      console.info(
        p.cached
          ? `DRY  subject cached    ${p.tag}`
          : `DRY  subject uncached  ${p.tag}  ~${p.inputTokens} in (~${p.cacheReadTokens} at cache-read) + ${SUBJECT_MAX_TOKENS} max out  worst $${p.worstUsd.toFixed(5)}`,
      );
    for (const p of judge.plan)
      console.info(
        p.cached
          ? `DRY  judge cached    ${p.tag}  score ${p.score}`
          : `DRY  judge uncached  ${p.tag}  ~${p.inputTokens} in + ${p.maxTokens} max out  worst $${p.worstUsd.toFixed(5)}`,
      );
    const subjectWorst = subjectPlan.reduce((sum, p) => sum + (p.worstUsd ?? 0), 0);
    const j = summarizeJudgePlan(judge.plan, { spentUsd: spentUsd + subjectWorst, capUsd });
    console.info(
      `DRY summary | subject calls ${subjectPlan.filter((p) => !p.cached).length} uncached (${subjectPlan.filter((p) => p.cached).length} cached) worst $${subjectWorst.toFixed(5)} | judge draws ${j.draws} (cached ${j.cached}) worst $${j.worstTotalUsd.toFixed(5)} | ledger $${spentUsd.toFixed(5)} -> projected $${j.projectedLedgerUsd.toFixed(5)} vs cap $${capUsd} | ${j.fitsCap ? 'FITS' : 'EXCEEDS CAP'} | live calls: 0`,
    );
    process.exit(j.fitsCap ? 0 : 3);
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
