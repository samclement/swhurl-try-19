// The platform helpers (src/platform.ts): who may call this app, and how it calls others.
// Tokens here are signed with a key made for the test, as the cluster signs real ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import http from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Unauthorized, identify, notify, requireApp, secret, service } from "../dist/platform.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ISSUER = "https://kubernetes.default.svc.cluster.local";
Object.assign(process.env, {
  SWHURL_APP: "orders",
  SWHURL_ENV: "staging",
  SWHURL_AUTH_ISSUER: ISSUER,
  SWHURL_AUTH_KEYS: JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" }] }),
  SWHURL_ALLOWED_CALLERS: "reports,billing",
});

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token(claims = {}, { kid = "k1", key = privateKey } = {}) {
  const body = `${encode({ alg: "RS256", kid })}.${encode({
    iss: ISSUER,
    aud: ["orders"],
    exp: Math.floor(Date.now() / 1000) + 600,
    sub: "system:serviceaccount:reports-staging:reports",
    ...claims,
  })}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), key).toString("base64url")}`;
}
const bearer = (value) => ({ authorization: `Bearer ${value}` });

test("an allowed app with a token for this app is identified", () => {
  assert.deepEqual(identify(bearer(token())), { type: "app", id: "reports" });
  assert.equal(requireApp(identify(bearer(token()))), "reports");
});

test("a request without a token is a signed-in person or anonymous", () => {
  assert.deepEqual(identify({ "x-auth-request-email": "sam@example.com" }), { type: "user", id: "sam@example.com" });
  assert.deepEqual(identify({}), { type: "anonymous", id: null });
  assert.throws(() => requireApp(identify({})), Unauthorized);
});

test("every other token is refused", () => {
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const cases = {
    "another audience": token({ aud: ["inventory"] }),
    "another issuer": token({ iss: "https://elsewhere" }),
    expired: token({ exp: Math.floor(Date.now() / 1000) - 1 }),
    "an app that is not allowed": token({ sub: "system:serviceaccount:stranger-staging:stranger" }),
    "another environment": token({ sub: "system:serviceaccount:reports-prod:reports" }),
    "another service account in the caller's namespace": token({ sub: "system:serviceaccount:reports-staging:default" }),
    "an unknown key": token({}, { kid: "k2" }),
    "a forged signature": token({}, { key: other }),
    "a changed payload": token().replace(/\.[^.]+\./, `.${encode({ iss: ISSUER, aud: ["orders"], sub: "x" })}.`),
    garbage: "not-a-token",
  };
  for (const [name, value] of Object.entries(cases)) {
    assert.throws(() => identify(bearer(value)), Unauthorized, name);
  }
});

test("without the platform's keys a token cannot be accepted", () => {
  const keys = process.env.SWHURL_AUTH_KEYS;
  delete process.env.SWHURL_AUTH_KEYS;
  try {
    assert.throws(() => identify(bearer(token())), /not configured to verify tokens/);
    assert.deepEqual(identify({}), { type: "anonymous", id: null }, "people are unaffected");
  } finally {
    process.env.SWHURL_AUTH_KEYS = keys;
  }
});

test("service() sends this app's token for the callee to its address", async (t) => {
  const seen = [];
  const callee = http.createServer((request, response) => {
    seen.push({ path: request.url, authorization: request.headers.authorization });
    response.end("{}");
  });
  await new Promise((resolve) => callee.listen(0, "127.0.0.1", resolve));
  t.after(() => callee.close());
  const tokens = mkdtempSync(join(tmpdir(), "tokens-"));
  mkdirSync(join(tokens, "orders-api"));
  writeFileSync(join(tokens, "orders-api", "token"), "first\n");
  process.env.SWHURL_TOKENS_DIR = tokens;
  process.env.SWHURL_SERVICE_ORDERS_API_URL = `http://127.0.0.1:${callee.address().port}`;

  await service("orders-api").fetch("/stock/42");
  writeFileSync(join(tokens, "orders-api", "token"), "second\n"); // the platform replaces the file
  await service("orders-api").fetch("/stock/43");
  assert.deepEqual(seen, [
    { path: "/stock/42", authorization: "Bearer first" },
    { path: "/stock/43", authorization: "Bearer second" },
  ]);
  assert.throws(() => service("inventory"), /SWHURL_SERVICE_INVENTORY_URL is not set: grant the call/);
});

test("notify() posts the message with this app's token for the notify service and never throws", async (t) => {
  const seen = [];
  let status = 202;
  const notifyService = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({ path: request.url, method: request.method, authorization: request.headers.authorization, body: JSON.parse(body) });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(status === 202 ? { channels: ["payments"] } : { error: "try again later" }));
    });
  });
  await new Promise((resolve) => notifyService.listen(0, "127.0.0.1", resolve));
  t.after(() => notifyService.close());
  const warnings = [];
  t.mock.method(console, "warn", (line) => warnings.push(JSON.parse(line)));
  const tokens = mkdtempSync(join(tmpdir(), "tokens-"));
  mkdirSync(join(tokens, "notify"));
  writeFileSync(join(tokens, "notify", "token"), "for-notify\n");
  process.env.SWHURL_TOKENS_DIR = tokens;

  delete process.env.SWHURL_NOTIFY_URL;
  assert.equal(await notify("Order backlog"), false, "outside the platform nothing is sent");
  assert.deepEqual([seen, warnings], [[], []]);

  process.env.SWHURL_NOTIFY_URL = `http://127.0.0.1:${notifyService.address().port}`;
  assert.equal(await notify("Order backlog", { message: "412 waiting", priority: "high", key: "backlog-1" }), true);
  assert.deepEqual(seen, [{
    path: "/v1/notify",
    method: "POST",
    authorization: "Bearer for-notify",
    body: { title: "Order backlog", message: "412 waiting", priority: "high", key: "backlog-1" },
  }]);

  status = 429;
  assert.equal(await notify("Order backlog"), false);
  assert.equal(warnings[0].msg, "notification not sent: the notify service answered 429: try again later");

  process.env.SWHURL_NOTIFY_URL = "http://127.0.0.1:1";
  assert.equal(await notify("Order backlog"), false, "an unreachable service is a warning, not an exception");
  assert.equal(warnings.length, 2);
});

test("secret() returns a value, and names the command for a missing one", () => {
  process.env.EXAMPLE_TOKEN = "t0ken";
  assert.equal(secret("EXAMPLE_TOKEN"), "t0ken");
  delete process.env.EXAMPLE_TOKEN;
  assert.throws(() => secret("EXAMPLE_TOKEN"), /secret EXAMPLE_TOKEN has no value: set it on the platform \(make app-secret APP=orders ENV=\w+ NAME=EXAMPLE_TOKEN\)/);
});
