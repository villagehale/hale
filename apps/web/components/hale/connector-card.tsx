import type { ToolCard } from '@hale/agent';
import { Calendar, ExternalLink, FileText, MapPin } from 'lucide-react';
import {
  driveFileKind,
  formatAgendaRow,
  formatModified,
  notConnectedCopy,
} from '~/lib/coach/connector-card';

/**
 * The honest connector cards Ask Hale renders inside an assistant turn when a
 * drive_search / calendar_lookup tool ran: Drive file rows (type · name · modified ·
 * open link) and a compact Calendar agenda (day · time · title). A not-connected
 * result renders the calm Settings affordance, never an error box.
 *
 * Rule #1: the card reads ONLY the whitelisted fields the tool streamed
 * (name/mimeType/modifiedTime/webViewLink; title/start/end/location) — there is no
 * file content, attendee, or token in the payload it was handed. `data-hale-pii`
 * marks the parent's own file/event text so the telemetry mask keeps it out of logs.
 */
export function ConnectorCard({ card }: { card: ToolCard }) {
  if (card.kind === 'not_connected') {
    const { service, line } = notConnectedCopy(card.provider);
    return (
      <section className="panel-oat mb-3 px-4 py-3">
        <p className="eyebrow text-spruce">{service}</p>
        <p className="meta mt-1">{line}</p>
        <a href="/settings" className="link mt-2 inline-block text-[0.85rem]">
          Connect in Settings
        </a>
      </section>
    );
  }

  if (card.kind === 'drive') {
    if (card.files.length === 0) {
      return (
        <section className="panel-oat mb-3 px-4 py-3">
          <p className="eyebrow text-spruce">Google Drive</p>
          <p className="meta mt-1">No matching files.</p>
        </section>
      );
    }
    return (
      <section className="panel-oat mb-3 px-4 py-3">
        <p className="eyebrow text-spruce">Google Drive</p>
        <ul className="mt-2 space-y-2">
          {card.files.map((file) => (
            <li key={file.webViewLink} className="flex items-center gap-3">
              <FileText aria-hidden size={18} className="shrink-0 text-slate-green" />
              <span className="min-w-0 flex-1">
                <a
                  href={file.webViewLink}
                  target="_blank"
                  rel="noreferrer"
                  className="link block truncate text-[0.95rem]"
                  data-hale-pii
                >
                  {file.name}
                </a>
                <span className="meta">
                  {driveFileKind(file.mimeType)}
                  {formatModified(file.modifiedTime) ? ` · ${formatModified(file.modifiedTime)}` : ''}
                </span>
              </span>
              <a
                href={file.webViewLink}
                target="_blank"
                rel="noreferrer"
                // A generic label — the file name is the primary link above; an
                // aria-label embedding it would leak PII into the DOM a replay
                // captures, outside the data-hale-pii mask (rule #1).
                aria-label="Open in Google Drive"
                className="shrink-0 text-slate-green hover:text-spruce"
              >
                <ExternalLink aria-hidden size={16} />
              </a>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  // calendar
  if (card.events.length === 0) {
    return (
      <section className="panel-oat mb-3 px-4 py-3">
        <p className="eyebrow text-spruce">Next 7 days</p>
        <p className="meta mt-1">Nothing on the calendar.</p>
      </section>
    );
  }
  return (
    <section className="panel-oat mb-3 px-4 py-3">
      <p className="eyebrow text-spruce">Next 7 days</p>
      <ul className="mt-2 space-y-2">
        {card.events.map((event, i) => {
          const { day, time } = formatAgendaRow(event.start, event.end);
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: the agenda is an ordered, append-only list from one tool result
              key={i}
              className="flex items-baseline gap-3"
            >
              <Calendar aria-hidden size={16} className="shrink-0 translate-y-0.5 text-slate-green" />
              <span className="min-w-0 flex-1">
                <span className="block text-[0.95rem]" data-hale-pii>
                  {event.title}
                </span>
                <span className="meta">
                  {day}
                  {time ? ` · ${time}` : ''}
                  {event.location ? (
                    <>
                      {' · '}
                      <MapPin aria-hidden size={12} className="inline translate-y-[1px]" />{' '}
                      <span data-hale-pii>{event.location}</span>
                    </>
                  ) : null}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
