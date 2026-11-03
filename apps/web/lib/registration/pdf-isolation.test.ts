import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerOptions } from 'node:worker_threads';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { registrationPdfFixture } from './pdf-fixture.test-helper';

// Spy-through ports: the real Worker and the real existsSync run unless a test steers them.
const spawned = vi.hoisted(() => ({
  calls: [] as { file: string | URL; options: WorkerOptions | undefined }[],
  failNext: null as Error | null,
  rejectNextTerminate: false,
  hideWorkerFile: false,
}));
vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  class SpyWorker extends actual.Worker {
    constructor(file: string | URL, options?: WorkerOptions) {
      spawned.calls.push({ file, options });
      const failure = spawned.failNext;
      spawned.failNext = null;
      if (failure) throw failure;
      super(file, options);
    }
    override terminate(): Promise<number> {
      const terminated = super.terminate();
      if (!spawned.rejectNextTerminate) return terminated;
      spawned.rejectNextTerminate = false;
      return terminated.then(() => Promise.reject(new Error('terminate refused')));
    }
  }
  return { ...actual, Worker: SpyWorker };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      spawned.hideWorkerFile && String(path).endsWith('pdf-worker.mjs')
        ? false
        : actual.existsSync(path),
  };
});

// vitest.setup.ts already loaded resolve-repo-file with the real node:fs; a fresh registry
// makes pdf.ts and its resolver load against the spy-through ports above.
vi.resetModules();
const { registrationPdfText } = await import('./pdf');

const GUIDE = registrationPdfFixture([
  'Fall 2026. Preview August 3.',
  'Winter registration begins November 10, 2026 at 9:00 a.m.',
]);
const scratch = mkdtempSync(join(tmpdir(), 'hale-pdf-isolation-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function probe(file: string, options: WorkerOptions | undefined): Promise<unknown> {
  const { Worker } =
    await vi.importActual<typeof import('node:worker_threads')>('node:worker_threads');
  const worker = new Worker(file, options);
  try {
    return await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
  } finally {
    await worker.terminate();
  }
}

describe('the PDF reader worker is isolated from the parent process', () => {
  it('spawns the reader with an empty environment, so no server secret reaches pdf.js', async () => {
    vi.stubEnv('HALE_PDF_ENV_CANARY', 'parent-only');
    try {
      await expect(registrationPdfText(GUIDE)).resolves.toMatchObject({ outcome: 'read' });
      const { options } = spawned.calls[spawned.calls.length - 1]!;
      const envProbe = join(scratch, 'env-probe.mjs');
      writeFileSync(
        envProbe,
        "import { parentPort } from 'node:worker_threads';\nparentPort.postMessage(process.env.HALE_PDF_ENV_CANARY ?? null);\n",
      );
      expect(await probe(envProbe, options)).toBeNull();
      expect(await probe(envProbe, { ...options, env: undefined })).toBe('parent-only');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('runs the module’s own worker file, never one planted under the cwd', async () => {
    const decoyRoot = join(scratch, 'decoy');
    mkdirSync(join(decoyRoot, 'apps/web/lib/registration'), { recursive: true });
    writeFileSync(
      join(decoyRoot, 'apps/web/lib/registration/pdf-worker.mjs'),
      "import { parentPort } from 'node:worker_threads';\nparentPort.postMessage({ kind: 'reader_loaded' });\nparentPort.postMessage({ ok: true, text: 'decoy worker ran' });\n",
    );
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(decoyRoot);
    try {
      // Loaded under the decoy cwd too, so a cwd read at import time is caught as well.
      vi.resetModules();
      const loadedUnderDecoy = await import('./pdf');
      const result = await loadedUnderDecoy.registrationPdfText(GUIDE);
      expect(result).toMatchObject({
        outcome: 'read',
        pageDerivedText: expect.stringContaining('Winter registration begins November 10, 2026'),
      });
      expect(JSON.stringify(result)).not.toContain('decoy');
      const { file } = spawned.calls[spawned.calls.length - 1]!;
      expect(String(file).startsWith(decoyRoot)).toBe(false);
    } finally {
      cwd.mockRestore();
    }
  });

  it('names a reader that cannot spawn a reader fault and releases its slot', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      spawned.failNext = Object.assign(new Error('spawn refused'), {
        code: 'ERR_WORKER_INIT_FAILED',
      });
      await expect(registrationPdfText(GUIDE)).resolves.toEqual({
        outcome: 'reader_fault',
        fault: 'reader_spawn_failed',
      });
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ fault: 'reader_spawn_failed' }),
        expect.any(String),
      );
    } finally {
      error.mockRestore();
    }
    await expect(registrationPdfText(GUIDE)).resolves.toMatchObject({ outcome: 'read' });
  });

  it('names a missing worker file a reader fault and releases its slot', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = spawned.calls.length;
    spawned.hideWorkerFile = true;
    try {
      await expect(registrationPdfText(GUIDE)).resolves.toEqual({
        outcome: 'reader_fault',
        fault: 'reader_missing',
      });
      expect(spawned.calls).toHaveLength(before);
    } finally {
      spawned.hideWorkerFile = false;
      error.mockRestore();
    }
    const both = await Promise.all([registrationPdfText(GUIDE), registrationPdfText(GUIDE)]);
    expect(both.map((result) => result.outcome)).toEqual(['read', 'read']);
  });

  it('frees its slot and still resolves when terminating the worker rejects', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      spawned.rejectNextTerminate = true;
      await expect(registrationPdfText(GUIDE)).resolves.toMatchObject({ outcome: 'read' });
      expect(spawned.rejectNextTerminate).toBe(false);
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ fault: 'reader_terminate_failed' }),
        expect.any(String),
      );
    } finally {
      error.mockRestore();
    }
    // Both slots free: a leaked slot would name the second of these busy.
    const both = await Promise.all([registrationPdfText(GUIDE), registrationPdfText(GUIDE)]);
    expect(both.map((result) => result.outcome)).toEqual(['read', 'read']);
  });
});
