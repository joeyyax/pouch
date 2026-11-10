import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createMDX } from "fumadocs-mdx/next";

const root = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const config = {
  output: "export",
  basePath: "/docs",
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  turbopack: { root },
  devIndicators: false,
  agentRules: false,
};

export default createMDX()(config);
