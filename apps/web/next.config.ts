import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  transpilePackages: ['@hearth/db', '@hearth/types', '@hearth/tools-contracts'],
  serverExternalPackages: ['postgres', 'pg-boss'],
  webpack: (config) => {
    // Workspace packages use ESM '.js' import specifiers against .ts sources;
    // webpack needs the alias tsc applies implicitly.
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default config;
