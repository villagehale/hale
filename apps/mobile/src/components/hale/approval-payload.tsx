import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Tag } from '@/components/ui/tag';
import type { ApprovalView } from '@/lib/api-types';

/**
 * The teen-redaction notice for an action's payload, shared by the Approvals list
 * card and the approval detail page. Only the teen-redacted case (payload === null)
 * renders a block: a normal action is already summarized by its human `preview`, and
 * dumping raw JSON.stringify(payload) would re-expose the content the design
 * deliberately hides (rule #1). So a null payload is a NOTICE, never rendered fields.
 */
export function ApprovalPayloadBlock({ action }: { action: ApprovalView }) {
  if (action.payload !== null) return null;
  return (
    <View className="gap-1.5 rounded-md border border-rule bg-canvas p-3">
      <Tag label="Redacted · teen privacy" tone="attention" />
      <AppText variant="meta" className="mt-1">
        Raw content is hidden by default. Your teen can grant time-limited access if you ask.
      </AppText>
    </View>
  );
}
