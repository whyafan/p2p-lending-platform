import type { NextConfig } from 'next';
import path from 'path';

const emptyModule = path.join(__dirname, 'lib/wagmi-empty-module.js');

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
    resolveAlias: {
      porto: emptyModule,
      '@gemini-wallet/core': emptyModule,
    },
  },
};

export default nextConfig;
