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
};

export default nextConfig;
