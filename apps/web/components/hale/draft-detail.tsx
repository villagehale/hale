/**
 * The drafted-action detail — what Hale actually composed for a pending approval,
 * rendered so a parent can decide in one glance. Replaces the raw-JSON dump: we
 * surface the salient fields per action type with human labels, promote the
 * decision-relevant ones (an activity's source + Hale's coverage note) to always
 * visible, and tuck the rest behind a keyboard-operable disclosure. Internal
 * plumbing (candidate_id, kind, raw event_type) is never shown — meaning, not
 * machinery. Payload is null when redacted for a 13+ child (rule #1); the page
 * guards that, and this component renders nothing if it slips through.
 */

const HIDDEN_FIELDS = new Set(['candidate_id', 'kind', 'event_type']);

function str(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** A number field, formatted; supports amountUsd (currency) and plain counts. */
function num(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const USD = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'USD' });

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="eyebrow">{label}</span>
      <span className="text-spruce leading-relaxed break-words">{children}</span>
    </div>
  );
}

function SourceLink({ url }: { url: string }) {
  const host = hostOf(url);
  if (!host) return null;
  return (
    <a href={url} className="link" target="_blank" rel="noopener noreferrer">
      view source ({host}) →
    </a>
  );
}

/** Hale's honest confidence about coverage — a quiet caption, framed as its note. */
function CoverageNote({ note }: { note: string }) {
  return <p className="meta text-faded-sage leading-relaxed">Hale&rsquo;s note: {note}</p>;
}

/** Any remaining string fields we don't have a bespoke label for, degraded to a
 * labeled line rather than dumped — never JSON. */
function ExtraLines({
  payload,
  shown,
}: {
  payload: Record<string, unknown>;
  shown: Set<string>;
}) {
  const extras = Object.keys(payload).filter(
    (key) => !shown.has(key) && !HIDDEN_FIELDS.has(key) && str(payload, key) !== null,
  );
  if (extras.length === 0) return null;
  return (
    <>
      {extras.map((key) => (
        <Line key={key} label={key.replaceAll('_', ' ')}>
          {str(payload, key)}
        </Line>
      ))}
    </>
  );
}

function EmailBody({ payload }: { payload: Record<string, unknown> }) {
  const to = str(payload, 'to');
  const subject = str(payload, 'subject');
  const body = str(payload, 'body');
  const shown = new Set(['to', 'subject', 'body', 'from', 'cc']);
  return (
    <>
      {to ? <Line label="to">{to}</Line> : null}
      {subject ? <Line label="subject">{subject}</Line> : null}
      {body ? (
        <Line label="message">
          <span className="line-clamp-4">{body}</span>
        </Line>
      ) : null}
      <ExtraLines payload={payload} shown={shown} />
    </>
  );
}

function CalendarBody({ payload }: { payload: Record<string, unknown> }) {
  const title = str(payload, 'title');
  const when = str(payload, 'when') ?? str(payload, 'date');
  const where = str(payload, 'location');
  const shown = new Set(['title', 'when', 'date', 'location']);
  return (
    <>
      {title ? (
        <p className="font-display text-[1.0625rem] text-spruce">{title}</p>
      ) : null}
      {when ? <Line label="when">{when}</Line> : null}
      {where ? <Line label="where">{where}</Line> : null}
      <ExtraLines payload={payload} shown={shown} />
    </>
  );
}

function SupplyBody({ payload }: { payload: Record<string, unknown> }) {
  const item = str(payload, 'item');
  const amount = num(payload, 'amountUsd');
  const quantity = num(payload, 'quantity');
  const shown = new Set(['item', 'amountUsd', 'quantity']);
  return (
    <>
      {item ? (
        <p className="font-display text-[1.0625rem] text-spruce">{item}</p>
      ) : null}
      {quantity !== null ? <Line label="quantity">{quantity}</Line> : null}
      {amount !== null ? (
        <Line label="amount">
          <span className="tabular">{USD.format(amount)}</span>
        </Line>
      ) : null}
      <ExtraLines payload={payload} shown={shown} />
    </>
  );
}

/** An activity Hale discovered and is drafting into your routine — the case in the
 * screenshot. Title + summary are the substance; source + coverage note are the
 * decision-relevant honesty, promoted to always-visible by the caller. */
function ActivityBody({ payload }: { payload: Record<string, unknown> }) {
  const title = str(payload, 'title');
  const summary = str(payload, 'summary');
  const shown = new Set(['title', 'summary', 'source_url', 'coverage_note']);
  return (
    <>
      {title ? (
        <p className="font-display text-[1.0625rem] text-spruce">{title}</p>
      ) : null}
      {summary ? <p className="text-spruce leading-relaxed">{summary}</p> : null}
      <ExtraLines payload={payload} shown={shown} />
    </>
  );
}

function detailBody(actionType: string, payload: Record<string, unknown>): React.ReactNode {
  switch (actionType) {
    case 'reply_to_email':
    case 'send_email':
      return <EmailBody payload={payload} />;
    case 'create_calendar_event':
    case 'update_calendar_event':
      return <CalendarBody payload={payload} />;
    case 'place_supply_order':
    case 'cancel_supply_order':
      return <SupplyBody payload={payload} />;
    case 'add_to_routine':
    case 'share_photos_with_family':
    case 'add_to_digest_only':
      return <ActivityBody payload={payload} />;
    default:
      return <ExtraLines payload={payload} shown={new Set()} />;
  }
}

export function DraftDetail({
  actionType,
  payload,
}: {
  actionType: string;
  payload: Record<string, unknown> | null;
}) {
  if (!payload) return null;

  const sourceUrl = str(payload, 'source_url');
  const coverageNote = str(payload, 'coverage_note');
  const hasHonesty = Boolean(sourceUrl || coverageNote);

  return (
    <div className="mt-3">
      {hasHonesty ? (
        <div className="flex flex-col gap-1.5 mb-3">
          {coverageNote ? <CoverageNote note={coverageNote} /> : null}
          {sourceUrl ? <SourceLink url={sourceUrl} /> : null}
        </div>
      ) : null}

      <details className="group">
        <summary className="meta text-slate-green cursor-pointer inline-flex items-center gap-1.5 select-none">
          <span>view what Hale drafted</span>
        </summary>
        <div
          className="mt-3 flex flex-col gap-3 bg-oat p-4"
          style={{ borderRadius: 'var(--r-lg)' }}
        >
          {detailBody(actionType, payload)}
        </div>
      </details>
    </div>
  );
}
