import { router } from 'expo-router';
import { Linking, Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { useMeadowColor } from '@/constants/meadow';
import type { ToolCard } from '@/lib/coach-api';
import {
  driveFileKind,
  formatAgendaRow,
  formatModified,
  notConnectedCopy,
} from '@/lib/connector-card';

/**
 * The honest connector cards Hale renders under a settled turn when a drive_search /
 * calendar_lookup tool ran: Drive file rows (type · name · modified, tap to open in
 * the browser) and a compact Calendar agenda (title · day · time). A not-connected
 * result routes to Settings, never an error box. Mirrors the web ConnectorCard.
 *
 * Rule #1: the card reads ONLY the whitelisted fields the tool streamed
 * (name/mimeType/modifiedTime/webViewLink; title/start/end/location) — no file
 * content, attendee, or token is in the payload it was handed.
 */
export function ConnectorCard({ card }: { card: ToolCard }) {
  if (card.kind === 'not_connected') return <NotConnectedCard provider={card.provider} />;
  if (card.kind === 'drive') return <DriveCard files={card.files} />;
  return <CalendarCard events={card.events} />;
}

function NotConnectedCard({ provider }: { provider: 'gdrive' | 'gcal' }) {
  const { service, line } = notConnectedCopy(provider);
  return (
    <View className="mb-3 max-w-[92%] self-start">
      <Card className="gap-1.5">
        <AppText variant="eyebrow">
          {service}
        </AppText>
        <AppText variant="body" className="text-ink-2">
          {line}
        </AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Connect in Settings"
          onPress={() => router.push('/more/settings')}
          className="active:opacity-80"
        >
          <AppText variant="meta" className="text-accent underline">
            Connect in Settings
          </AppText>
        </Pressable>
      </Card>
    </View>
  );
}

function DriveCard({ files }: { files: Extract<ToolCard, { kind: 'drive' }>['files'] }) {
  const iconColor = useMeadowColor('ink3');
  return (
    <View className="mb-3 max-w-[92%] self-start">
      <Card className="gap-2">
        <AppText variant="eyebrow">
          Google Drive
        </AppText>
        {files.length === 0 ? (
          <AppText variant="body" className="text-ink-2">
            No matching files.
          </AppText>
        ) : (
          files.map((file) => {
            const modified = formatModified(file.modifiedTime);
            return (
              <Pressable
                key={file.webViewLink}
                accessibilityRole="link"
                accessibilityLabel="Open file in your browser"
                onPress={() => {
                  Linking.openURL(file.webViewLink).catch(() => {
                    // A failed open is a no-op — the row is a directory link.
                  });
                }}
                className="flex-row items-center gap-3 active:opacity-80"
              >
                <Icon name="file-text" size={18} color={iconColor} />
                <View className="flex-1">
                  <AppText variant="body" numberOfLines={1}>
                    {file.name}
                  </AppText>
                  <AppText variant="meta" className="text-ink-3">
                    {driveFileKind(file.mimeType)}
                    {modified ? ` · ${modified}` : ''}
                  </AppText>
                </View>
                <Icon name="square-arrow-out-up-right" size={16} color={iconColor} />
              </Pressable>
            );
          })
        )}
      </Card>
    </View>
  );
}

function CalendarCard({ events }: { events: Extract<ToolCard, { kind: 'calendar' }>['events'] }) {
  const iconColor = useMeadowColor('ink3');
  return (
    <View className="mb-3 max-w-[92%] self-start">
      <Card className="gap-2">
        <AppText variant="eyebrow">
          Next 7 days
        </AppText>
        {events.length === 0 ? (
          <AppText variant="body" className="text-ink-2">
            Nothing on the calendar.
          </AppText>
        ) : (
          events.map((event, i) => {
            const { day, time } = formatAgendaRow(event.start, event.end);
            return (
              <View
                // biome-ignore lint/suspicious/noArrayIndexKey: the agenda is an ordered, append-only list from one tool result
                key={i}
                className="flex-row items-start gap-3"
              >
                <Icon name="calendar" size={16} color={iconColor} />
                <View className="flex-1">
                  <AppText variant="body">{event.title}</AppText>
                  <AppText variant="meta" className="text-ink-3">
                    {day}
                    {time ? ` · ${time}` : ''}
                    {event.location ? ` · ${event.location}` : ''}
                  </AppText>
                </View>
              </View>
            );
          })
        )}
      </Card>
    </View>
  );
}
