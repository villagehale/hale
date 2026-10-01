import { describe, expect, it, vi } from 'vitest';
import type { RawPageSnapshot } from '../snapshot-in-page';
import { acquireSignupBrowser } from './acquire';
import { signupHandsScriptSource } from './hands-script';
import {
  type SignupHandsCommand,
  type SignupHandsSession,
  encodeHandsCommand,
  parseHandsResponse,
} from './protocol';
import { sessionSignupBrowser } from './session-browser';
import {
  type VercelSandboxHandle,
  connectVercelSandboxHands,
  vercelSandboxCreateParams,
} from './vercel';

const SENTINEL = 'tok_should_stay_out_of_the_sandbox';

const RAW: RawPageSnapshot = {
  href: 'https://example.com/register',
  controls: [
    {
      name: 'child_first_name',
      type: 'text',
      required: true,
      label: 'Child first name',
      autocomplete: null,
      options: [],
    },
  ],
  priceCents: [],
  captcha: false,
  confirmed: false,
  formText: 'Parent and tot swim',
  waitingRoom: false,
  submitLabel: 'Continue',
  bodyText: 'you are in line',
};

function recordingSession(snapshot: RawPageSnapshot = RAW) {
  const commands: SignupHandsCommand[] = [];
  let stopped = false;
  const session: SignupHandsSession = {
    async exec(command) {
      commands.push(structuredClone(command));
      if (command.op === 'snapshot') return { ok: true, snapshot };
      return { ok: true };
    },
    async stop() {
      stopped = true;
    },
  };
  return {
    session,
    commands,
    stopped: () => stopped,
  };
}

function configured(overrides: Record<string, string | undefined> = {}) {
  return {
    SIGNUP_SANDBOX_RUNTIME_ENABLED: 'true',
    SIGNUP_BROWSER_RUNTIME: 'vercel_sandbox',
    SIGNUP_BROWSER_SNAPSHOT_ID: 'snap_test',
    VERCEL_TOKEN: SENTINEL,
    VERCEL_TEAM_ID: 'team_test',
    VERCEL_PROJECT_ID: 'prj_test',
    ...overrides,
  };
}

describe('signup hands command', () => {
  it('encodes only the op and the slot the backend already chose', () => {
    const encoded = encodeHandsCommand({
      op: 'fill',
      name: 'child_first_name',
      value: 'Ada',
      token: SENTINEL,
    } as SignupHandsCommand);
    expect(encoded).toBe('{"op":"fill","name":"child_first_name","value":"Ada"}');
    expect(encoded).not.toContain(SENTINEL);
  });

  it('drops fields the page is not allowed to add to a snapshot', () => {
    const parsed = parseHandsResponse(
      JSON.stringify({
        ok: true,
        token: SENTINEL,
        snapshot: {
          ...RAW,
          credential: SENTINEL,
          controls: [{ ...RAW.controls[0], value: SENTINEL, secret: SENTINEL }],
        },
      }),
    );
    expect(parsed?.ok).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain(SENTINEL);
  });
});

describe('session signup browser', () => {
  it('sends the url and then consented name/value pairs, and classifies rush here', async () => {
    const { session, commands, stopped } = recordingSession();
    const browser = sessionSignupBrowser(session);
    const page = await browser.open('https://example.com/register');
    const snapshot = await page.snapshot();
    await page.fill('child_first_name', 'Ada');
    await page.select('session', 'tue-1630');
    await page.close();

    expect(commands).toEqual([
      { op: 'open', url: 'https://example.com/register' },
      { op: 'snapshot' },
      { op: 'fill', name: 'child_first_name', value: 'Ada' },
      { op: 'select', name: 'session', value: 'tue-1630' },
    ]);
    expect(JSON.stringify(commands)).not.toContain(SENTINEL);
    expect(snapshot.waitingRoom).toBe(true);
    expect(snapshot).not.toHaveProperty('bodyText');
    expect(stopped()).toBe(true);
  });

  it('refuses a private url before the session sees it, and stops the session', async () => {
    const { session, commands, stopped } = recordingSession();
    const browser = sessionSignupBrowser(session);
    await expect(browser.open('http://10.1.1.1/register')).rejects.toThrow('url_refused');
    expect(commands).toEqual([]);
    expect(stopped()).toBe(true);
  });
});

