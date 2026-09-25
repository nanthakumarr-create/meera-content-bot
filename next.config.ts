import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // voice-skill.txt is read from disk at runtime; make sure Vercel bundles it
  // with the serverless functions that draft posts.
  outputFileTracingIncludes: {
    "/api/telegram/webhook": ["./voice-skill.txt"],
    "/api/health": ["./voice-skill.txt"],
  },
  serverExternalPackages: ["@google/genai"],
};

export default nextConfig;
