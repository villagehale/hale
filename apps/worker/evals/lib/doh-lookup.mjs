// EVAL-ONLY DNS override (never imported by Prod code). Armed only when
// HALE_EVAL_DOH=1: some recording boxes run a fake-IP egress proxy whose resolver
// answers every host with 198.18.0.x, so the registration/activity page fetcher's
// non-public-address guard (correctly) refuses every page. This swaps the resolver
// that guard reads — `dns/promises.lookup` — for DNS-over-HTTPS (1.1.1.1). The guard
// itself is untouched and still checks every answer with isPublicAddress, and the
// socket still connects to the pinned, checked IP.
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';

const DOH = 'https://1.1.1.1/dns-query';

async function query(name, type) {
  const res = await fetch(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`doh ${type} ${name}: http ${res.status}`);
  const body = await res.json();
  const want = type === 'A' ? 1 : 28;
  return (body.Answer ?? []).filter((a) => a.type === want).map((a) => a.data);
}

export async function dohLookup(hostname, options = {}) {
  const opts = typeof options === 'number' ? { family: options } : options;
  const [v4, v6] = await Promise.all([
    opts.family === 6 ? [] : query(hostname, 'A').catch(() => []),
    opts.family === 4 ? [] : query(hostname, 'AAAA').catch(() => []),
  ]);
  const all = [
    ...v4.map((address) => ({ address, family: 4 })),
    ...v6.map((address) => ({ address, family: 6 })),
  ];
  if (all.length === 0) {
    const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    err.code = 'ENOTFOUND';
    err.hostname = hostname;
    throw err;
  }
  return opts.all ? all : all[0];
}

export function armEvalDohLookup(env = process.env) {
  if (env.HALE_EVAL_DOH !== '1') return false;
  dns.promises.lookup = dohLookup;
  syncBuiltinESMExports();
  console.info('eval DNS: dns/promises.lookup -> DNS-over-HTTPS (1.1.1.1); page guard unchanged');
  return true;
}
