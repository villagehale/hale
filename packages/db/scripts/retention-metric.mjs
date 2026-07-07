#!/usr/bin/env node
// Prints the mentor-bar retention metric: families that opened the app on 3+
// distinct (Toronto-local) days in the last 14 days, from family_active_days.
// Usage: DATABASE_URL=... node scripts/retention-metric.mjs
import postgres from 'postgres';

const url = process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL (or DATABASE_DIRECT_URL) is required');
  process.exit(1);
}

const sql = postgres(url, { prepare: false, ssl: 'require', max: 1 });
try {
  const rows = await sql`
    SELECT f.display_name, t.days
    FROM (
      SELECT family_id, count(*)::int AS days
      FROM family_active_days
      WHERE day >= ((now() AT TIME ZONE 'America/Toronto')::date - 13)
      GROUP BY family_id
    ) t
    JOIN families f ON f.id = t.family_id
    ORDER BY t.days DESC`;
  const retained = rows.filter((r) => r.days >= 3);
  const [waitlist] = await sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE tier = 'plus')::int AS plus,
           count(*) FILTER (WHERE tier = 'family')::int AS family
    FROM waitlist`;
  console.log(`waitlist signups: ${waitlist.total} (plus ${waitlist.plus} · family ${waitlist.family})`);
  console.log(`active families (14d): ${rows.length}`);
  console.log(`retained (3+ days of 14): ${retained.length}`);
  for (const r of rows) {
    console.log(`  ${r.days >= 3 ? '✓' : '·'} ${r.display_name}: ${r.days} day(s)`);
  }
} finally {
  await sql.end({ timeout: 5 });
}
