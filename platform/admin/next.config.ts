import type { NextConfig } from 'next';

// Built for the slime-admin Lambda by scripts/build-lambda.mjs; plain `next dev`
// and `next build` work with the same file.
const config: NextConfig = {
  // A self-contained server.js plus traced node_modules: the Lambda zip (Web Adapter runs it).
  output: 'standalone',
  // The admin is not part of the root npm workspace; tracing from the repo root would
  // nest server.js under platform/admin/ in the standalone output.
  outputFileTracingRoot: import.meta.dirname,
  // lambda/start.mjs imports the SSM client before server.js loads; kept out of the server
  // bundles, it is traced into the standalone node_modules where start.mjs finds it.
  serverExternalPackages: ['@aws-sdk/client-ssm'],
  experimental: {
    serverActions: {
      // CloudFront forwards the Function URL host as Host while the browser sends
      // Origin: https://admin.amaslakov.com; Next refuses a server action whose origin
      // matches neither, so the public host is allowed explicitly.
      allowedOrigins: [process.env.ADMIN_ORIGIN || 'admin.amaslakov.com'],
    },
  },
  // build-lambda.mjs sets the hash of the admin's inputs, so the build id changes only
  // with them; without it (local builds) Next generates a random one.
  generateBuildId: async () => process.env.ADMIN_SOURCE_HASH || null,
};

export default config;
