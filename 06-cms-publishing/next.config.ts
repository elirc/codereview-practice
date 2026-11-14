import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // Revision bodies may be up to 200,000 characters.
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default nextConfig;
