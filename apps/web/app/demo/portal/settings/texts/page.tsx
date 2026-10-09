import { PortalHeading } from '~/components/portal/heading';
import { TextsEditor } from '~/components/portal/texts-editor';
import { DEFAULT_LOOP_PREFS } from '~/lib/loop/prefs';
import { DEMO_BASE, demoBasics } from '~/lib/portal/demo-fixture';

export default function DemoTextsPage() {
  return (
    <>
      <PortalHeading
        back
        basePath={DEMO_BASE}
        title="Texts from Hale"
        lede="What Hale texts you, and when."
      />
      <TextsEditor
        prefs={DEFAULT_LOOP_PREFS}
        childFirstName={demoBasics.children[0]?.name ?? null}
      />
    </>
  );
}