describe('vercel sandbox create params', () => {
  it('keeps credentials on the SDK client and out of a VM env map', () => {
    const built = vercelSandboxCreateParams(configured());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.params).toEqual({
      source: { type: 'snapshot', snapshotId: 'snap_test' },
      timeout: 180_000,
      region: 'yul1',
      networkPolicy: 'allow-all',
      token: SENTINEL,
      teamId: 'team_test',
      projectId: 'prj_test',
    });
    expect(built.params).not.toHaveProperty('env');
  });

  it('does not copy an OIDC token into the create params when one is set', () => {
    const built = vercelSandboxCreateParams(
      configured({
        VERCEL_OIDC_TOKEN: 'oidc_should_stay_in_this_process',
        VERCEL_TOKEN: undefined,
        VERCEL_TEAM_ID: undefined,
        VERCEL_PROJECT_ID: undefined,
      }),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.params).not.toHaveProperty('token');
    expect(built.params).not.toHaveProperty('env');
    expect(JSON.stringify(built.params)).not.toContain('oidc_should_stay_in_this_process');
  });

  it('does not build params when the snapshot id has a trailing newline', () => {
    const built = vercelSandboxCreateParams(
      configured({ SIGNUP_BROWSER_SNAPSHOT_ID: 'snap_test\n' }),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.missing).toContain('SIGNUP_BROWSER_SNAPSHOT_ID');
  });
});

describe('connectVercelSandboxHands', () => {
  it('writes the hands script and command files only, with no env and no token', async () => {
    vi.stubEnv('VERCEL_TOKEN', SENTINEL);
    const files: { path: string; content: string }[] = [];
    const calls: { args?: string[]; detached?: boolean; env?: unknown }[] = [];
    let stopped = false;
    const sandbox: VercelSandboxHandle = {
      async mkDir() {},
      async writeFiles(input) {
        for (const file of input) {
          files.push({ path: file.path, content: file.content.toString('utf8') });
        }
      },
      async runCommand(params) {
        calls.push({ args: params.args, detached: params.detached, env: params.env });
        if (params.detached) {
          return {
            exitCode: null,
            async stdout() {
              return '';
            },
            async stderr() {
              return '';
            },
          };
        }
        const cmd = files.findLast((file) => file.path === 'hale-signup/cmd.json');
        const parsed = JSON.parse(cmd?.content ?? '{}') as { op?: string };
        if (parsed.op === 'ping') {
          return {
            exitCode: 0,
            async stdout() {
              return '{"ok":true}';
            },
            async stderr() {
              return '';
            },
          };
        }
        if (parsed.op === 'snapshot') {
          return {
            exitCode: 0,
            async stdout() {
              return JSON.stringify({ ok: true, snapshot: RAW });
            },
            async stderr() {
              return '';
            },
          };
        }
        return {
          exitCode: 0,
          async stdout() {
            return '{"ok":true}';
          },
          async stderr() {
            return '';
          },
        };
      },
      async stop() {
        stopped = true;
      },
    };

    const session = await connectVercelSandboxHands(sandbox, {
      sleep: async () => {},
      attempts: 3,
    });
    await session.exec({ op: 'fill', name: 'parent_email', value: 'ada@example.test' });
    await session.stop();

    expect(calls[0]).toEqual({
      args: ['hale-signup/hands.mjs', '--daemon'],
      detached: true,
      env: undefined,
    });
    expect(calls.every((call) => call.env === undefined)).toBe(true);
    const command = files.findLast((file) => file.path === 'hale-signup/cmd.json');
    expect(command?.content).toBe('{"op":"fill","name":"parent_email","value":"ada@example.test"}');
    expect(JSON.stringify(files)).not.toContain(SENTINEL);
    expect(files.some((file) => file.path === 'hale-signup/hands.mjs')).toBe(true);
    expect(stopped).toBe(true);
  });

  it('stops the sandbox when the hands daemon never answers', async () => {
    let stopped = false;
    const sandbox: VercelSandboxHandle = {
      async mkDir() {},
      async writeFiles() {},
      async runCommand() {
        return {
          exitCode: 1,
          async stdout() {
            return '';
          },
          async stderr() {
            return 'down';
          },
        };
      },
      async stop() {
        stopped = true;
      },
    };
    await expect(
      connectVercelSandboxHands(sandbox, { sleep: async () => {}, attempts: 2 }),
    ).rejects.toThrow('hands_failed');
    expect(stopped).toBe(true);
  });
});

