#!/usr/bin/env node
// VIL-466 · Post a scripted fake-family conversation to the Preview-only fake inbound
// door (/api/channels/preview/inbound) and read the captured replies back.
//
// Modes (exactly one, same rule as apps/worker/evals/lib/eval-flags.mjs; anything else
// exits 2):  --dry   price the worst case per turn offline, no network at all
//            --live  post the texts (each turn makes real, paid model calls on Preview)
// Options:   --max-usd <n>   hard stop, required. --live refuses to start, and stops
//                            between turns, if the worst case would pass it.
//            --persona <p>   required: impatient | french | chinese | photos | optout |
//                            reminder (the #924 proof: fires the reminders trigger last)
//            --turns <n>     how many of the persona's turns to send (default: all)
//            --seq <0-9>     picks the persona's fake number; a used number is refused
//            --media-ref <r> git ref the flyer photos are served from (default main)
//            --base-url <u>  the Preview deploy (live only)
// Live goes through `vercel curl <path> --deployment <base-url> -- <curl args>` (a
// logged-in Vercel CLI adds the protection bypass; plain fetch gets 401 on a protected
// Preview). The bearer header is written to a 0600 temp file and passed as `-H @file`,
// so it never lands on a command line or in output.
// The sender is always in the fictional +1 437-555 range. The bearer is read from
// /workspace/secrets/preview-fake-inbound (or PREVIEW_FAKE_INBOUND_SECRET_FILE) and is
// never printed.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MODES = ['--dry', '--live'];

// List USD per 1M tokens, same card as apps/worker/evals/lib/harness.mjs PRICE.
const PRICE = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-sonnet-5-5': { input: 2.0, output: 10.0 },
  'claude-opus-5-5': { input: 15.0, output: 75.0 },
};

// One inbound turn's worst case, from the model limits in code and the largest prompt
// any ledger has recorded for that call (/workspace/spend/*.json, 910-coach-final.json):
//  - coach loop: apps/web/lib/channel/coach/runtime.ts MAX_STEPS=6, MAX_TOKENS=400,
//    converse lane = Sonnet 5.5; largest recorded prompt 23,311 tokens, padded to 32k
//    per step (tool results grow it) and priced uncached;
//  - reply compose: reply-copy/compose.ts maxSteps 1, MAX_TOKENS 320, priced as Sonnet;
//  - intake/extract on a new family: Sonnet, largest recorded 2,453 in, 1,024 out;
//  - a triage/screen call: priced at Sonnet, 4k in, 1,024 out.
export const TURN_CALLS = [
  ...Array.from({ length: 6 }, (_, i) => ({
    tag: `coach-step-${i + 1}`,
    model: 'claude-sonnet-5-5',
    inTokens: 32000,
    maxOut: 400,
  })),
  { tag: 'reply-compose', model: 'claude-sonnet-5-5', inTokens: 8000, maxOut: 320 },
  { tag: 'intake-extract', model: 'claude-sonnet-5-5', inTokens: 4000, maxOut: 1024 },
  { tag: 'triage', model: 'claude-sonnet-5-5', inTokens: 4000, maxOut: 1024 },
];

// The reminder trigger's compose: apps/web/lib/loop/reminders/compose.ts, maxTokens 1024,
// REMINDER_MAX_ATTEMPTS 2, priced as Sonnet with the reply-compose prompt size. One fake
// family has one parent, so one recipient.
export const REMINDER_CALLS = [1, 2].map((attempt) => ({
  tag: `reminder-compose-${attempt}`,
  model: 'claude-sonnet-5-5',
  inTokens: 8000,
  maxOut: 1024,
}));

// Photos are fetched by the coach over plain https (lib/channel/inbound-media.ts), so the
// flyers are served from this public repo at a git ref (--media-ref, default main).
/** @param {string} file */
const flyer = (file) => ({ file, mime: 'image/png' });

