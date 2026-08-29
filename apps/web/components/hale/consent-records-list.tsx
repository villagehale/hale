import type { ViewerConsentRecord } from '~/lib/consent-records';

/**
 * Settings → Trust → consent records: the viewer's own append-only ledger, in
 * parent-facing words. Only what the loader hands over is rendered — the loader
 * structurally strips evidence/ip/user-agent, so this list cannot leak a captured
 * artifact even by mistake. "not granted" is deliberately neutral: a granted=false
 * row can be a decline, a withdrawal, or a still-pending request (teen access), and
 * this raw view must not claim more than the boolean says.
 */

const TYPE_LABEL: Record<string, string> = {
  terms_of_service: 'Terms of service',
  privacy_policy: 'Privacy policy',
  cross_border_data: 'Cross-border data',
  llm_processing: 'AI processing',
  integration_specific: 'A connected integration',
  autonomous_action_class: 'Letting Hale act on its own',
  teen_content_access: 'Seeing a teen’s content',
  sms_service_messages: 'Texts from Hale',
  mcp_third_party_model: 'A connected assistant',
  proactive_watch: 'Hale keeping watch',
  caregiver_access_grant: 'Caregiver access',
  caregiver_scoped_messages: 'Caregiver texts',
  co_parent_access_grant: 'Co-parent access',
  village_intro: 'Village introductions',
};

function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? type.replaceAll('_', ' ');
}

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeZone: 'UTC' }).format(value);
}

export function ConsentRecordsList({ records }: { records: ViewerConsentRecord[] }) {
  if (records.length === 0) {
    return (
      <p className="meta leading-relaxed">
        Nothing on the ledger yet — a row appears each time you say yes (or no) to something.
      </p>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-rule border-y border-rule">
      {records.map((record) => (
        <li key={record.id} className="py-3">
          <p className="font-medium text-spruce">
            {typeLabel(record.consentType)}
            <span className="meta ml-2">{record.granted ? 'granted' : 'not granted'}</span>
          </p>
          <p className="meta mt-0.5">
            {[
              record.consentScope,
              record.grantedAt ? formatDate(record.grantedAt) : null,
              record.revokedAt ? `revoked ${formatDate(record.revokedAt)}` : null,
              record.policyVersion,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </li>
      ))}
    </ul>
  );
}
