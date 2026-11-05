import type { NextConfig } from "next";

// The browser only ever talks to this Next.js origin; /api/* is proxied to the FastAPI service, so
// cookies stay first-party and no secret reaches the client. On Render the API is reached over the
// private network (LASTCALL_API_HOSTPORT = "lastcall-api:10000"); locally it's LASTCALL_API_URL.
const apiOrigin = process.env.LASTCALL_API_HOSTPORT
  ? `http://${process.env.LASTCALL_API_HOSTPORT}`
  : (process.env.LASTCALL_API_URL ?? "http://127.0.0.1:8787");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
