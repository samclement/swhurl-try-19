// The events helper (src/events.ts) without a NATS server: the platform's naming, the envelope,
// and that an app off the platform publishes and receives nothing instead of failing.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  consumerOf, declaredPublishes, declaredSubscriptions, envelope, eventsEnabled, publish, streamOf, subjectOf, subscribe,
} from "../dist/events.js";

// SWHURL_EVENTS_FILE: this file tests the helper alone, not the events this app describes (asyncapi.yaml).
Object.assign(process.env, { SWHURL_APP: "notifier", SWHURL_ENV: "staging", SWHURL_EVENTS_FILE: "none.yaml" });

test("names follow the platform's: environment first, then the publishing app", () => {
  assert.equal(subjectOf("orders", "created"), "staging.orders.created");
  assert.equal(streamOf("orders"), "staging-orders");
  assert.equal(consumerOf("created"), "notifier_created");
});

test("an event is a CloudEvents envelope from this app", () => {
  const event = envelope("sent", { to: "sam" });
  assert.deepEqual({ ...event, id: "", time: "" }, {
    specversion: "1.0", id: "", source: "notifier", type: "notifier.sent", time: "",
    datacontenttype: "application/json", data: { to: "sam" },
  });
  assert.match(event.id, /^[0-9a-f-]{36}$/);
  assert.ok(!Number.isNaN(Date.parse(event.time)));
});

test("declarations come from the platform's variables", () => {
  assert.deepEqual([declaredPublishes(), declaredSubscriptions()], [[], []]);
  process.env.SWHURL_EVENTS_PUBLISH = "sent,failed";
  process.env.SWHURL_EVENTS_SUBSCRIBE = "orders.created";
  assert.deepEqual([declaredPublishes(), declaredSubscriptions()], [["sent", "failed"], ["orders.created"]]);
});

test("off the platform nothing is published or received, and nothing fails", async () => {
  assert.equal(eventsEnabled(), false);
  assert.equal(await publish("sent", {}), null);
  const stop = subscribe("orders.created", () => assert.fail("no event can arrive"));
  await stop();
  assert.throws(() => subscribe("created", () => {}), /subscribe to "<app>.<event>"/);
});
