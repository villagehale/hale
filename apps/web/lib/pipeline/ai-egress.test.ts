import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * NON-ANTHROPIC AI EGRESS lives only where a reviewer has signed for it (VIL-556).
 *
 * Content Hale received from Gmail or Google Calendar is sent to Anthropic only. The two
 * non-Anthropic transports in lib/pipeline (jev.ts and budgetedAiGateway in client.ts)
 * refuse to run without a NonGoogleClearance (provider-clearance.ts). That only holds if
 * no third transport appears beside them, so this test fails CI when a known AI host, a
 * redirected client base URL or a gateway key name shows up in any other file.
 *
 * Same shape as no-raw-anthropic.test.ts. Adding a file to the allowlist is a deliberate
 * act: its justification says whether that egress is clearance-gated.
 *
 * RESIDUAL, said plainly: this is a token list. A plain fetch to an AI host nobody has
 * listed here still passes. Review has to catch a brand-new provider.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');

const EGRESS_TOKENS = [
  'ai-gateway.vercel.sh',
  'baseURL:',
  'baseURL ',
  'baseURL,',
  'baseURL}',
  'ANTHROPIC_BASE_URL',
  'api.browser-use.com',
  'api.openai.com',
  'api.deepseek.com',
  'openrouter.ai',
  'generativelanguage.googleapis.com',
  'AI_GATEWAY_API_KEY',
  'VERCEL_KEY',
  'JEV_KEY',
] as const;

const ALLOWLIST: Record<string, string> = {
  'apps/web/lib/pipeline/jev.ts':
    'clearance-gated: assertClearance runs before key read and egress',
  'apps/web/lib/pipeline/client.ts':
    'clearance-gated: assertClearance runs before key read and egress',
  'apps/web/lib/channel/linq/voice-speech.ts':
    'clearance-gated: assertClearance runs before key read and egress (VIL-495 TTS + transcription)',
  'apps/web/lib/signup/browser-use/client.ts':
    'UNGATED: owned by #1009; §11.2 open decision blocks the privacy sentence',
};

const SCAN_ROOTS = [
  'apps/web/app',
  'apps/web/lib',
  'apps/web/components',
  'apps/web/scripts',
  'apps/worker/src',
  'apps/worker/scripts',
  'packages',
];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo']);
const SOURCE_EXT = /\.(ts|tsx|mjs|js)$/;

/** The AI-egress tokens a source text contains, in list order. */
function findEgressTokens(source: string): string[] {
  return EGRESS_TOKENS.filter((token) => source.includes(token));
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!SOURCE_EXT.test(name)) continue;
    if (name.includes('.test.') || name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

function filesWithEgress(): string[] {
  const found: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (!existsSync(abs)) continue;
    for (const file of sourceFiles(abs)) {
      if (findEgressTokens(readFileSync(file, 'utf8')).length > 0) {
        found.push(file.slice(REPO_ROOT.length + 1));
      }
    }
  }
  return found.sort();
}

describe('findEgressTokens', () => {
  it('positive control: sees a redirected client and a provider host', () => {
    expect(findEgressTokens("new OpenAI({ baseURL: 'https://api.openai.com/v1' })")).toEqual([
      'baseURL:',
      'api.openai.com',
    ]);
  });

  it.each([
    [
      'the Anthropic SDK base-URL override',
      'const base = process.env.ANTHROPIC_BASE_URL;',
      'ANTHROPIC_BASE_URL',
    ],
    ['a shorthand baseURL mid-object', 'new Anthropic({ baseURL, apiKey })', 'baseURL,'],
    ['a shorthand baseURL closing the object', 'new Anthropic({ apiKey, baseURL})', 'baseURL}'],
  ])('positive control: sees %s', (_label, fixture, token) => {
    expect(findEgressTokens(fixture)).toEqual([token]);
  });

  it('sees nothing in a plain Anthropic construction', () => {
    expect(findEgressTokens('new Anthropic({ apiKey, ...budget })')).toEqual([]);
  });
});

describe('non-Anthropic AI egress only in allowlisted files (VIL-556)', () => {
  const found = filesWithEgress();

  it('positive control: the scanner sees the gated transports', () => {
    expect(found).toContain('apps/web/lib/pipeline/jev.ts');
    expect(found).toContain('apps/web/lib/pipeline/client.ts');
  });

  it('no file outside the allowlist reaches a non-Anthropic AI provider', () => {
    const strangers = found.filter((file) => !(file in ALLOWLIST));
    expect(
      strangers,
      `These files name a non-Anthropic AI host, a redirected base URL or a gateway key. Google-derived content must reach Anthropic only, so route through a clearance-gated transport in lib/pipeline, or add the file here WITH a justification that says whether it is gated:
  ${strangers.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the allowlist carries no stale entries', () => {
    const foundSet = new Set(found);
    const stale = Object.keys(ALLOWLIST).filter((file) => !foundSet.has(file));
    expect(
      stale,
      `These ALLOWLIST entries no longer reach a non-Anthropic AI provider — remove them so the list stays the real inventory:
  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });
});