// VIL-466 personas. Fictional families, fictional places on the flyers, no names: each
// one lives in a different US or Canadian city so no default city is assumed.
/** @type {Record<string, { slot: number, fireReminders?: boolean, turns: Array<{ text: string, media?: Array<{ file: string, mime: string }> }> }>} */
export const PERSONAS = {
  impatient: {
    slot: 0,
    turns: [
      { text: 'hi do you find kids classes? 2 kids, 6 and 3, we live in Denver' },
      { text: 'ok so whats on saturday' },
      { text: '??' },
      { text: 'thats not what i asked. something for BOTH of them saturday morning' },
      { text: 'this is too slow, i could just google it' },
      { text: 'fine. last try, anything indoors sunday?' },
    ],
  },
  french: {
    slot: 1,
    turns: [
      {
        text: "Bonjour! Une amie m'a dit que vous aidez à trouver des activités pour les enfants. J'ai une fille de 5 ans et un garçon de 2 ans, on habite à Montréal.",
      },
      { text: "Ma fille adore la danse et le petit aime surtout l'eau." },
      { text: "Est-ce qu'il y a des cours de danse le samedi matin pour elle ?" },
      { text: "C'est combien, et faut-il s'inscrire à l'avance ?" },
      { text: 'Et pour le petit, des cours de bébés nageurs le dimanche ?' },
      { text: "Est-ce que je peux faire les deux le même week-end, ou c'est trop serré ?" },
      { text: "D'accord. Quand est-ce que les inscriptions d'hiver ouvrent en général ?" },
      { text: 'Pouvez-vous me prévenir quand les inscriptions ouvrent ?' },
      { text: 'Mon conjoint voudrait aussi recevoir les infos, comment on fait ?' },
      { text: "Il va pleuvoir ce week-end, une idée à l'intérieur pour les deux ?" },
      { text: "Parfait, merci. C'est gratuit ?" },
      { text: 'Merci beaucoup, bonne soirée !' },
    ],
  },
  chinese: {
    slot: 2,
    turns: [
      {
        text: '你好！朋友说你可以帮忙找孩子的活动。我有两个孩子，女儿7岁，儿子4岁，我们住在温哥华。',
      },
      { text: '女儿喜欢画画，儿子喜欢踢足球。' },
      { text: '这个周六上午有适合他们两个的活动吗？' },
      { text: '要多少钱？需要提前报名吗？' },
      { text: '有中文或者双语的课程吗？' },
      { text: '儿子的足球课一般几岁可以开始？' },
      { text: '周日下午呢？天气不好的话有室内的吗？' },
      { text: '我需要带什么东西？那边好停车吗？' },
      { text: '春季的课程什么时候开始报名？' },
      { text: '报名开始的时候可以提醒我吗？' },
      { text: '我先生也想收到消息，可以吗？' },
      { text: '好的，谢谢你！' },
    ],
  },
  photos: {
    slot: 3,
    turns: [
      {
        text: "Hi! My daughter's daycare keeps sending home flyers and I lose track of them. She's 4, we're in Portland, Oregon.",
      },
      { text: 'Got this one today, is it any good for her age?', media: [flyer('flyer-swim.png')] },
      { text: 'When would she need to sign up by?' },
      { text: '', media: [flyer('flyer-art.png')] },
      { text: 'Which of those two is easier on a weekend?' },
      { text: 'Can you keep both on my radar?' },
      { text: 'And this one came from the library', media: [flyer('flyer-library.png')] },
      { text: 'Is that one free?' },
      { text: "What's the earliest any of them start?" },
      { text: "Sorry, last one, it's blurry", media: [flyer('flyer-run.png')] },
      { text: 'Can you read the date on it?' },
      { text: "Thanks, that's all for now" },
    ],
  },
  optout: {
    slot: 4,
    turns: [
      {
        text: "Hey, a friend gave me this number. I have a 3 year old and we're in Columbus, Ohio. What can you do?",
      },
      { text: 'Anything for toddlers this week?' },
      { text: 'What time is the first one?' },
      { text: 'Ok cool' },
      { text: "Actually I'm getting way too many texts these days. Please stop messaging me." },
      { text: "Did that work? I don't want any more texts from you" },
      { text: 'sorry, one more thing, what was the name of that first one again?' },
      { text: "ok thanks. and you won't text me unless I text first right?" },
      { text: 'Actually I changed my mind, I want to keep getting help' },
      { text: "Great, what's on next weekend?" },
    ],
  },
  // The #924 reminder proof: an event that starts within the hour has a due T-1h
  // reminder, which the reminders trigger fires and the capture records.
  reminder: {
    slot: 5,
    fireReminders: true,
    turns: [
      {
        text: "Hi! My son is 5 and we're in Halifax. He has a swim lesson today that starts in about 50 minutes at our community pool. Can you put it on our calendar and remind me before it starts?",
      },
      { text: 'Yes please, add it.' },
    ],
  },
};

