import { serve } from "@hono/node-server";
import { trace } from "@opentelemetry/api";
import { app, logger } from "./app.js";
import { closeEvents, declaredSubscriptions, subscribe } from "./events.js";
import { watchFlags } from "./flags.js";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const serviceName = process.env.OTEL_SERVICE_NAME ?? "swhurl-app";

const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  logger.info({ port, service: serviceName }, "server listening");
});

// Feature flag overrides set from the console (src/flagstore.ts): /healthz waits for the stored ones.
watchFlags({
  onChange: (flag, value) => logger.info({ flag, value: value ?? null }, value === undefined ? "flag override cleared" : "flag override set"),
  onProblem: (error) => logger.warn({ err: error }, "flag overrides"),
});

// An example of receiving: log every event this app declared it subscribes to (events.subscribe).
for (const name of declaredSubscriptions()) {
  subscribe(name, (event) => {
    logger.info({ event_type: event.type, event_id: event.id, source: event.source,
      trace_id: trace.getActiveSpan()?.spanContext().traceId ?? null }, "event received");
  }, (error) => logger.warn({ err: error, subscription: name }, "not receiving yet; trying again"));
}

// Kubernetes sends SIGTERM before stopping the pod: finish open requests, then exit.
process.on("SIGTERM", () => {
  server.close(() => {
    void closeEvents().finally(() => process.exit(0));
  });
});
