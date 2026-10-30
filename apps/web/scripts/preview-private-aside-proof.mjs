#!/usr/bin/env node
// VIL-457 · Preview-only proof for the shared-group private aside (PR #960).
//
// Seeds two fictional families on the PREVIEW database (parents +14375550201 /
// +14375550202, verified), puts a private clash fact (kid name, memory fact, calendar
// title) on ONLY family B, then drives the Preview fake group door:
//   1. each parent posts a join message to one preview-chat-… thread, so the server runs
//      the real joinFamilyToSharedGroup path (takeMultiFamilyTurn join intent);
//   2. parent A posts a message that should clash with B's private kid/calendar;
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
const MEMORY = `zephyr-memory-${RUN}`;
const CALENDAR = `Zephyrina swim lesson ${RUN}`;
const JOIN_TEXT = 'our family is in this group';
const CLASH_TEXT =
  'Can we set the group playdate for Saturday 10am? Zephyrina could come too if she is free.';
const PREVIEW_DB_PROJECT = 'ncujspiepbuwnbmayhpb';

const mode = process.argv.slice(2);
if (mode.length !== 1 || !['--dry', '--live'].includes(mode[0])) {
  console.error('usage: preview-private-aside-proof.mjs --dry | --live');
  process.exit(2);
}
for (const p of [PARENT_A, PARENT_B]) if (!/^\+1437555\d{4}$/.test(p)) throw new Error('not fictional');

const plan = {
  chatId: CHAT,
  families: [
    { name: `Preview Ada ${RUN}`, phone: PARENT_A, private: null },
    { name: `Preview Bao ${RUN}`, phone: PARENT_B, private: { child: CHILD, memory: MEMORY, calendar: CALENDAR } },
  ],
  posts: [
    { from: PARENT_A, text: JOIN_TEXT },
    { from: PARENT_B, text: JOIN_TEXT },
    { from: PARENT_A, text: CLASH_TEXT },
  ],
  reads: [
    `/api/channels/preview/captured?to=${encodeURIComponent(PARENT_A)}`,
    `/api/channels/preview/captured?to=${encodeURIComponent(PARENT_B)}`,
    `/api/channels/preview/group-captured?chatId=${CHAT}`,
  ],
  expect: 'aside lands 1:1 to +14375550202 only; group thread never names Zephyrina/calendar',
};

if (mode[0] === '--dry') {
  console.log(JSON.stringify({ mode: 'dry', writes: 'none', network: 'none', ...plan }, null, 2));
  process.exit(0);
}

// ---- live ----
const { DATABASE_URL, APP_ENCRYPTION_KEY, PREVIEW_BASE_URL } = process.env;
if (!DATABASE_URL?.includes(PREVIEW_DB_PROJECT))
  throw new Error(`DATABASE_URL must be the Preview DB (${PREVIEW_DB_PROJECT})`);
if (!PREVIEW_BASE_URL?.startsWith('https://')) throw new Error('PREVIEW_BASE_URL=https://… required');
const key = Buffer.from(APP_ENCRYPTION_KEY ?? '', 'base64');
if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY (Preview, 32 bytes base64) required');
// Same as lib/crypto/string-cipher.ts and blind-index.ts.
const encrypt = (s) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(s, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
};
const hmacKey = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'hale-phone-blind-index-v1', 32));
const phoneHash = (p) => createHmac('sha256', hmacKey).update(p).digest('hex');

const { default: postgres } = await import('postgres');
const sql = postgres(DATABASE_URL, { prepare: false, max: 1 });
try {
  await sql.begin(async (tx) => {
    for (const f of plan.families) {
      const hash = phoneHash(f.phone);
      // Retire earlier runs' channel on this fake number so the inbound resolves to this run.
      await tx`delete from parent_channels where phone_e164_hash = ${hash}`;
      const [fam] = await tx`insert into families (display_name, province_or_state) values (${f.name}, 'ON') returning id`;
      const [u] = await tx`insert into users (external_auth_id, name) values (${`preview-vil457:${RUN}:${f.phone}`}, ${f.name}) returning id`;
      await tx`insert into family_members (family_id, user_id, role) values (${fam.id}, ${u.id}, 'primary_parent')`;
      await tx`insert into parent_channels (user_id, family_id, kind, phone_e164_encrypted, phone_e164_hash, verified_at)
               values (${u.id}, ${fam.id}, 'sms', ${encrypt(f.phone)}, ${hash}, now())`;
      if (f.private) {
        await tx`insert into children (family_id, name, date_of_birth) values (${fam.id}, ${CHILD}, '2022-04-01')`;
        await tx`insert into family_memory_facts (family_id, fact_type, fact_key, fact_value)
                 values (${fam.id}, 'preference', ${MEMORY}, ${sql.json({ note: 'hidden-memory' })})`;
        await tx`insert into family_events (family_id, title, starts_at, source)
                 values (${fam.id}, ${CALENDAR}, now() + interval '2 days', 'parent')`;
      }
      f.familyId = fam.id;
      console.log(`seeded ${f.name} ${f.phone} family=${fam.id}`);
    }
  });
} finally {
  await sql.end();
}

const secret = readFileSync(
  process.env.PREVIEW_FAKE_INBOUND_SECRET_FILE ?? '/workspace/secrets/preview-fake-inbound',
  'utf8',
).trim();
const dir = mkdtempSync(join(tmpdir(), 'ppa-'));
const hdr = join(dir, 'h');
writeFileSync(hdr, `authorization: Bearer ${secret}\ncontent-type: application/json\n`, { mode: 0o600 });
const vcurl = (path, extra = []) => {
  try {
    return execFileSync(
      'vercel',
      ['curl', path, '--deployment', PREVIEW_BASE_URL, '--', '-sS', '-H', `@${hdr}`, ...extra],
      { encoding: 'utf8', maxBuffer: 1 << 26 },
    ).split(secret).join('<redacted>');
  } catch (err) {
    return `vercel curl failed: ${String(err.stderr ?? err.message).split(secret).join('<redacted>')}`;
  }
};
try {
  for (const p of plan.posts) {
    const body = JSON.stringify({ chatId: CHAT, from: p.from, participants: [PARENT_A, PARENT_B], text: p.text });
    console.log(`POST ${p.from}: ${vcurl('/api/channels/preview/group-inbound', ['-X', 'POST', '-d', body])}`);
    await new Promise((r) => setTimeout(r, 20000)); // queued turn drains
  }
  for (const path of plan.reads) console.log(`GET ${path}\n${vcurl(path)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
