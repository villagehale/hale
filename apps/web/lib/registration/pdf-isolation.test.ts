import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkerOptions } from 'node:worker_threads';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { registrationPdfFixture } from './pdf-fixture.test-helper';

// Spy-through ports: the real Worker and the real existsSync run unless a test steers them.
const spawned = vi.hoisted(() => ({
  calls: [] as { file: string | URL; options: WorkerOptions | undefined }[],
  exits: [] as Promise<number>[],
  failNext: null as Error | null,
  /** Runs this file in place of the real reader (the worker port), then resets. */
  swapNextFile: null as string | null,
  /** The next n terminate() calls wait for `releaseHeld` before killing the worker. */
  holdTerminates: 0,
  held: [] as (() => void)[],
  /** The next terminate() rejects and leaves the worker running. */
  rejectNextTerminate: false,
  refusedTerminates: [] as (() => Promise<number>)[],
  hideWorkerFile: false,
  /** When set, this is the only reader path that exists. */
  onlyWorkerAt: null as string | null,
}));
vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  class SpyWorker extends actual.Worker {
    constructor(file: string | URL, options?: WorkerOptions) {
      spawned.calls.push({ file, options });
      const failure = spawned.failNext;
      spawned.failNext = null;
      if (failure) throw failure;
      const swapped = spawned.swapNextFile;
      spawned.swapNextFile = null;
      super(swapped ?? file, options);
      spawned.exits.push(new Promise((resolve) => this.once('exit', resolve)));
    }
    override terminate(): Promise<number> {
      if (spawned.rejectNextTerminate) {
        spawned.rejectNextTerminate = false;
        spawned.refusedTerminates.push(() => super.terminate());
        return Promise.reject(new Error('terminate refused'));
      }
      if (spawned.holdTerminates > 0) {
        spawned.holdTerminates--;
        return new Promise((resolve) => {
          spawned.held.push(() => resolve(super.terminate()));
        });
      }
      return super.terminate();
    }
  }
  return { ...actual, Worker: SpyWorker };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => {
      if (!String(path).endsWith('pdf-worker.mjs')) return actual.existsSync(path);
      if (spawned.hideWorkerFile) return false;
      if (spawned.onlyWorkerAt !== null) return String(path) === spawned.onlyWorkerAt;
      return actual.existsSync(path);
    },
  };
});

// vitest.setup.ts already loaded resolve-repo-file with the real node:fs; a fresh registry
// makes pdf.ts and its resolver load against the spy-through ports above.
vi.resetModules();
const { pdfWorkerCandidates, registrationPdfText } = await import('./pdf');

