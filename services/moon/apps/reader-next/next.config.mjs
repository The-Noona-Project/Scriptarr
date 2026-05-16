/**
 * @file Next.js configuration for Moon's dedicated reader application.
 */

/** @type {import("next").NextConfig} */
const nextConfig = {
  basePath: "/reader",
  reactStrictMode: false,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "cdn.discordapp.com"
      }
    ]
  }
};

export default nextConfig;
