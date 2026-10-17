// Events between apps on the swhurl platform's NATS JetStream.
// https://github.com/samclement/swhurl-platform/blob/main/docs/apps.md#events
//
// What it publishes is declared in swhurl.yaml (events: {publish: [created]}) or asyncapi.yaml; what it
// receives is granted on the platform (Connect to an app, or make app-events). The platform then gives
// this app an address, a key and permission for exactly those events:
//
//   await publish("created", { id: 42 });                    // other apps see <this app>.created
//   subscribe("orders.created", async (event) => { ... });         // throw to get it again
//
// An app that describes its events in asyncapi.yaml (the template's "events" feature) may publish
// only those, each with a payload that fits its schema: publish() throws EventInvalid otherwise,
// on the platform and off it. The file is what other apps read to find and subscribe to them.
//
// An event travels as a CloudEvents JSON envelope with the trace context in its headers, so the
// subscriber's work joins the publisher's trace. Off the platform (local development, tests) there
// is no SWHURL_EVENTS_URL: publish() does nothing and returns null, subscribe() never calls back.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { ValidateFunction } from "ajv";
import { SpanKind, SpanStatusCode, context, propagation, trace } from "@opentelemetry/api";
import type { JetStreamClient, MsgHdrs, NatsConnection } from "nats";

export type CloudEvent<T = unknown> = {
  specversion: "1.0";
  id: string;
  source: string;
  type: string;
  time: string;
  datacontenttype: "application/json";
  data: T;
};

export type Handler = (event: CloudEvent) => Promise<void> | void;

const app = (): string => process.env.SWHURL_APP ?? "app";
const environment = (): string => process.env.SWHURL_ENV ?? "local";
const list = (value: string | undefined): string[] => (value ?? "").split(",").filter(Boolean);

/** The events this app declared it publishes, and the `<app>.<event>` pairs it declared it receives. */
export const declaredPublishes = (): string[] => list(process.env.SWHURL_EVENTS_PUBLISH);
export const declaredSubscriptions = (): string[] => list(process.env.SWHURL_EVENTS_SUBSCRIBE);

/** Whether the platform connected this app to NATS. */
export const eventsEnabled = (): boolean => Boolean(process.env.SWHURL_EVENTS_URL && process.env.SWHURL_EVENTS_SEED);

// The platform's naming: staging and production share one NATS and are kept apart by name.
export const subjectOf = (publisher: string, event: string): string => `${environment()}.${publisher}.${event}`;
export const streamOf = (publisher: string): string => `${environment()}-${publisher}`;
export const consumerOf = (event: string): string => `${app()}_${event}`;

export function envelope<T>(event: string, data: T): CloudEvent<T> {
  return {
    specversion: "1.0",
    id: randomUUID(),
    source: app(),
    type: `${app()}.${event}`,
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    data,
  };
}

let connecting: Promise<{ nats: typeof import("nats"); connection: NatsConnection; jetstream: JetStreamClient }> | undefined;

/** The app's NATS connection, opened on first use: events and feature flag overrides share it. */
export function connected(): NonNullable<typeof connecting> {
  connecting ??= (async () => {
    // Loaded on first use (an event, or watching flag overrides).
    const nats = await import("nats");
    const connection = await nats.connect({
      servers: process.env.SWHURL_EVENTS_URL,
      name: `${app()}-${environment()}`,
      // The app's own key: the server knows the public half, the seed is this app's Secret.
      authenticator: nats.nkeyAuthenticator(new TextEncoder().encode(process.env.SWHURL_EVENTS_SEED)),
      // Replies come back under this app's own prefix; it may read no other.
      inboxPrefix: `_INBOX.${environment()}.${app()}`,
      maxReconnectAttempts: -1,
    });
    return { nats, connection, jetstream: connection.jetstream() };
  })();
  // A failed attempt is not kept: the next publish or the subscriber's next try connects again.
  connecting.catch(() => {
    connecting = undefined;
  });
  return connecting;
}

/** An event that asyncapi.yaml does not describe, or a payload that does not fit its schema. */
export class EventInvalid extends Error {}

type Described = Map<string, ValidateFunction | null>; // event name -> its payload check (null: any payload)
const contracts = new Map<string, Promise<Described | null>>();

/**
 * The events asyncapi.yaml says this app sends, each with a check for its payload; null when the
 * app has no such file (nothing is checked). Read once. A channel's address is the event's name;
 * with an `operations` section, only channels an operation sends to count.
 */
export function describedEvents(file = process.env.SWHURL_EVENTS_FILE ?? "asyncapi.yaml"): Promise<Described | null> {
  let reading = contracts.get(file);
  if (!reading) {
    reading = readDescribed(file);
    contracts.set(file, reading);
  }
  return reading;
}

