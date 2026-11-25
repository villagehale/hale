import { type ReactElement, type ReactNode, createElement, isValidElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/font/local', () => ({ default: () => ({ variable: 'font-var' }) }));

const OLD_ID = '1111111111111111';
const NEW_ID = '2222222222222222';

function pixelsIn(node: ReactNode, MetaPixel: unknown): ReactElement<{ pixelId: string }>[] {
  if (Array.isArray(node)) return node.flatMap((n) => pixelsIn(n, MetaPixel));
  if (!isValidElement(node)) return [];
  const own = node.type === MetaPixel ? [node as ReactElement<{ pixelId: string }>] : [];
  return [...own, ...pixelsIn((node.props as { children?: ReactNode }).children, MetaPixel)];
}

async function layoutPixels(): Promise<ReactElement<{ pixelId: string }>[]> {
  const { default: RootLayout } = await import('./layout');
  const { MetaPixel } = await import('~/components/meta-pixel');
  return pixelsIn(RootLayout({ children: createElement('main') }), MetaPixel);
}

describe('root layout Meta pixel gate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('mounts no pixel while the conversions flags are off, even with ids set', async () => {
    vi.stubEnv('NEXT_PUBLIC_META_PIXEL_ID', `${OLD_ID},${NEW_ID}`);
    vi.stubEnv('CONVERSIONS_API_ENABLED', '');
    vi.stubEnv('NEXT_PUBLIC_CONVERSIONS_API_ENABLED', '');
    expect(await layoutPixels()).toEqual([]);
  });

  it('mounts one pixel island with both ids when the conversions flag is exact true', async () => {
    vi.stubEnv('NEXT_PUBLIC_META_PIXEL_ID', `${OLD_ID},${NEW_ID}`);
    vi.stubEnv('CONVERSIONS_API_ENABLED', 'true');
    const pixels = await layoutPixels();
    expect(pixels.map((p) => p.props.pixelId)).toEqual([`${OLD_ID},${NEW_ID}`]);
  });
});
