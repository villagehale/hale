import { Caveat_Brush, DM_Mono, Inter } from 'next/font/google';

/** One Caveat Brush load, shared by the hero and the Black Friday sticker. */
export const heroBrush = Caveat_Brush({
  weight: '400',
  subsets: ['latin'],
  display: 'swap',
});

/** Price, clock digits, the See prices pill, and the close mark. */
export const bfInter = Inter({
  weight: ['300', '500', '600'],
  subsets: ['latin'],
  display: 'swap',
});

/** Clock unit labels. */
export const bfMono = DM_Mono({
  weight: '400',
  subsets: ['latin'],
  display: 'swap',
});
