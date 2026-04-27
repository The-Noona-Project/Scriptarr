/**
 * @file Next.js configuration for Moon's Once UI-powered admin application.
 */

/** @type {import("next").NextConfig} */
const nextConfig = {
  basePath: "/admin",
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
