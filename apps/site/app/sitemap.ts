import type { MetadataRoute } from 'next';
import { SITE_URL } from '~/lib/app-url';

// Static marketing routes. Add new public pages here as they ship.
export default function sitemap(): MetadataRoute.Sitemap {
  const paths = ['', '/about', '/contact'];
  const lastModified = new Date();
  return paths.map((path) => ({
    url: `${SITE_URL}${path}`,
    lastModified,
    changeFrequency: 'monthly',
    priority: path === '' ? 1 : 0.7,
  }));
}
