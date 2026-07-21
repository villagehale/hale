import { useState } from 'react';
import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ApiError } from '@/lib/api-client';
import type { MobileTextChannelResponse } from '@/lib/api-types';
import { revokeTextChannel } from '@/lib/family-api';
import { useApi } from '@/lib/use-api';

/**
 * Settings → "Text notifications" (VIL-212), the native mirror of the web SMS
 * channel. Reads its own endpoint so the status is honest and refreshes independently.
 * Until the CPaaS number is provisioned (`senderConfigured` false) it shows the honest
 * "arrives when texting launches" state — never a dead enrolment form (rule #1). The
 * number is only ever shown MASKED. Enrolment (number + OTP) is the web flow for v1;
 * this screen reads state and can turn the channel off.
 */
export function TextNotificationsSection() {
  const channel = useApi<MobileTextChannelResponse>('/api/mobile/settings/text-notifications');

  if (channel.status === 'error') {
    // A transient read must not silently drop the section (a vanished section reads
    // as "no such feature"): keep the heading + a retry.
    return (
      <View className="gap-2">
        <AppText variant="eyebrow">Text notifications</AppText>
        <Card className="gap-3">
          <AppText variant="meta" className="text-ink-3">
            Couldn&rsquo;t load your text settings.
          </AppText>
          <Button label="Try again" variant="secondary" onPress={channel.reload} />
        </Card>
      </View>
    );
  }

  if (channel.status !== 'ready' || !channel.data) return null;

  return (
    <View className="gap-2">
      <AppText variant="eyebrow">Text notifications</AppText>
      <TextChannelCard data={channel.data} onChanged={channel.reload} />
    </View>
  );
}

function TextChannelCard({
  data,
  onChanged,
}: {
  data: MobileTextChannelResponse;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function turnOff() {
    setBusy(true);
    setError(null);
    try {
      await revokeTextChannel();
      await onChanged();
    } catch (e) {
      setError(
        e instanceof ApiError && e.message === 'preview'
          ? "Sign-in isn't configured in this preview, so nothing was saved."
          : "Couldn't turn that off just now — please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (data.enrolled && data.maskedPhone) {
    return (
      <Card className="gap-3">
        <View className="flex-row items-center justify-between gap-4">
          <View className="flex-1">
            <AppText variant="body" className="text-ink">
              {data.maskedPhone}
            </AppText>
            <AppText variant="meta">Verified · your week arrives by text</AppText>
          </View>
          <Button label="Turn off" variant="secondary" onPress={turnOff} disabled={busy} />
        </View>
        {error ? (
          <AppText variant="meta" className="text-accent" accessibilityRole="alert">
            {error}
          </AppText>
        ) : null}
      </Card>
    );
  }

  if (!data.senderConfigured) {
    return (
      <Card className="gap-1">
        <AppText variant="body" className="text-ink">
          Get your week by text
        </AppText>
        <AppText variant="meta">
          Soon you&rsquo;ll be able to add your number and get your family&rsquo;s weekly plan and
          reminders as a text. We&rsquo;ll invite you to set it up when texting launches.
        </AppText>
      </Card>
    );
  }

  // Sender live but not enrolled: enrolment (number + code) is the web flow for v1.
  return (
    <Card className="gap-1">
      <AppText variant="body" className="text-ink">
        Get your week by text
      </AppText>
      <AppText variant="meta">
        Add and verify your number from Hale on the web to start getting your family&rsquo;s week as
        a text.
      </AppText>
    </Card>
  );
}
