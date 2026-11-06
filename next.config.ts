import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { REFERENCE_URL } from "./lib/api-docs/links";

const root = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Pinned so a lockfile in a parent folder can't move the workspace root.
  turbopack: { root },
  outputFileTracingRoot: root,
  serverExternalPackages: ["postgres", "ioredis"],
  // Hides the dev route indicator.
  devIndicators: false,

  // CLAUDE.md is ours. Next appends its own copy of the agent-rules block on every dev start.
  agentRules: false,

  // The public API is `/v1/*`; the handlers live under the `/api/v1` route class.
  async rewrites() {
    return [{ source: "/v1/:path*", destination: "/api/v1/:path*" }];
  },

  async redirects() {
    return [{ source: "/reference", destination: REFERENCE_URL, permanent: false }];
  },
};

export default nextConfig;
