// The app's routes. src/server.ts listens with them.
import { OpenAPIHono } from "@hono/zod-openapi";
import { trace } from "@opentelemetry/api";
import pino from "pino";
import { declaredPublishes, publish } from "./events.js";
import { flagsLoaded } from "./flags.js";
import { type Caller, Unauthorized, identify, notify, service } from "./platform.js";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
});

const serviceName = process.env.OTEL_SERVICE_NAME ?? "swhurl-app";

export const app = new OpenAPIHono<{ Variables: { caller: Caller } }>();
const traceId = (): string | null => trace.getActiveSpan()?.spanContext().traceId ?? null;

app.onError((error, c) => {
  logger.error({ err: error, path: c.req.path }, "request failed");
  return c.json({ error: "internal error" }, 500);
});

// What the platform probes: no caller check, no log line. Not ready until the app's feature flag
// overrides have arrived (at most 5 s; src/flagstore.ts).
app.get("/healthz", (c) => {
  if (!flagsLoaded()) return c.json({ ok: false, waiting: "feature flag overrides" }, 503);
  return c.json({ ok: true });
});

// Who is calling: another app (it sent a token the platform issued for this app alone), a
// signed-in person, or anonymous. A bad token is refused here; see src/platform.ts.
app.use(async (c, next) => {
  const start = Date.now();
  let caller: Caller;
  try {
    caller = identify(Object.fromEntries(c.req.raw.headers));
  } catch (error) {
    if (!(error instanceof Unauthorized)) throw error;
    logger.warn({ method: c.req.method, path: c.req.path, status: 401, reason: error.message, trace_id: traceId() },
      "request refused");
    return c.json({ error: error.message }, 401);
  }
  c.set("caller", caller);
  const span = trace.getActiveSpan();
  span?.setAttribute("caller.type", caller.type);
  if (caller.id) span?.setAttribute("caller.id", caller.id);
  await next();
  logger.info({
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration_ms: Date.now() - start,
    "caller.type": caller.type,
    "caller.id": caller.id,
    trace_id: traceId(),
  }, "request handled");
});

// An example of calling another app: GET /call/orders asks the app "orders" for its "/" and
// returns what it said. It works once the platform grants this app the call (make app-calls).
app.get("/call/:name", async (c) => {
  const name = c.req.param("name");
  try {
    const reply = await service(name).fetch("/");
    return c.json({ called: name, status: reply.status, reply: await reply.json().catch(() => null) }, reply.ok ? 200 : 502);
  } catch (error) {
    return c.json({ called: name, error: (error as Error).message }, 502);
  }
});

// An example of notifying the team: POST /notify sends a message to the notification channel of
// the team that owns this app, and says whether the platform accepted it.
app.post("/notify", async (c) => {
  const caller = c.get("caller");
  const sent = await notify("Hello from the example route", { message: `Asked for by ${caller.id ?? "an anonymous caller"}.` });
  return c.json({ sent });
});

// The example route: says hello, names the caller and publishes an event.
async function hello(caller: Caller) {
  // An example of publishing: the first event this app declares (events.publish in swhurl.yaml)
  // goes out on every request. Off the platform, or with nothing declared, nothing happens.
  const [published] = declaredPublishes();
  let eventId: string | null = null;
  if (published) {
    try {
      eventId = (await publish(published, { path: "/", caller }))?.id ?? null;
    } catch (error) {
      logger.error({ err: error, event: published, trace_id: traceId() }, "event not published");
    }
  }
  const message = `hello from ${serviceName}`;
  return {
    message,
    service: serviceName,
    caller,
    event: eventId ? { type: `${serviceName}.${published}`, id: eventId } : null,
    traceId: traceId(),
  };
}

app.get("/", async (c) => c.json(await hello(c.get("caller"))));

app.notFound((c) => c.json({ error: "not found" }, 404));
