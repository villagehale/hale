import { signupHandsScriptSource } from './hands-script';
import {
  type HandsResponse,
  type SignupHandsCommand,
  type SignupHandsSession,
  encodeHandsCommand,
  parseHandsResponse,
} from './protocol';

/**
 * Vercel Sandbox hands (VIL-395).
 *
 * The SDK client is authenticated in this process. `Sandbox.create` is not
 * given an `env` map, and `runCommand` is not given one either, so the token
 * and the OIDC token stay out of the microVM. The VM receives the hands
 * script and one command file at a time: a URL, or a control name and value.
 *
 * Nothing here calls `Sandbox.create` unless `startVercelSandbox` runs, and
 * that runs only after the runtime flag is exactly `true`, the runtime id is
 * `vercel_sandbox`, and a snapshot id plus credentials are present. Creating
 * the snapshot is a separate step Barton does in his own Vercel account.
 * This module does not create a snapshot and does not install Chromium.
 *
 * Sandbox sessions are created in Montreal (`yul1`). There is no fallback to
 * `iad1`. If that region is not available on the account, create fails and
 * the runner hands back `browser_unavailable` with `runtimeSkipped:
 * hands_failed`. Leave the flag off until Barton has confirmed Sandbox in
 * `yul1`.
 */

export const SIGNUP_BROWSER_SNAPSHOT_ID_ENV = 'SIGNUP_BROWSER_SNAPSHOT_ID';
export const SIGNUP_BROWSER_RUNTIME_ENV = 'SIGNUP_BROWSER_RUNTIME';

/** Three minutes, then the VM stops even if `stop` was not reached. */
export const SIGNUP_SANDBOX_TIMEOUT_MS = 180_000;

/** Montreal. Consented slot values do not fall back to `iad1`. */
export const SIGNUP_SANDBOX_REGION = 'yul1' as const;

const READY_ATTEMPTS = 25;
const READY_DELAY_MS = 200;

export interface VercelSandboxCreateParams {
  source: { type: 'snapshot'; snapshotId: string };
  timeout: number;
  /** Montreal. The adapter does not accept another region. */
  region: typeof SIGNUP_SANDBOX_REGION;
  networkPolicy: 'allow-all';
  token?: string;
  teamId?: string;
  projectId?: string;
}

export interface VercelSandboxCommand {
  exitCode: number | null;
  stdout(): Promise<string>;
  stderr(): Promise<string>;
}

/** The slice of `@vercel/sandbox` this adapter uses. Tests pass a fake. */
export interface VercelSandboxHandle {
  mkDir(path: string): Promise<void>;
  writeFiles(files: { path: string; content: Buffer }[]): Promise<void>;
  runCommand(params: {
    cmd: string;
    args?: string[];
    detached?: boolean;
    cwd?: string;
    env?: Record<string, string>;
    sudo?: boolean;
  }): Promise<VercelSandboxCommand>;
  stop(opts?: { blocking?: boolean }): Promise<unknown>;
}

export function vercelSandboxCreateParams(
  env: Record<string, string | undefined>,
): { ok: true; params: VercelSandboxCreateParams } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const snapshotId = env[SIGNUP_BROWSER_SNAPSHOT_ID_ENV];
  if (!armed(snapshotId)) missing.push(SIGNUP_BROWSER_SNAPSHOT_ID_ENV);
  const oidc = armed(env.VERCEL_OIDC_TOKEN);
  const token = env.VERCEL_TOKEN;
  const teamId = env.VERCEL_TEAM_ID;
  const projectId = env.VERCEL_PROJECT_ID;
  const accessToken = armed(token) && armed(teamId) && armed(projectId);
  if (!oidc && !accessToken) {
    for (const name of [
      'VERCEL_OIDC_TOKEN',
      'VERCEL_TOKEN',
      'VERCEL_TEAM_ID',
      'VERCEL_PROJECT_ID',
    ] as const) {
      if (!armed(env[name])) missing.push(name);
    }
  }
  if (missing.length > 0 || !armed(snapshotId)) return { ok: false, missing };
  const params: VercelSandboxCreateParams = {
    source: { type: 'snapshot', snapshotId },
    timeout: SIGNUP_SANDBOX_TIMEOUT_MS,
    region: SIGNUP_SANDBOX_REGION,
    networkPolicy: 'allow-all',
  };
  // OIDC is read by the SDK from this process. Do not copy it into params.
  // The access token is a create() credential for the SDK client, not a VM env var.
  if (!oidc && armed(token) && armed(teamId) && armed(projectId)) {
    params.token = token;
    params.teamId = teamId;
    params.projectId = projectId;
  }
  return { ok: true, params };
}

/**
 * Opens a sandbox from the prepared snapshot and waits until the hands daemon
 * answers `ping`. On failure the sandbox is stopped. Does not install packages.
 */
export async function startVercelSandbox(
  env: Record<string, string | undefined>,
): Promise<SignupHandsSession> {
  const built = vercelSandboxCreateParams(env);
  if (!built.ok) throw new Error('not_configured');
  const mod = (await import('@vercel/sandbox')) as {
    Sandbox: {
      create(params: VercelSandboxCreateParams): Promise<VercelSandboxHandle>;
    };
  };
  const sandbox = await mod.Sandbox.create(built.params);
  return connectVercelSandboxHands(sandbox);
}

export async function connectVercelSandboxHands(
  sandbox: VercelSandboxHandle,
  deps: { sleep?: (ms: number) => Promise<void>; attempts?: number } = {},
): Promise<SignupHandsSession> {
  const sleep = deps.sleep ?? delay;
  const attempts = deps.attempts ?? READY_ATTEMPTS;
  try {
    await sandbox.mkDir('hale-signup');
    await sandbox.writeFiles([
      { path: 'hale-signup/hands.mjs', content: Buffer.from(signupHandsScriptSource()) },
    ]);
    await sandbox.runCommand({
      cmd: 'node',
      args: ['hale-signup/hands.mjs', '--daemon'],
      detached: true,
    });
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const ready = await runHandsCommand(sandbox, { op: 'ping' });
      if (ready.ok) return handsSession(sandbox);
      await sleep(READY_DELAY_MS);
    }
  } catch {
    await stopQuietly(sandbox);
    throw new Error('hands_failed');
  }
  await stopQuietly(sandbox);
  throw new Error('hands_failed');
}

async function runHandsCommand(
  sandbox: VercelSandboxHandle,
  command: SignupHandsCommand,
): Promise<HandsResponse> {
  await sandbox.writeFiles([
    { path: 'hale-signup/cmd.json', content: Buffer.from(encodeHandsCommand(command)) },
  ]);
  const finished = await sandbox.runCommand({
    cmd: 'node',
    args: ['hale-signup/hands.mjs', '--exec', 'hale-signup/cmd.json'],
  });
  if (finished.exitCode !== 0) return { ok: false, error: 'command_failed' };
  return (
    parseHandsResponse((await finished.stdout()).trim()) ?? { ok: false, error: 'command_failed' }
  );
}

function handsSession(sandbox: VercelSandboxHandle): SignupHandsSession {
  let stopped = false;
  return {
    exec(command) {
      return runHandsCommand(sandbox, command);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await stopQuietly(sandbox);
    },
  };
}

async function stopQuietly(sandbox: VercelSandboxHandle): Promise<void> {
  await sandbox.stop({ blocking: true }).catch(() => undefined);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A value that can be passed to the API. Blank and trailing-newline values are absent. */
function armed(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && !/\s/.test(value);
}
