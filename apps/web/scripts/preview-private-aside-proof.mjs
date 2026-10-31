#!/usr/bin/env node
// VIL-457 · Preview-only proof for the shared-group private aside (PR #960).
//
// Seeds two fictional families on the PREVIEW database (parents +14375550201 /
// +14375550202, verified), puts private facts (kid name, a clock-bearing memory fact,
// and a family_events swim lesson at next Saturday 10:00 America/Toronto) on ONLY
// family B, then drives the Preview fake group door:
//   1. each parent posts a join message to one preview-chat-… thread, so the server runs
//      the real joinFamilyToSharedGroup path (takeMultiFamilyTurn join intent);
//   2. parent A proposes a GROUP plan at that same clock (Saturday 10am) without asking
//      about B's kid — a plan-time overlap, so the #934 skill sends B a 1:1 aside
//      (asking about another family's kid is the skill's "no aside" case);
//   3. reads /api/channels/preview/captured?to=<each phone> (1:1 aside) and
//      /api/channels/preview/group-captured?chatId=… and prints JSON for the PR.
// No real Linq: every send is captured by the Preview door. Phones are only 437-555.
//
// Modes:  --dry   print the plan, no DB writes, no network
//         --live  seed + fire (real model calls on Preview; Noah fires after design gate)
// Env (live): DATABASE_URL (Preview DB only), APP_ENCRYPTION_KEY (Preview's), and
//   PREVIEW_BASE_URL=https://<preview deploy>. Bearer read from
//   PREVIEW_FAKE_INBOUND_SECRET_FILE or /workspace/secrets/preview-fake-inbound, never printed.
// HTTP goes through `vercel curl … --deployment <base>` (protection bypass), like
// preview-fake-family.mjs.
import { execFileSync } from 'node:child_process';
import { createCipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PARENT_A = '+14375550201';
const PARENT_B = '+14375550202';
const RUN = Date.now().toString(36);
const CHAT = `preview-chat-vil457-${RUN}`;
const CHILD = 'Zephyrina';
const MEMORY = `Zephyrina swim lessons Saturdays 10am (${RUN})`;
const CALENDAR = `Zephyrina swim lesson ${RUN}`;
const CHAT_DECLINE = `${CHAT}-decline`;
const CHAT_FAIL = `${CHAT}-fail`;
const JOIN_TEXT = 'our family is in this group';
const CLASH_TEXT =
  'Proposing a playdate for the whole group this Saturday at 10am at the park — sound good?';
const YES_TEXT = 'yes';
const FAIL_YES = 'yes, Saturday at 10am at the park works for us';
const TZ = 'America/Toronto';

// Next Saturday 10:00 in TZ, as a UTC ISO instant (matches the plan clock).
function nextSaturdayTenLocal(now = new Date()) {
  const parts = (d) =>
    Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: TZ,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'short',
      })
        .formatToParts(d)
        .map((p) => [p.type, p.value]),
    );
  const today = parts(now);
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(today.weekday);
  const add = (6 - dow + 7) % 7 || 7;
  const guess = new Date(Date.UTC(+today.year, +today.month - 1, +today.day + add, 10, 0));
  const local = parts(guess);
  const offsetMs =
    Date.UTC(+local.year, +local.month - 1, +local.day, +local.hour, +local.minute) -
    guess.getTime();
  return new Date(guess.getTime() - offsetMs).toISOString();
}
const SWIM_AT = nextSaturdayTenLocal();
const PREVIEW_DB_PROJECT = 'ncujspiepbuwnbmayhpb';

/** Host or pooler user must be the Preview project. A password or query that merely contains the id does not qualify. */
function assertPreviewDatabase(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`DATABASE_URL must be the Preview DB (${PREVIEW_DB_PROJECT})`);
  }
  const host = url.hostname;
  const user = decodeURIComponent(url.username);
  const direct = host === `db.${PREVIEW_DB_PROJECT}.supabase.co`;
  // Pooler roles are `postgres.<project>` or `hale_preview.<project>`. The project
  // ref has to be the role, not a password or query string that happens to contain it.
  const pooler = host.endsWith('.pooler.supabase.com') && user.endsWith(`.${PREVIEW_DB_PROJECT}`);
  if (!direct && !pooler) {
    throw new Error(`DATABASE_URL must be the Preview DB (${PREVIEW_DB_PROJECT})`);
  }
}

/** Drop 1:1 captures from before this run. Group reads have no `sends` array and pass through. */
function onlyThisRun(raw, sinceIso) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.sends)) return raw;
    parsed.sends = parsed.sends.filter((row) => row.capturedAt >= sinceIso);
    parsed.count = parsed.sends.length;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

/**
 * Real Preview hosts (docs/deployment.md): a deployment
 * `hale-<id>-village-hale-project.vercel.app`, or a branch alias
 * `hale-web-git-<branch>-village-hale-project.vercel.app`.
 * The stable production aliases are refused.
 */
