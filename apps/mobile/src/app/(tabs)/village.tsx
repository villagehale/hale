import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { Screen } from '@/components/ui/screen';
import { PLACEHOLDER } from '@/constants/placeholder-data';

export default function VillageScreen() {
  const { village } = PLACEHOLDER;
  return (
    <Screen scroll className="gap-5">
      <AppText variant="display" className="pt-2">
        Village
      </AppText>
      <Card className="gap-1">
        <AppText variant="title">{village.title}</AppText>
        <AppText variant="mono" className="text-ink-3">
          {village.meta}
        </AppText>
        <AppText variant="body" className="mt-1">
          {village.blurb}
        </AppText>
      </Card>
    </Screen>
  );
}
