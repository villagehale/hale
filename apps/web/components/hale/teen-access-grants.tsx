import type { TeenAccessGrantSummary, TeenAccessScope } from '~/lib/teen-access';
import { TeenAccessRevokeForm } from './teen-access-revoke-form';

/** Parent-facing names for the closed scope vocabulary. Never the enum value. */
const SCOPE_LABEL: Record<TeenAccessScope, string> = {
  message_content: 'messages and posts',
  calendar_detail: 'calendar details',
  child_profile: 'profile details',
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(value),
  );
}

/**
 * The state line for one request, worded so a parent can never mistake "asked" for
 * "granted". Order matters: revoked and expired both beat assented, because a grant
 * that has closed is not an open one however it got there.
 */
function stateLine(grant: TeenAccessGrantSummary): string {
  if (grant.revoked) return 'closed';
  if (grant.active) {
    return grant.expiresAt ? `open until ${formatDate(grant.expiresAt)}` : 'open';
  }
  if (grant.assented) return 'expired — it closed on its own';
  return 'waiting on your teen';
}

/**
 * Settings → Family & children → teen privacy. Shows every raw-access request this
 * parent has made and its true state, computed by the same predicate the reads use,
 * so this list can never claim access the app would not actually give.
 *
 * The notification line is deliberately blunt. Hale has no way to contact a teen
 * today — children have no account and no contact details on file — so a request
 * records an obligation Hale still owes rather than a delivery it made. Saying so
 * is the whole point of this feature: the alternative is a privacy control that
 * quietly does less than it claims.
 */
export function TeenAccessGrants({
  grants,
  childNames,
}: {
  grants: TeenAccessGrantSummary[];
  childNames: Record<string, string>;
}) {
  return (
    <div className="flex flex-col gap-y-5">
      <p className="max-w-md text-spruce leading-relaxed">
        For a child 13 or older, Hale keeps raw content — the actual words of a message or post —
        private from you by default. You can ask to see it. By design, your teen is told what you
        asked for and why, and only they can open it; access is limited to what you asked for,
        lasts at most seven days, and every step is on your record.
      </p>
      <p className="max-w-md text-spruce leading-relaxed">
        <strong>Nothing can be opened yet.</strong> Hale has no way to reach a teen — they
        have no account and we hold no contact details for them — and telling them is a condition
        of opening anything. So a request is recorded and stays pending, and the default privacy
        above keeps applying. We&rsquo;d rather leave this closed than open your teen&rsquo;s words
        without them knowing.
      </p>

      {grants.length === 0 ? (
        <div className="panel-oat px-6 py-5">
          <p className="font-medium text-spruce">No access requests</p>
          <p className="meta mt-1 leading-relaxed">
            When a teen&rsquo;s content is held back, the row itself offers to ask — so you never
            decide about something you can&rsquo;t see.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-rule border-y border-rule">
          {grants.map((grant) => (
            <li
              key={grant.id}
              className="flex flex-col gap-4 py-5 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <p className="font-medium text-spruce" data-hale-pii>
                    {childNames[grant.childId] ?? 'your teen'}
                  </p>
                  <span className="meta text-faded-sage">{SCOPE_LABEL[grant.scope]}</span>
                </div>
                <p className="meta mt-2">
                  asked {formatDate(grant.requestedAt)} · {stateLine(grant)}
                </p>
                <p className="meta mt-1 leading-relaxed" data-hale-pii>
                  your reason: &ldquo;{grant.reason}&rdquo;
                </p>
                {grant.safetyEscalation ? (
                  <p className="meta mt-1 text-berry leading-relaxed">
                    opened as a safety escalation — without your teen&rsquo;s agreement, for 24
                    hours, and they were told.
                  </p>
                ) : null}
                {grant.teenNotified ? null : (
                  <p className="meta mt-1 leading-relaxed">
                    Hale has no way to reach your teen yet, so it hasn&rsquo;t been able to tell
                    them. This is recorded as still owed, and nothing opens in the meantime.
                  </p>
                )}
              </div>

              {grant.revoked ? null : <TeenAccessRevokeForm grantId={grant.id} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
