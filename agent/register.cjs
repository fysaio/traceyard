// Loaded before the application's own modules. Only operational spans are exported.
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { envDetector } = require("@opentelemetry/resources");
const sdk = new NodeSDK({
  autoDetectResources: true,
  resourceDetectors: [envDetector],
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [
    getNodeAutoInstrumentations({ "@opentelemetry/instrumentation-fs": { enabled: false } }),
  ],
});
try {
  sdk.start();
  // Short test processes must flush their actual spans before exiting naturally.
  process.once("beforeExit", () =>
    sdk.shutdown().catch(() => console.warn("Traceyard telemetry could not be flushed.")),
  );
} catch {
  console.warn("Traceyard recording could not start; application execution continues.");
}
