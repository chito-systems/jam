// One way to make a span, used by every handler and worker step.
// Only the OpenTelemetry API is imported here; it is a no-op until the SDK is
// bootstrapped by the platform stream, so this is safe in tests and local dev.
import { type Attributes, type Span, SpanStatusCode, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("hack-harness");

/** Runs `fn` inside a span. Records the error and marks the span failed if it throws, then rethrows. */
export function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}
