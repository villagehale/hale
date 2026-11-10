import { vi } from 'vitest';

// Provide a dummy DATABASE_URL so importing modules that read env at load time
// doesn't require real infrastructure. Tests inject their own db handle.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

// Setup files import production modules that close over `forceToolJson`. A later
// per-file `vi.mock` cannot rebind those. Wrap the real seam so a test can stub
// it, and a fake AgentClient still reaches the original implementation.
const forceToolJson = vi.hoisted(() => vi.fn());
vi.mock('~/lib/pipeline/structured', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/pipeline/structured')>();
  forceToolJson.mockImplementation((args) => actual.forceToolJson(args));
  return { ...actual, forceToolJson };
});

// #868: keywords.ts is gone; stop/start is a model read. Every test gets the scripted
// reader unless it hands its own (deps.optOutReader) or installs another.
import { setSharedOptOutReader } from '~/lib/channel/intake/opt-out-reader';
import { scriptedOptOutReader } from '~/lib/channel/intake/scripted-opt-out-reader.fixture';
import { setSharedMeaningScreen } from '~/lib/channel/meaning-screen/read';
import { cleanMeaningScreen } from '~/lib/channel/meaning-screen/scripted-reader.fixture';
import { setDefaultClaimEnforcer } from '~/lib/channel/reconcile/claim-enforce-slot';
import { setSharedRecMorningReader } from '~/lib/channel/rec-morning/read';
import { scriptedRecMorningReader } from '~/lib/channel/rec-morning/scripted-reader.fixture';
import { scriptedRecMorningTopicPicker } from '~/lib/channel/rec-morning/scripted-topic-picker.fixture';
import { setSharedRecMorningTopicPicker } from '~/lib/channel/rec-morning/topic';
import { setSharedSpokenLineWriter } from '~/lib/channel/spoken-line';
import { cleanClaimEnforcer } from '~/lib/testing/claim-enforcer.fixture';
import { scriptedSpokenLineWriter } from '~/lib/testing/spoken-line.fixture';

setSharedOptOutReader(scriptedOptOutReader);
setSharedSpokenLineWriter(scriptedSpokenLineWriter);
setSharedRecMorningReader(scriptedRecMorningReader);
setSharedRecMorningTopicPicker(scriptedRecMorningTopicPicker);
setSharedMeaningScreen(cleanMeaningScreen);
setDefaultClaimEnforcer(cleanClaimEnforcer());
