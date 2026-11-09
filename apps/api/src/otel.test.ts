import { context, metrics, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { AggregationTemporality, DataPointType, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { type IngestJob, MemoryStore, type RawDoc } from "@hh/shared";
import { createInlineDispatcher } from "@hh/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTelemetry } from "./otel";

const spans = new InMemorySpanExporter();
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60_000 });
const tracerProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spans })] });
const meterProvider = new MeterProvider({ readers: [reader] });

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(tracerProvider);
  metrics.setGlobalMeterProvider(meterProvider);
});
afterAll(() => {
  trace.disable();
  metrics.disable();
  context.disable();
});

const job = (capture_id: string): IngestJob => ({
  capture_id,
  team_id: "t1",
  who: "cam",
  type: "text",
  at: "2026-11-09T19:00:00.000Z",
  received_at: new Date().toISOString(),
  text: `capture ${capture_id}`,
});

describe("telemetry", () => {
  it("is off without an OTLP endpoint", () => {
    expect(startTelemetry({})).toBeUndefined();
  });

  it("hangs a queued capture's pipeline off the span that dispatched it, and records the SLO", async () => {
    const store = new MemoryStore();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const indexRaw = store.indexRaw.bind(store);
    let calls = 0;
    // Hold the first two captures in the index step so the third waits in the queue (2 run at once).
    store.indexRaw = async (docs: RawDoc[]) => {
      if (++calls <= 2) await gate;
      return indexRaw(docs);
    };
    const dispatcher = createInlineDispatcher({ store });
    const done = new Promise<void>((resolve) => {
      dispatcher.subscribe("t1", (e) => {
        if (e.event === "capture" && e.data.capture_id === "c3" && e.data.state === "indexed") resolve();
      });
    });

    const tracer = trace.getTracer("test");
    const parents: Record<string, string> = {};
    for (const id of ["c1", "c2", "c3"]) {
      await tracer.startActiveSpan(`api POST /api/ingest ${id}`, async (span) => {
        parents[id] = span.spanContext().spanId;
        await dispatcher.dispatch(job(id));
        span.end(); // the request finishes long before the queued pipeline runs
      });
    }
    expect(await dispatcher.status("c3")).toMatchObject({ state: "queued" });
    release();
    await done;

    const finished = spans.getFinishedSpans();
    const pipeline = finished.find((s) => s.name === "ingest.pipeline" && s.attributes.capture_id === "c3");
    const request = finished.find((s) => s.name === "api POST /api/ingest c3");
    expect(pipeline?.parentSpanContext?.spanId).toBe(parents.c3);
    expect(pipeline?.spanContext().traceId).toBe(request?.spanContext().traceId);
    const index = finished.find((s) => s.name === "ingest.index" && s.attributes.capture_id === "c3");
    expect(index?.parentSpanContext?.spanId).toBe(pipeline?.spanContext().spanId);

    await reader.forceFlush();
    const exported = metricExporter.getMetrics().flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics));
    const slo = exported.find((x) => x.descriptor.name === "jam.capture.time_to_searchable");
    expect(slo?.descriptor.unit).toBe("ms");
    expect(slo?.dataPointType).toBe(DataPointType.HISTOGRAM);
    const total = exported.find((x) => x.descriptor.name === "jam.capture.total");
    expect(total?.dataPoints[0]).toMatchObject({ attributes: { state: "indexed", type: "text" }, value: 3 });
  });
});
