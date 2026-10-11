import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

import pkg from "./package.json";
import { sourceRefFor } from "./src/lib/docs-link";
import { ALLOWED_HOSTS_ENV, serverActionOrigins } from "./src/lib/security/host-allowlist";

/** The upstream repository, from package.json (a fork changes `repository.url` there so users of the fork reach its source). */
const sourceUrl = pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * Sent with every response: the dashboard may not be framed by another page (click-jacking), the browser may not guess
 * content types, and URLs of the dashboard never travel to other sites in a Referer. No script CSP: Next's inline
 * bootstrap scripts would need nonces.
 */
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker `web` image (.next/standalone/server.js).
  output: "standalone",
  // No "X-Powered-By: Next.js": the dashboard does not advertise its framework.
  poweredByHeader: false,
  // `next build` type-checks the app only (tsconfig.build.json): the Docker build context has no e2e/ or tests/, which
  // the root tsconfig.json (used by `pnpm typecheck` and the editor) also covers.
  typescript: { tsconfigPath: "tsconfig.build.json" },
  // Inlined at build time, so client components get the URL and the release tag of this version without bundling the whole
  // package.json (src/lib/docs-link.ts): the guide links open the docs of the version that runs, not of `main`.
  env: { NEXT_PUBLIC_SOURCE_URL: sourceUrl, NEXT_PUBLIC_SOURCE_REF: sourceRefFor(pkg.version) },
  experimental: {
    serverActions: {
      // Origins accepted in addition to the request's own host (src/proxy.ts refuses foreign hosts before this check).
      // Read when the config is loaded: by `next start` at start-up, but at build time for the standalone Docker image.
      allowedOrigins: serverActionOrigins(process.env[ALLOWED_HOSTS_ENV]),
    },
  },
  headers() {
    return Promise.resolve([{ source: "/:path*", headers: SECURITY_HEADERS }]);
  },
};

export default withNextIntl(nextConfig);
