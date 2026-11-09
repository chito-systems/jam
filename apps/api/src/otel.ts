// OpenTelemetry SDK bootstrap. Loaded with `node --import` before main.ts so the
// global providers exist before any module asks for a tracer or meter.
// Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set; exporters read the standard
// OTEL_EXPORTER_OTLP_* env vars themselves (endpoint + /v1/{traces,metrics,logs}, headers).
import { format } from "node:util";
import { context, metrics, trace } from "@opentelemetry/api";
import { type Logger, logs, SeverityNumber } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

type Env = Record<string, string | undefined>;
type ConsoleLevel = "error" | "warn" | "info" | "log";

const SEVERITY: Record<ConsoleLevel, [SeverityNumber, string]> = {
  error: [SeverityNumber.ERROR, "ERROR"],
  warn: [SeverityNumber.WARN, "WARN"],
  info: [SeverityNumber.INFO, "INFO"],
  log: [SeverityNumber.INFO, "INFO"],
};

/** Every console call still prints; it is also emitted as a LogRecord tied to the active span. */
export function bridgeConsole(logger: Logger): void {
  let emitting = false; // an exporter that logs while we emit must not recurse
  for (const level of Object.keys(SEVERITY) as ConsoleLevel[]) {
    const original = console[level].bind(console);
    const [severityNumber, severityText] = SEVERITY[level];
    console[level] = (...args: unknown[]) => {
      original(...args);
      if (emitting) return;
      emitting = true;
      try {
        const error = args.find((a): a is Error => a instanceof Error);
        logger.emit({
          severityNumber,
          severityText,
          body: format(...args),
          context: context.active(),
          attributes: {
            "log.source": "console",
            ...(error ? { "exception.type": error.name, "exception.message": error.message } : {}),
          },
        });
      } finally {
        emitting = false;
      }
    };
  }
}

/** Registers tracing, metrics and logs. Returns a flush-and-shutdown function, or undefined when off. */
export function startTelemetry(env: Env): (() => Promise<void>) | undefined {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    console.log("telemetry off (OTEL_EXPORTER_OTLP_ENDPOINT not set)");
    return undefined;
  }
  const serviceName = env.OTEL_SERVICE_NAME || "hack-harness-api";
  const resource = resourceFromAttributes({
    "service.name": serviceName,
    "service.version": env.APP_VERSION || "dev",
    "deployment.environment.name": env.NODE_ENV || "development",
  });

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })],
  });
  trace.setGlobalTracerProvider(tracerProvider);

  const meterProvider = new MeterProvider({
    resource,
    // 10 s so the time-to-searchable SLO moves on a dashboard during a demo.
    readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 10_000 })],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
  });
  logs.setGlobalLoggerProvider(loggerProvider);
  bridgeConsole(loggerProvider.getLogger("console"));

  // Outbound fetch/undici (OpenAI, Elasticsearch, GitHub) as child spans. Works in ESM via diagnostics_channel.
  registerInstrumentations({ instrumentations: [new UndiciInstrumentation()] });

  console.log(`telemetry on: ${serviceName} → ${env.OTEL_EXPORTER_OTLP_ENDPOINT} (traces, metrics, logs)`);
  return async () => {
    await Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown(), loggerProvider.shutdown()]);
  };
}

const shutdown = startTelemetry(process.env);

if (shutdown) {
  // Flush, then re-raise so the default handler still exits the process the way it would have.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      const giveUp = new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref());
      void Promise.race([shutdown(), giveUp]).finally(() => process.kill(process.pid, signal));
    });
  }
}
