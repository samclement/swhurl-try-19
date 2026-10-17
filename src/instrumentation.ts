// Loaded before the app with `node --import ./dist/instrumentation.js` (NODE_OPTIONS in the Dockerfile).
// This app is an ES module, so OpenTelemetry needs its loader hook registered before any import
// (node:http included) for auto-instrumentation to patch it; the SDK's own register script only
// covers CommonJS. Where to send telemetry comes from OTEL_* variables the platform injects.
import { register } from "node:module";

register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
await import("@opentelemetry/auto-instrumentations-node/register");
