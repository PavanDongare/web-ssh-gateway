import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow serving .wasm files and importing from node_modules that use WASM
  webpack(config) {
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };
    return config;
  },
  // Turbopack config (Next.js 16+ default bundler) — silence the webpack/turbopack mismatch error
  // and enable WASM support for ghostty-web
  turbopack: {
    rules: {
      "*.wasm": {
        loaders: [],
        as: "*.wasm",
      },
    },
  },
};

export default nextConfig;