const GUIDE = registrationPdfFixture([
  'Fall 2026. Preview August 3.',
  'Winter registration begins November 10, 2026 at 9:00 a.m.',
]);
const scratch = mkdtempSync(join(tmpdir(), 'hale-pdf-isolation-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
// Answers like the reader, then stays alive until it is terminated.
const KEEP_ALIVE_READER = join(scratch, 'keep-alive-reader.mjs');
writeFileSync(
  KEEP_ALIVE_READER,
  "import { parentPort } from 'node:worker_threads';\nparentPort.postMessage({ kind: 'reader_loaded' });\nparentPort.postMessage({ ok: true, text: 'kept alive' });\nsetInterval(() => {}, 1_000);\n",
);
const allExited = () => Promise.all(spawned.exits);
const outcomes = async (reads: ReturnType<typeof registrationPdfText>[]) =>
  (await Promise.all(reads)).map((result) => result.outcome);

// Slots free when a worker exits, which can trail the read's own result.
afterEach(async () => {
  for (const release of spawned.held.splice(0)) release();
  await Promise.all(spawned.refusedTerminates.splice(0).map((kill) => kill()));
  spawned.holdTerminates = 0;
  await allExited();
});

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

  it('never looks for the reader above the app root', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = spawned.calls.length;
    // The real reader is gone; only a file planted at the filesystem root would be found.
    spawned.onlyWorkerAt = join(parse(scratch).root, 'apps/web/lib/registration/pdf-worker.mjs');
    try {
      await expect(registrationPdfText(GUIDE)).resolves.toEqual({
        outcome: 'reader_fault',
        fault: 'reader_missing',
      });
      expect(spawned.calls).toHaveLength(before);
    } finally {
      spawned.onlyWorkerAt = null;
      error.mockRestore();
    }
    // Positive control: with the real reader back, the same read runs it.
    await expect(registrationPdfText(GUIDE)).resolves.toMatchObject({ outcome: 'read' });
    expect(String(spawned.calls[spawned.calls.length - 1]?.file)).toBe(
      fileURLToPath(new URL('./pdf-worker.mjs', import.meta.url)),
    );
  });

  it('tries the runtime location first, mapped to where tracing ships the reader', () => {
    // A moved build: the baked build-time path is gone, the real chunk dir is under .next.
    expect(
      pdfWorkerCandidates(
        '/run/apps/web/.next/server/app/api/pdf',
        'file:///build/apps/web/lib/registration/pdf.ts',
      ),
    ).toEqual([
      '/run/apps/web/lib/registration/pdf-worker.mjs',
      '/build/apps/web/lib/registration/pdf-worker.mjs',
    ]);
    // turbopack dev: no __dirname, and import.meta.url is the real source file.
    expect(pdfWorkerCandidates(undefined, 'file:///src/apps/web/lib/registration/pdf.ts')).toEqual([
      '/src/apps/web/lib/registration/pdf-worker.mjs',
    ]);
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
    await allExited();
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
    await allExited();
    const both = await Promise.all([registrationPdfText(GUIDE), registrationPdfText(GUIDE)]);
    expect(both.map((result) => result.outcome)).toEqual(['read', 'read']);
  });

  it('logs a reader fault by name and error class, never the text of its error', async () => {
    const PLANTED = 'planted-by-pdf-canary';
    const crashing = join(scratch, 'crashing-reader.mjs');
    writeFileSync(
      crashing,
      `import { parentPort } from 'node:worker_threads';\nparentPort.postMessage({ kind: 'reader_loaded' });\nthrow new TypeError('${PLANTED} crash');\n`,
    );
    const missing = join(scratch, 'missing-reader.mjs');
    writeFileSync(
      missing,
      `import { parentPort } from 'node:worker_threads';\nparentPort.postMessage({ ok: false, kind: 'reader_missing', message: '${PLANTED} missing' });\nsetInterval(() => {}, 1_000);\n`,
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      spawned.failNext = new RangeError(`${PLANTED} spawn`);
      await expect(registrationPdfText(GUIDE)).resolves.toEqual({
        outcome: 'reader_fault',
        fault: 'reader_spawn_failed',
      });
      spawned.swapNextFile = crashing;
      await expect(registrationPdfText(GUIDE)).resolves.toEqual({
        outcome: 'reader_fault',
        fault: 'reader_crashed',
      });
      spawned.swapNextFile = missing;
      await expect(registrationPdfText(GUIDE)).resolves.toEqual({
        outcome: 'reader_fault',
        fault: 'reader_missing',
      });
      expect(error.mock.calls).toEqual([
        [
          { fault: 'reader_spawn_failed', errorClass: 'RangeError' },
          'registration pdf: reader failed',
        ],
        [{ fault: 'reader_crashed', errorClass: 'TypeError' }, 'registration pdf: reader failed'],
        [{ fault: 'reader_missing', errorClass: null }, 'registration pdf: reader failed'],
      ]);
      const logged = JSON.stringify(error.mock.calls);
      expect(logged).toContain('reader_crashed');
      expect(logged).not.toContain(PLANTED);
    } finally {
      error.mockRestore();
    }
  });

  it('holds the slot of a terminated worker until it exits, so a third read is busy', async () => {
    spawned.holdTerminates = 2;
    spawned.swapNextFile = KEEP_ALIVE_READER;
    const first = registrationPdfText(GUIDE);
    spawned.swapNextFile = KEEP_ALIVE_READER;
    const second = registrationPdfText(GUIDE);
    await vi.waitFor(() => expect(spawned.held).toHaveLength(2));

    await expect(registrationPdfText(GUIDE)).resolves.toEqual({
      outcome: 'busy',
      reason: 'pdf_readers_busy',
    });
    // The reads themselves resolved without waiting for their workers to exit.
    expect(await outcomes([first, second])).toEqual(['read', 'read']);

    // Positive control: once 'exit' fires, both slots are free again.
    for (const release of spawned.held.splice(0)) release();
    await allExited();
    expect(await outcomes([registrationPdfText(GUIDE), registrationPdfText(GUIDE)])).toEqual([
      'read',
      'read',
    ]);
  });

  it('resolves when terminate rejects, logs it by name, and frees the slot on exit', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      spawned.rejectNextTerminate = true;
      spawned.swapNextFile = KEEP_ALIVE_READER;
      await expect(registrationPdfText(GUIDE)).resolves.toEqual({
        outcome: 'read',
        pageDerivedText: 'kept alive',
      });
      await vi.waitFor(() => expect(spawned.refusedTerminates).toHaveLength(1));
      expect(error).toHaveBeenCalledWith(
        { fault: 'reader_terminate_failed', errorClass: 'Error' },
        'registration pdf: reader terminate failed',
      );
      expect(JSON.stringify(error.mock.calls)).not.toContain('terminate refused');
    } finally {
      error.mockRestore();
    }
    // The worker that refused to stop still holds its slot: one read fits, a second is busy.
    expect(await outcomes([registrationPdfText(GUIDE), registrationPdfText(GUIDE)])).toEqual([
      'read',
      'busy',
    ]);

    await Promise.all(spawned.refusedTerminates.splice(0).map((kill) => kill()));
    await allExited();
    expect(await outcomes([registrationPdfText(GUIDE), registrationPdfText(GUIDE)])).toEqual([
      'read',
      'read',
    ]);
  });

  it('frees a slot once when terminate resolves and exit fires, never twice', async () => {
    await expect(registrationPdfText(GUIDE)).resolves.toMatchObject({ outcome: 'read' });
    await allExited();
    expect(
      await outcomes([
        registrationPdfText(GUIDE),
        registrationPdfText(GUIDE),
        registrationPdfText(GUIDE),
      ]),
    ).toEqual(['read', 'read', 'busy']);
  });
});
