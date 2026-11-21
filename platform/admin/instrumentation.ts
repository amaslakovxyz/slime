import { registerOTel } from '@vercel/otel';

// Exports over OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT (Jaeger locally). Without
// an endpoint (the hosted admin) nothing is registered, so spans cost nothing and
// no exporter retries against a collector that is not there.
export function register() {
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) registerOTel({ serviceName: 'slime-admin' });
}
