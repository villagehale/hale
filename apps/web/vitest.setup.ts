// Provide a dummy DATABASE_URL so importing modules that read env at load time
// doesn't require real infrastructure. Tests inject their own db handle.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

// The claim reader enforces by default in production, and it is a real model call
// (rule #8: no mock). A test that is about it hands a scripted reader or sets the mode;
// gate.pglite.test.ts deletes this to pin the production default.
process.env.CLAIM_READER_MODE ??= 'off';

// #868: keywords.ts is gone; stop/start is a model read. Every test gets the scripted
// reader unless it hands its own (deps.optOutReader) or installs another.
import { setSharedOptOutReader } from '~/lib/channel/intake/opt-out-reader';
import { scriptedOptOutReader } from '~/lib/channel/intake/scripted-opt-out-reader.fixture';
import { setSharedRecMorningReader } from '~/lib/channel/rec-morning/read';
import { scriptedRecMorningReader } from '~/lib/channel/rec-morning/scripted-reader.fixture';
import { setSharedSpokenLineWriter } from '~/lib/channel/spoken-line';
import { scriptedSpokenLineWriter } from '~/lib/testing/spoken-line.fixture';

setSharedOptOutReader(scriptedOptOutReader);
setSharedSpokenLineWriter(scriptedSpokenLineWriter);
setSharedRecMorningReader(scriptedRecMorningReader);
