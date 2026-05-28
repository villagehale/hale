import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  transpilePackages: ['@haru/db', '@haru/types'],
  serverExternalPackages: ['postgres', 'pg-boss'],
};

export default config;