describe('acquireSignupBrowser', () => {
  it('stays on local Playwright when the flag is off, even if a remote runtime is named', async () => {
    const vercelStart = vi.fn();
    const browser = {
      async open() {
        throw new Error('not opened');
      },
    };
    const result = await acquireSignupBrowser({
      env: configured({ SIGNUP_SANDBOX_RUNTIME_ENABLED: 'true\n' }),
      local: async () => browser,
      vercelStart,
    });
    expect(result.browser).toBe(browser);
    expect(result.skipped).toBeNull();
    expect(vercelStart).not.toHaveBeenCalled();
  });

  it('names chromium_missing when the flag is off and Chromium is absent', async () => {
    const vercelStart = vi.fn();
    const result = await acquireSignupBrowser({
      env: {},
      local: async () => null,
      vercelStart,
    });
    expect(result).toMatchObject({
      runtime: 'local',
      browser: null,
      skipped: 'chromium_missing',
    });
    expect(vercelStart).not.toHaveBeenCalled();
  });

  it('does not start Vercel when the flag is on but the runtime id is unset', async () => {
    const vercelStart = vi.fn();
    const result = await acquireSignupBrowser({
      env: configured({ SIGNUP_BROWSER_RUNTIME: undefined }),
      local: async () => {
        throw new Error('local should not run');
      },
      vercelStart,
    });
    expect(result.skipped).toBe('not_configured');
    expect(result.missing).toEqual(['SIGNUP_BROWSER_RUNTIME']);
    expect(result.browser).toBeNull();
    expect(vercelStart).not.toHaveBeenCalled();
  });

  it('does not start Vercel when the snapshot id is missing', async () => {
    const vercelStart = vi.fn();
    const result = await acquireSignupBrowser({
      env: configured({ SIGNUP_BROWSER_SNAPSHOT_ID: '' }),
      vercelStart,
    });
    expect(result.skipped).toBe('not_configured');
    expect(result.missing).toContain('SIGNUP_BROWSER_SNAPSHOT_ID');
    expect(vercelStart).not.toHaveBeenCalled();
  });

  it('leaves Browserbase as a named not_built slot', async () => {
    const vercelStart = vi.fn();
    const result = await acquireSignupBrowser({
      env: configured({ SIGNUP_BROWSER_RUNTIME: 'browserbase' }),
      vercelStart,
    });
    expect(result).toMatchObject({
      runtime: 'browserbase',
      browser: null,
      skipped: 'not_built',
    });
    expect(vercelStart).not.toHaveBeenCalled();
  });

  it('uses the fake Vercel runtime and still forwards only hands commands', async () => {
    const { session, commands } = recordingSession();
    const vercelStart = vi.fn(async () => session);
    const result = await acquireSignupBrowser({
      env: configured(),
      local: async () => {
        throw new Error('local should not run');
      },
      vercelStart,
    });
    expect(vercelStart).toHaveBeenCalledOnce();
    expect(result.skipped).toBeNull();
    const page = await result.browser?.open('https://example.com/register');
    await page?.fill('postal_code', 'M5V2T6');
    expect(commands).toEqual([
      { op: 'open', url: 'https://example.com/register' },
      { op: 'fill', name: 'postal_code', value: 'M5V2T6' },
    ]);
    expect(JSON.stringify(commands)).not.toContain(SENTINEL);
  });

  it('names hands_failed when the fake runtime cannot start', async () => {
    const result = await acquireSignupBrowser({
      env: configured(),
      vercelStart: async () => {
        throw new Error('hands_failed');
      },
    });
    expect(result).toMatchObject({
      runtime: 'vercel_sandbox',
      browser: null,
      skipped: 'hands_failed',
    });
  });
});

describe('signup hands script', () => {
  it('does not read the environment', () => {
    vi.stubEnv('VERCEL_TOKEN', SENTINEL);
    const source = signupHandsScriptSource();
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toContain(SENTINEL);
    expect(source).toContain('127.0.0.1');
    expect(source).toContain('function registrationUrlAllowed');
    expect(source).toContain('function collectPageSnapshot');
    expect(source).toContain('function byName');
    const match = source.match(/const byName = (function byName\(name\) \{[\s\S]*?\n\});/);
    expect(match?.[1]).toBeTruthy();
    const byName = new Function(`return (${match?.[1]});`)() as (name: string) => string;
    expect(byName('child_first_name')).toBe('[name="child_first_name"]');
    expect(byName('a"b')).toBe('[name="a\\"b"]');
  });
});