function assertPreviewDeploy(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PREVIEW_BASE_URL must be an https Preview deploy');
  }
  const host = url.hostname;
  const deployment = /^hale-[a-z0-9]+-village-hale-project\.vercel\.app$/.test(host);
  const branch = /^hale-web-git-.+-village-hale-project\.vercel\.app$/.test(host);
  const production =
    host === 'hale-web-village-hale-project.vercel.app' ||
    host === 'hale-web.vercel.app' ||
    host === 'hale-web-orpin.vercel.app';
  if (url.protocol !== 'https:' || production || !(deployment || branch)) {
    throw new Error(
      'PREVIEW_BASE_URL must be a hale preview deploy (hale-<id>-village-hale-project.vercel.app)',
    );
  }
}

const mode = process.argv.slice(2);
if (mode.length !== 1 || !['--dry', '--live'].includes(mode[0])) {
  console.error('usage: preview-private-aside-proof.mjs --dry | --live');
  process.exit(2);
}
for (const p of [PARENT_A, PARENT_B])
  if (!/^\+1437555\d{4}$/.test(p)) throw new Error('not fictional');

const plan = {
  chatId: CHAT,
  families: [
    { name: `Preview Ada ${RUN}`, phone: PARENT_A, private: null },
    {
      name: `Preview Bao ${RUN}`,
      phone: PARENT_B,
      private: { child: CHILD, memory: MEMORY, calendar: CALENDAR, startsAt: SWIM_AT, tz: TZ },
    },
  ],
  posts: [
    { chatId: CHAT_DECLINE, from: PARENT_A, text: JOIN_TEXT },
    { chatId: CHAT_DECLINE, from: PARENT_B, text: JOIN_TEXT },
    { chatId: CHAT_DECLINE, from: PARENT_A, text: CLASH_TEXT, note: 'lands the first aside' },
    {
      chatId: CHAT_DECLINE,
      from: PARENT_A,
      text: YES_TEXT,
      note: 'repeat: draft declines, yes to RSVP',
    },
    { chatId: CHAT_FAIL, from: PARENT_A, text: JOIN_TEXT },
    { chatId: CHAT_FAIL, from: PARENT_B, text: JOIN_TEXT },
    {
      chatId: CHAT_FAIL,
      from: PARENT_A,
      text: FAIL_YES,
      note: 'after B phone revoked: 1:1 fails, yes to RSVP',
    },
  ],
  reads: [
    `/api/channels/preview/captured?to=${encodeURIComponent(PARENT_A)}`,
    `/api/channels/preview/captured?to=${encodeURIComponent(PARENT_B)}`,
    `/api/channels/preview/group-captured?chatId=${CHAT_DECLINE}`,
    `/api/channels/preview/group-captured?chatId=${CHAT_FAIL}`,
  ],
  expect:
    'decline chat: quiet group, aside declines, yes reaches RSVP, no new 1:1. fail chat: 1:1 fails, yes reaches RSVP, nothing sent',
};

if (mode[0] === '--dry') {
  console.info(JSON.stringify({ mode: 'dry', writes: 'none', network: 'none', ...plan }, null, 2));
  process.exit(0);
}

// ---- live ----
const { DATABASE_URL, APP_ENCRYPTION_KEY, PREVIEW_BASE_URL } = process.env;
assertPreviewDatabase(DATABASE_URL);
assertPreviewDeploy(PREVIEW_BASE_URL);
const startedAt = new Date().toISOString();
const key = Buffer.from(APP_ENCRYPTION_KEY ?? '', 'base64');
const canMint = key.length === 32;
// Same as lib/crypto/string-cipher.ts and blind-index.ts.
const encrypt = (s) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(s, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
};
const phoneHash = canMint
  ? (p) =>
      createHmac(
        'sha256',
        Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'hale-phone-blind-index-v1', 32)),
      )
        .update(p)
        .digest('hex')
  : null;

