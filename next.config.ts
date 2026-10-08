import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingExcludes: {
    "/*": ["./.env", "./.env.*", "./data/**/*", "./test-results/**/*"],
  },
  poweredByHeader: false,
  // Accept the loopback Origin observed through Codespaces only in development.
  experimental:
    process.env.NODE_ENV === "development" && process.env.CODESPACES === "true"
      ? { serverActions: { allowedOrigins: ["localhost:3000"] } }
      : undefined,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Cache-Control", value: "private, no-store" }
        ]
      }
    ];
  }
};

export default nextConfig;
