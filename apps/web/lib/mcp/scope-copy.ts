import type { McpScope } from './contracts';

export const MCP_SCOPE_COPY: Record<McpScope, { label: string; detail: string }> = {
  'week_plan.read': {
    label: 'Week plan',
    detail: 'Read the current Hale week plan and its already-redacted items.',
  },
  'events.read': {
    label: 'Upcoming events',
    detail: 'Read live calendar items. Teen and sensitive details stay private.',
  },
  'village.read': {
    label: 'Village picks',
    detail: 'Read current local recommendations. Teen picks remain category-only.',
  },
  'actions.propose': {
    label: 'Propose actions',
    detail: 'Create drafts for your approval. The assistant can never execute them.',
  },
};
