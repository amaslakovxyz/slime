import { SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';

// Span attributes carry ids, providers and counts only: never emails, tokens or DB URLs.
export function withSpan<T>(name: string, attrs: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return trace.getTracer('slime-admin').startActiveSpan(name, async (span) => {
    span.setAttributes(attrs);
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err instanceof Error ? err : String(err));
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}