/** +1 437-555-01<slot><seq>: fictional, one per persona, and a new one per --seq. */
export function personaFrom(name, seq = 0) {
  const p = PERSONAS[name];
  if (!p) throw new Error(`unknown persona ${name}`);
  return `+143755501${p.slot}${seq}`;
}

export function callUsd({ model, inTokens, maxOut }) {
  const p = PRICE[model];
  if (!p) throw new Error(`no price for ${model}`);
  return (inTokens / 1e6) * p.input + (maxOut / 1e6) * p.output;
}

export const turnWorstUsd = () => TURN_CALLS.reduce((s, c) => s + callUsd(c), 0);

export const reminderWorstUsd = () => REMINDER_CALLS.reduce((s, c) => s + callUsd(c), 0);

/**
 * How much of a persona fits under the cap: every turn's worst case first, then the
 * reminder trigger's compose. The live loop reserves the same way, turn by turn.
 */
export function plannedSpend(persona, turns, maxUsd) {
  const per = turnWorstUsd();
  const fit = Math.min(turns, Math.floor(maxUsd / per));
  let usd = fit * per;
  const reminder =
    Boolean(persona.fireReminders) && fit === turns && usd + reminderWorstUsd() <= maxUsd;
  if (reminder) usd += reminderWorstUsd();
  return { turns: fit, reminder, usd };
}

const VALUE_OPTS = ['--max-usd', '--turns', '--base-url', '--persona', '--seq', '--media-ref'];

export function parseArgs(argv) {
  const modes = argv.filter((a) => a.startsWith('--') && !VALUE_OPTS.includes(a));
  const unknown = modes.filter((a) => !MODES.includes(a));
  if (unknown.length)
    throw new Error(`unknown flag(s): ${unknown.join(' ')}. Allowed modes: ${MODES.join(' ')}`);
  if (modes.length !== 1) throw new Error(`pass exactly one mode: ${MODES.join(' | ')}`);
  const opt = (name) => {
    const i = argv.indexOf(name);
    if (i === -1) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
    return v;
  };
  const maxUsd = Number(opt('--max-usd'));
  if (!Number.isFinite(maxUsd) || maxUsd <= 0)
    throw new Error('--max-usd <positive number> is required');
  const persona = opt('--persona');
  if (!persona || !Object.hasOwn(PERSONAS, persona))
    throw new Error(`--persona must be one of: ${Object.keys(PERSONAS).join(' ')}`);
  const max = PERSONAS[persona].turns.length;
  const turns = opt('--turns') === undefined ? max : Number(opt('--turns'));
  if (!Number.isInteger(turns) || turns < 1 || turns > max)
    throw new Error(`--turns must be 1..${max} for ${persona}`);
  const seq = opt('--seq') === undefined ? 0 : Number(opt('--seq'));
  if (!Number.isInteger(seq) || seq < 0 || seq > 9) throw new Error('--seq must be 0..9');
  return {
    mode: modes[0].slice(2),
    maxUsd,
    persona,
    turns,
    seq,
    baseUrl: opt('--base-url'),
    mediaRef: opt('--media-ref') ?? 'main',
  };
}

function dry({ maxUsd, persona, turns, seq }) {
  const per = turnWorstUsd();
  const { fireReminders } = PERSONAS[persona];
  const plan = plannedSpend(PERSONAS[persona], turns, maxUsd);
  console.log(
    `preview-fake-family --dry: no network, ${persona}, ${turns} turn(s) from ${personaFrom(persona, seq)}`,
  );
  for (const c of TURN_CALLS)
    console.log(
      `  ${c.tag.padEnd(16)} ${c.model} in ${c.inTokens} out ${c.maxOut}  $${callUsd(c).toFixed(4)}`,
    );
  console.log(`  worst case per turn: $${per.toFixed(4)}`);
  if (fireReminders) console.log(`  reminder trigger:    $${reminderWorstUsd().toFixed(4)}`);
  console.log(`  worst case planned:  $${plan.usd.toFixed(4)} (cap $${maxUsd})`);
  if (plan.turns < turns || (fireReminders && !plan.reminder))
    console.log(
      `  --live would stop after ${plan.turns} turn(s)${fireReminders && !plan.reminder ? ', without the reminder trigger' : ''}`,
    );
}

