import type { AgentClient } from '@hale/agent';
import { NextResponse } from 'next/server';
import { createOutboundTransport, sendResolvingNewChat } from '~/lib/channel/outbound-transport';
import {
  PreviewCaptureRefused,
  capturedSends,
  clearCapturedSends,
} from '~/lib/channel/preview-capture-transport';
import {
  type EmailAlertNotice,
  composeEmailAlertNotice,
  emailAlertNoticeFacts,
  quietBeforeWriting,
} from '~/lib/integrations/email-alert-notice';
import { pipelineClient } from '~/lib/pipeline/client';

/**
 * THROWAWAY PROOF ROUTE: branch proof/949-preview only. Never merged, never in #949.
 *
 * Runs four invented emails through the real #949 code gate, the real notice writer
 * (email-alert-notice.md), and the real outbound door, which on this deploy must be the
 * Preview capture transport. Nothing reaches a phone, nothing touches the DB.
 *
 * 404 unless VERCEL_ENV is exactly `preview` and PREVIEW_CAPTURE_TRANSPORT is exactly `on`.
 * Without `?run=1` it only reports whether capture would start (no model calls).
 * Model calls are capped at 3 per process (worst case 3 × $0.0092 = $0.0276 < $0.03),
 * and the run is one-shot per process.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_MODEL_CALLS = 3;
const FAKE_PHONE = '+15555550100'; // fictional 555-01xx number; capture never sends anyway
const NOW = new Date('2026-09-17T15:00:00.000Z');
const ZONE = 'America/Toronto';
const ROBIN = { id: 'child-robin', name: 'Robin', ageInMonths: 40 };
let ran = false;

type Extraction = Parameters<typeof emailAlertNoticeFacts>[0]['extraction'];
function extraction(
  kind: Extraction['kind'],
  event: Partial<Extraction['event']>,
  over: Partial<Extraction> = {},
): Extraction {
  return {
    kind,
    event: {
      title: 'Untitled',
      childRef: null,
      originalTime: null,
      newTime: null,
      location: null,
      ...event,
    },
    sourceConfidence: 0.8,
    quoteEvidence: '',
    teenContent: false,
    teenAttributed: false,
    matchedEventRef: null,
    ...over,
  } as Extraction;
}

const CASES = [
  {
    id: 'non-kid (parent-own-dentist)',
    from: 'Lakeshore Dental <reminders@lakeshore-dental.example>',
    subject: 'Avery, your cleaning is confirmed',
    offer: null,
    extraction: extraction('new_event', {
      title: 'Dental cleaning',
      newTime: '2026-09-24T14:00:00.000Z',
    }),
  },
  {
    id: 'unclear (vendor "Unknown")',
    from: 'Holade <hello@holade.example>',
    subject: 'Your weekly update',
    offer: null,
    extraction: extraction('unclear', { title: 'Unknown' }),
  },
  {
    id: 'matched unchanged (Storytime reminder)',
    from: 'Maplewood Library <events@maplewood-library.example>',
    subject: 'Reminder: Storytime this Saturday',
    offer: null,
    extraction: extraction(
      'reminder_only',
      { title: 'Storytime', childRef: 'child-robin', originalTime: '2026-09-19T17:00:00.000Z' },
      { matchedEventRef: { table: 'family_events', id: 'evt-storytime' } } as Partial<Extraction>,
    ),
  },
  {
    id: 'kid email (picture day)',
    from: 'Maple Daycare <office@maple-daycare.example>',
    subject: 'Picture day next Friday',
    offer: 'add_to_week' as const,
    extraction: extraction('new_event', {
      title: 'Picture day',
      childRef: 'child-robin',
      newTime: '2026-10-02T13:00:00.000Z',
      location: 'the daycare',
    }),
  },
];

function cappedClient(inner: AgentClient, counter: { calls: number }): AgentClient {
  return {
    messages: new Proxy(inner.messages, {
      get(target, prop, receiver) {
        if (prop === 'create') {
          return (...args: unknown[]) => {
            if (counter.calls >= MAX_MODEL_CALLS) throw new Error('proof spend cap reached');
            counter.calls += 1;
            // biome-ignore lint/suspicious/noExplicitAny: pass-through to the SDK
            return (target.create as any)(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }),
  } as AgentClient;
}

export async function GET(req: Request) {
  if (
    process.env.VERCEL_ENV !== 'preview' ||
    process.env.PREVIEW_CAPTURE_TRANSPORT?.trim() !== 'on'
  ) {
    return new NextResponse('Not found', { status: 404 });
  }
  let transport: ReturnType<typeof createOutboundTransport>;
  try {
    transport = createOutboundTransport();
  } catch (err) {
    const reason = err instanceof PreviewCaptureRefused ? err.reason : 'unknown';
    return NextResponse.json({ capture: 'refused', reason, modelCalls: 0 });
  }
  if (new URL(req.url).searchParams.get('run') !== '1') {
    return NextResponse.json({ capture: 'active', modelCalls: 0, hint: 'add ?run=1 to run once' });
  }
  if (ran)
    return NextResponse.json(
      { capture: 'active', error: 'already ran in this process' },
      { status: 409 },
    );
  ran = true;
  clearCapturedSends();
  const counter = { calls: 0 };
  const client = cappedClient(pipelineClient(), counter);
  const outcomes = [];
  for (const c of CASES) {
    const quiet = quietBeforeWriting(c.extraction);
    if (quiet !== null) {
      outcomes.push({ case: c.id, sent: false, decidedBy: `code gate (${quiet})`, text: null });
      continue;
    }
    const facts = emailAlertNoticeFacts({
      from: c.from,
      subject: c.subject,
      kind: c.extraction.kind as Exclude<Extraction['kind'], 'unclear'>,
      extraction: c.extraction,
      children: [ROBIN],
      fromParentsOwnCalendar: false,
      offer: c.offer,
      otherHaleFamiliesGoing: null,
      timeZone: ZONE,
      now: NOW,
    });
    const before = counter.calls;
    const notice: EmailAlertNotice = await composeEmailAlertNotice(
      client,
      facts,
      'fake-family-proof-949',
    );
    if (notice.send) {
      await sendResolvingNewChat(transport, { to: FAKE_PHONE, body: notice.text });
      outcomes.push({
        case: c.id,
        sent: true,
        decidedBy: 'writer',
        modelCalls: counter.calls - before,
        text: notice.text,
      });
    } else {
      outcomes.push({
        case: c.id,
        sent: false,
        decidedBy: `writer (${notice.why})`,
        modelCalls: counter.calls - before,
        text: null,
      });
    }
  }
  return NextResponse.json({
    capture: 'active',
    modelCalls: counter.calls,
    worstCaseUsd: Number((counter.calls * 0.0092).toFixed(4)),
    outcomes,
    captured: capturedSends().map((s) => ({
      to: s.to,
      body: s.body,
      providerMessageId: s.providerMessageId,
    })),
  });
}
