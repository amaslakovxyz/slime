import { registerOTel } from '@vercel/otel';

// Exports over OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT (Jaeger locally).
export function register() {
  registerOTel({ serviceName: 'slime-admin' });
}