const { default: postgres } = await import('postgres');
const sql = postgres(DATABASE_URL, { prepare: false, max: 1 });
const post = async (chatId, from, text) => {
  const body = JSON.stringify({
    chatId,
    from,
    participants: [PARENT_A, PARENT_B],
    text,
  });
  const out = vcurl('/api/channels/preview/group-inbound', ['-X', 'POST', '-d', body]);
  console.info(`POST ${chatId} ${from}: ${out}`);
  await new Promise((r) => setTimeout(r, 20000));
  return out;
};
let vcurl = () => {
  throw new Error('vcurl not ready');
};
try {
  await sql.begin(async (tx) => {
    for (const f of plan.families) {
      const [prior] = await tx`
        select pc.phone_e164_encrypted as enc, pc.phone_e164_hash as hash
        from parent_channels pc
        join users u on u.id = pc.user_id
        where u.external_auth_id like ${`preview-vil457:%:${f.phone}`}
          and pc.phone_e164_encrypted is not null
        order by pc.created_at desc
        limit 1`;
      const enc = canMint ? encrypt(f.phone) : prior?.enc;
      const hash = canMint ? phoneHash(f.phone) : prior?.hash;
      if (!enc || !hash) {
        throw new Error('APP_ENCRYPTION_KEY (Preview, 32 bytes base64) required to mint a channel');
      }
      // Drop this number's earlier 1:1 captures AND the outbound ledger rows that
      // pointed at them. Leaving the ledger behind makes the next read report
      // those sends as lost.
      await tx`
        delete from channel_messages cm
        using users u
        where cm.parent_user_id = u.id
          and u.external_auth_id like ${`preview-vil457:%:${f.phone}`}
          and cm.direction = 'out'
          and cm.provider_message_id like 'preview-capture-%'`;
      await tx`
        delete from channel_messages
        where direction = 'out'
          and provider_message_id in (
            select provider_message_id from preview_captured_sends where to_e164 = ${f.phone}
          )`;
      await tx`delete from preview_captured_sends where to_e164 = ${f.phone}`;
      await tx`
        delete from parent_channels
        where user_id in (
          select id from users where external_auth_id like ${`preview-vil457:%:${f.phone}`}
        )`;
      const [fam] =
        await tx`insert into families (display_name, province_or_state) values (${f.name}, 'ON') returning id`;
      const [u] =
        await tx`insert into users (external_auth_id, name, timezone) values (${`preview-vil457:${RUN}:${f.phone}`}, ${f.name}, ${TZ}) returning id`;
      await tx`insert into family_members (family_id, user_id, role) values (${fam.id}, ${u.id}, 'primary_parent')`;
      await tx`insert into parent_channels (user_id, family_id, kind, phone_e164_encrypted, phone_e164_hash, verified_at)
               values (${u.id}, ${fam.id}, 'sms', ${enc}, ${hash}, now())`;
      if (f.private) {
        await tx`insert into children (family_id, name, date_of_birth) values (${fam.id}, ${CHILD}, '2022-04-01')`;
        await tx`insert into family_memory_facts (family_id, fact_type, fact_key, fact_value)
                 values (${fam.id}, 'preference', ${MEMORY}, ${sql.json({ note: 'hidden-memory' })})`;
        await tx`insert into family_events (family_id, title, starts_at, source)
                 values (${fam.id}, ${CALENDAR}, ${SWIM_AT}, 'parent')`;
      }
      f.familyId = fam.id;
      f.userId = u.id;
      console.info(`seeded ${f.name} ${f.phone} family=${fam.id}`);
    }
    const ada = plan.families[0];
    for (const chatId of [CHAT_DECLINE, CHAT_FAIL]) {
      await tx`
        insert into linq_group_plans (chat_id, family_id, title, starts_at, location, expected_count, created_by_user_id)
        values (${chatId}, ${ada.familyId}, 'park Saturday 10am', ${SWIM_AT}, 'the park', 2, ${ada.userId})`;
    }
  });

  const secret = (
    process.env.PREVIEW_FAKE_INBOUND_SECRET ??
    readFileSync(
      process.env.PREVIEW_FAKE_INBOUND_SECRET_FILE ?? '/workspace/secrets/preview-fake-inbound',
      'utf8',
    )
  ).trim();
  const dir = mkdtempSync(join(tmpdir(), 'ppa-'));
  const hdr = join(dir, 'h');
  writeFileSync(hdr, `authorization: Bearer ${secret}\ncontent-type: application/json\n`, {
    mode: 0o600,
  });
  vcurl = (path, extra = []) => {
    try {
      return execFileSync(
        'vercel',
        ['curl', path, '--deployment', PREVIEW_BASE_URL, '--', '-sS', '-H', `@${hdr}`, ...extra],
        { encoding: 'utf8', maxBuffer: 1 << 26 },
      )
        .split(secret)
        .join('<redacted>');
    } catch (err) {
      return `vercel curl failed: ${String(err.stderr ?? err.message)
        .split(secret)
        .join('<redacted>')}`;
    }
  };
  try {
    for (const p of plan.posts) {
      if (p.chatId === CHAT_FAIL && p.text === FAIL_YES) {
        const bao = plan.families[1];
        await sql`update parent_channels set revoked_at = now() where user_id = ${bao.userId} and revoked_at is null`;
        console.info('revoked B phone so the 1:1 cannot land');
      }
      await post(p.chatId, p.from, p.text);
    }
    for (const path of plan.reads)
      console.info(`GET ${path}\n${onlyThisRun(vcurl(path), startedAt)}`);
    const rsvps = await sql`
      select p.chat_id, r.response, r.verbatim, r.source
      from linq_group_plan_rsvps r
      join linq_group_plans p on p.id = r.plan_id
      where p.chat_id in (${CHAT_DECLINE}, ${CHAT_FAIL})
      order by r.created_at`;
    const lost = await sql`
      select count(*)::int as n
      from channel_messages cm
      join users u on u.id = cm.parent_user_id
      where u.external_auth_id like ${`preview-vil457:${RUN}:%`}
        and cm.direction = 'out'
        and cm.provider_message_id like 'preview-capture-%'
        and not exists (
          select 1 from preview_captured_sends s
          where s.provider_message_id = cm.provider_message_id
        )`;
    console.info(`RSVP ${JSON.stringify(rsvps)}`);
    console.info(`this-run uncaptured 1:1 ledger ${lost[0]?.n ?? 0}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} finally {
  await sql.end();
}
