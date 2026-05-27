import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    typedRoutes: true,
  },
  transpilePackages: ['@mira/db', '@mira/types'],
  serverExternalPackages: ['postgres', 'pg-boss'],
};

export default config;
