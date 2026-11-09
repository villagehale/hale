import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /trail offers the family export only to a seat the export route serves (exportSeat):
 * the download is the family's whole record, so a caregiver is not offered it.
 */

const listSeatsMock = vi.fn<() => Promise<Array<{ familyId: string; role: string }>>>();

vi.mock('~/lib/dashboard/queries', () => ({
  loadTrail: async () => [],
  loadViewerSeats: () => listSeatsMock(),
}));

async function renderPage(): Promise<string> {
  const { default: TrailPage } = await import('./page');
  return renderToStaticMarkup(await TrailPage());
}

const EXPORT_BUTTON = '>download a copy</button>';

describe('/trail export', () => {
  beforeEach(() => {
    vi.resetModules();
    listSeatsMock.mockReset();
  });

  it('offers a parent the export (the positive control)', async () => {
    listSeatsMock.mockResolvedValue([{ familyId: 'family-a', role: 'primary_parent' }]);
    expect(await renderPage()).toContain(EXPORT_BUTTON);
  });

  it('offers a caregiver no export', async () => {
    listSeatsMock.mockResolvedValue([{ familyId: 'family-a', role: 'nanny' }]);
    const html = await renderPage();
    expect(html).not.toContain(EXPORT_BUTTON);
    expect(html).toContain('end of trail');
  });
});