async function live({ maxUsd, persona, turns, seq, baseUrl, mediaRef }) {
  if (!baseUrl?.startsWith('https://'))
    throw new Error('--live needs --base-url https://<preview deploy>');
  const { turns: script, fireReminders } = PERSONAS[persona];
  const from = personaFrom(persona, seq);
  const mediaBase = `https://raw.githubusercontent.com/villagehale/hale/${encodeURIComponent(mediaRef)}/apps/web/scripts/qa-flyers/`;
  const per = turnWorstUsd();
  const secret = readFileSync(
    process.env.PREVIEW_FAKE_INBOUND_SECRET_FILE ?? '/workspace/secrets/preview-fake-inbound',
    'utf8',
  ).trim();
  const dir = mkdtempSync(join(tmpdir(), 'pff-'));
  const hdr = join(dir, 'h');
  writeFileSync(hdr, `authorization: Bearer ${secret}\ncontent-type: application/json\n`, {
    mode: 0o600,
  });
  const vcurl = (path, extra = []) => {
    try {
      return execFileSync(
        'vercel',
        [
          'curl',
          path,
          '--deployment',
          baseUrl,
          '--',
          '-sS',
          '-H',
          `@${hdr}`,
          '-w',
          '\n%{http_code}',
          ...extra,
        ],
        { encoding: 'utf8', maxBuffer: 1 << 26 },
      )
        .split(secret)
        .join('<redacted>');
    } catch (err) {
      return `vercel curl failed: ${String(err.stderr ?? err.message)
        .split(secret)
        .join('<redacted>')}\n000`;
    }
  };
  const split = (out) => {
    const i = out.lastIndexOf('\n');
    return { body: out.slice(0, i), status: Number(out.slice(i + 1)) };
  };
  const post = (path, payload) => split(vcurl(path, ['-X', 'POST', '-d', JSON.stringify(payload)]));
  const captured = () =>
    split(vcurl(`/api/channels/preview/captured?to=${encodeURIComponent(from)}`));
  try {
    // A number with captures belongs to an earlier run: intake would be skipped and the
    // transcripts mixed, so a rerun needs a new --seq.
    const before = captured();
    const prior = before.status === 200 ? JSON.parse(before.body).count : null;
    if (prior !== 0) {
      console.log(`stop: ${from} is not fresh (read ${before.status}, count ${prior}); new --seq`);
      return;
    }
    console.log(`${persona}: ${turns} turn(s) from ${from}`);
    let reserved = 0;
    let sent = 0;
    for (let i = 0; i < turns; i++) {
      if (reserved + per > maxUsd) {
        console.log(
          `stop: turn ${i + 1} worst case would pass --max-usd ${maxUsd} (reserved $${reserved.toFixed(4)})`,
        );
        break;
      }
      reserved += per;
      const { text, media } = script[i];
      const { body, status } = post('/api/channels/preview/inbound', {
        from,
        text,
        ...(media ? { media: media.map((m) => ({ url: mediaBase + m.file, mime: m.mime })) } : {}),
      });
      console.log(`turn ${i + 1}: ${status} ${body}`);
      if (status < 200 || status >= 300) break;
      sent += 1;
      await new Promise((r) => setTimeout(r, 20000));
    }
    if (fireReminders && sent === turns) {
      if (reserved + reminderWorstUsd() > maxUsd) {
        console.log(`stop: the reminder trigger would pass --max-usd ${maxUsd}`);
      } else {
        reserved += reminderWorstUsd();
        const { body, status } = post('/api/channels/preview/reminders', { phone: from });
        console.log(`reminders: ${status} ${body}`);
        await new Promise((r) => setTimeout(r, 20000));
      }
    }
    console.log(`worst case reserved: $${reserved.toFixed(4)}`);
    console.log(captured().body);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`preview-fake-family: ${err.message}`);
    process.exit(2);
  }
  if (args.mode === 'dry') return dry(args);
  return live(args);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
