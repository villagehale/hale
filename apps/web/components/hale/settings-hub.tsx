'use client';

import { useEffect, useState } from 'react';
import {
  resolveSection,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from '~/components/hale/settings-sections';

/**
 * The Settings hub shell (design handoff §4.7): a 216px left sub-nav that switches
 * between the six sections, replacing the old seven-anchor scroll page. The section
 * bodies are rendered on the server and handed in by id, so each keeps its real
 * data + server actions; this client shell only owns which one is shown.
 *
 * Deep links survive: on mount we resolve the URL hash (old #billing, #privacy, …)
 * to its new section, and switching updates the hash (replaceState — shareable,
 * no scroll jump). Every section is rendered and toggled with `hidden` rather than
 * unmounted, so client state (an open plan CTA, a half-typed child) is kept when a
 * parent flips between sections.
 */
export function SettingsHub({
  sections,
}: {
  sections: Record<SettingsSectionId, React.ReactNode>;
}) {
  const [active, setActive] = useState<SettingsSectionId>('account');

  useEffect(() => {
    setActive(resolveSection(window.location.hash));
    const onHashChange = () => setActive(resolveSection(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  function go(id: SettingsSectionId) {
    setActive(id);
    history.replaceState(null, '', `#${id}`);
  }

  return (
    <div className="settings-hub rise rise-2">
      <nav className="settings-subnav" aria-label="Settings sections">
        {SETTINGS_SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            className="settings-subnav-item"
            aria-current={active === section.id ? 'page' : undefined}
            onClick={() => go(section.id)}
          >
            {section.label}
          </button>
        ))}
      </nav>

      <div className="settings-panel">
        {SETTINGS_SECTIONS.map((section) => (
          <section
            key={section.id}
            id={section.id}
            aria-label={section.label}
            hidden={active !== section.id}
          >
            {sections[section.id]}
          </section>
        ))}
      </div>
    </div>
  );
}