async function readDescribed(file: string): Promise<Described | null> {
  if (!existsSync(file)) return null;
  // Loaded only by an app that describes its events, so the others pay nothing at start-up.
  const [{ Ajv }, { parse }] = await Promise.all([import("ajv"), import("yaml")]);
  const doc = parse(readFileSync(file, "utf8")) as Record<string, any>;
  const ajv = new Ajv({ strict: false, allErrors: true });
  ajv.addSchema(doc, "asyncapi");
  const at = (pointer: string): any => pointer.slice(2).split("/").reduce((node, key) => node?.[key], doc);
  // Follow one local reference ("#/components/..."): where the thing itself is written.
  const settle = (pointer: string): string => at(pointer)?.$ref ?? pointer;
  const operations = Object.values((doc.operations ?? {}) as Record<string, any>);
  const sends = new Set(operations.filter((o) => o.action === "send").map((o) => o.channel?.$ref));
  const described: Described = new Map();
  for (const [key, channel] of Object.entries((doc.channels ?? {}) as Record<string, any>)) {
    if (operations.length && !sends.has(`#/channels/${key}`)) continue;
    const [message] = Object.keys(channel.messages ?? {});
    const payload = message ? settle(`${settle(`#/channels/${key}/messages/${message}`)}/payload`) : "";
    described.set(channel.address ?? key, payload && at(payload) ? ajv.compile({ $ref: `asyncapi${payload}` }) : null);
  }
  return described;
}

async function checkDescribed(event: string, data: unknown): Promise<void> {
  const described = await describedEvents();
  if (!described) return;
  if (!described.has(event)) {
    throw new EventInvalid(`"${event}" is not an event asyncapi.yaml describes (${[...described.keys()].join(", ") || "none"})`);
  }
  const fits = described.get(event);
  // As it will travel: what JSON drops (undefined, functions) is not there for the subscriber either.
  if (fits && !fits(JSON.parse(JSON.stringify(data ?? null)))) {
    const problems = (fits.errors ?? []).map((e) => `${e.instancePath || "payload"} ${e.message}`).join("; ");
    throw new EventInvalid(`"${event}" does not fit its schema in asyncapi.yaml: ${problems}`);
  }
}

const tracer = () => trace.getTracer("swhurl-events");

/** Publish one of this app's events. Resolves once NATS has stored it; null off the platform. */
export async function publish<T>(event: string, data: T): Promise<CloudEvent<T> | null> {
  await checkDescribed(event, data);
  if (!eventsEnabled()) return null;
  const { nats, jetstream } = await connected();
  const subject = subjectOf(app(), event);
  return tracer().startActiveSpan(`publish ${app()}.${event}`, { kind: SpanKind.PRODUCER }, async (span) => {
    try {
      span.setAttributes({ "messaging.system": "nats", "messaging.destination.name": subject });
      const message = envelope(event, data);
      const headers = nats.headers();
      propagation.inject(context.active(), headers, { set: (carrier, key, value) => carrier.set(key, value) });
      await jetstream.publish(subject, JSON.stringify(message), { headers, msgID: message.id });
      return message;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Receive a declared event, "<app>.<event>", one at a time, from where this app last stopped.
 * The handler's work is a span in the publisher's trace. If it throws, the event comes back after
 * a few seconds (five tries in all). Returns at once with a function that stops receiving.
 *
 * It keeps trying until it is receiving: a new app can start before NATS has loaded its user or
 * the platform has created its consumer. onProblem hears each failed try (to log it).
 */
export function subscribe(name: string, handler: Handler, onProblem?: (error: unknown) => void): () => Promise<void> {
  const [publisher, event] = name.split(".");
  if (!publisher || !event) throw new Error(`subscribe to "<app>.<event>", not "${name}"`);
  if (!eventsEnabled()) return async () => {};
  let stopped = false;
  let close: (() => Promise<unknown>) | undefined;
  void (async () => {
    while (!stopped) {
      try {
        const { jetstream } = await connected();
        // The platform created this consumer from the declaration; an undeclared one does not exist.
        const consumer = await jetstream.consumers.get(streamOf(publisher), consumerOf(event));
        const messages = await consumer.consume({ max_messages: 1 });
        close = () => messages.close();
        for await (const message of messages) {
          const parent = propagation.extract(context.active(), message.headers, {
            get: (carrier: MsgHdrs | undefined, key) => carrier?.get(key) || undefined,
            keys: (carrier: MsgHdrs | undefined) => carrier?.keys() ?? [],
          });
          await tracer().startActiveSpan(`process ${name}`, { kind: SpanKind.CONSUMER }, parent, async (span) => {
            span.setAttributes({ "messaging.system": "nats", "messaging.destination.name": message.subject });
            try {
              await handler(message.json<CloudEvent>());
              message.ack();
            } catch (error) {
              span.recordException(error as Error);
              span.setStatus({ code: SpanStatusCode.ERROR });
              message.nak(5_000);
            } finally {
              span.end();
            }
          });
        }
      } catch (error) {
        onProblem?.(error);
      }
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  })();
  return async () => {
    stopped = true;
    await close?.();
  };
}

/** Finish what is in flight and leave NATS (on SIGTERM). */
export async function closeEvents(): Promise<void> {
  if (!connecting) return;
  const { connection } = await connecting;
  await connection.drain();
}
