// What the swhurl platform gives this app: who is calling it, and how to call the apps it declared.
// https://github.com/samclement/swhurl-platform/blob/main/docs/apps.md#calling-another-app
//
// Being called: identify(request.headers) says whether the caller is another app (it sent a
// service-account token the platform issued for this app alone), a signed-in person, or anonymous.
// Calling: service("orders").fetch("/path") needs a call to orders granted on the platform (the app
// page's Connect to an app, or make app-calls); the platform then sets SWHURL_SERVICE_ORDERS_URL and mounts a token only orders accepts.
// Notifying: notify("Order backlog") sends a message to the channel of the team that owns this app.
// Nothing is declared: every app is given the notify service's address and a token for it.
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";

export type Caller =
  | { type: "app"; id: string }
  | { type: "user"; id: string }
  | { type: "anonymous"; id: null };

/** The request carried a token this app does not accept: answer 401 with the message. */
export class Unauthorized extends Error {}

type Jwk = { kid?: string; kty: string; [field: string]: unknown };

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

function appCaller(token: string): Caller {
  const { SWHURL_APP: app, SWHURL_ENV: env, SWHURL_AUTH_ISSUER: issuer, SWHURL_AUTH_KEYS: keys } = process.env;
  if (!app || !env || !issuer || !keys) {
    // Outside the platform (local development) there are no keys to check a token against.
    throw new Unauthorized("this app is not configured to verify tokens (SWHURL_AUTH_KEYS is not set)");
  }
  const [head, payload, signature] = token.split(".");
  if (!head || !payload || !signature) throw new Unauthorized("malformed token");
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decode(head);
    claims = decode(payload);
  } catch {
    throw new Unauthorized("malformed token");
  }
  const jwk = (JSON.parse(keys) as { keys: Jwk[] }).keys.find((key) => key.kid === header.kid);
  if (!jwk || header.alg !== "RS256") throw new Unauthorized("token signed by an unknown key");
  const valid = verifySignature(
    "RSA-SHA256",
    Buffer.from(`${head}.${payload}`),
    createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(signature, "base64url"),
  );
  if (!valid) throw new Unauthorized("bad token signature");
  if (claims.iss !== issuer) throw new Unauthorized("token from another issuer");
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(app)) throw new Unauthorized("token is for another app");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) throw new Unauthorized("token expired");
  // The caller is the service account <caller> in the namespace <caller>-<this environment>.
  const match = /^system:serviceaccount:([a-z0-9-]+):([a-z0-9-]+)$/.exec(String(claims.sub));
  const caller = match?.[2];
  if (!caller || match[1] !== `${caller}-${env}`) throw new Unauthorized("token is not from an app in this environment");
  const allowed = (process.env.SWHURL_ALLOWED_CALLERS ?? "").split(",").filter(Boolean);
  if (!allowed.includes(caller)) throw new Unauthorized(`${caller} is not allowed to call ${app}`);
  return { type: "app", id: caller };
}

/**
 * Who sent this request. A request with a bearer token must carry a good one (Unauthorized
 * otherwise). Without a token it is a person: signed in when the platform's sign-in put their
 * email on the request, anonymous otherwise.
 */
export function identify(headers: IncomingHttpHeaders): Caller {
  const authorization = headers.authorization;
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
    return appCaller(authorization.slice(7).trim());
  }
  const email = headers["x-auth-request-email"];
  return typeof email === "string" && email ? { type: "user", id: email } : { type: "anonymous", id: null };
}

/** For a route only other apps may use: the calling app's name, or Unauthorized. */
export function requireApp(caller: Caller): string {
  if (caller.type !== "app") throw new Unauthorized("this route is for apps that declare a call to this one");
  return caller.id;
}

/**
 * A secret this app reads: list its name in swhurl.yaml's secrets, and set its value on the platform. A name
 * listed without a value deploys all the same, so the code that needs it fails here, saying how to set it.
 */
export function secret(name: string): string {
  const value = process.env[name];
  if (!value) {
    const where = `APP=${process.env.SWHURL_APP ?? "<app>"} ENV=${process.env.SWHURL_ENV ?? "<env>"}`;
    throw new Error(`secret ${name} has no value: set it on the platform (make app-secret ${where} NAME=${name}) and list it in swhurl.yaml's secrets`);
  }
  return value;
}

/**
 * Another app this one has been granted a call to (Connect to an app, or make app-calls). fetch() sends the request to
 * the same environment's instance with this app's token for it; trace headers are added by the
 * OpenTelemetry instrumentation, so the callee's spans join this request's trace.
 */
export function service(name: string): { url: string; fetch(path: string, init?: RequestInit): Promise<Response> } {
  const variable = `SWHURL_SERVICE_${name.toUpperCase().replaceAll("-", "_")}_URL`;
  const url = process.env[variable];
  if (!url) {
    throw new Error(`${variable} is not set: grant the call on the platform (the app page's Connect to an app, or make app-calls ARGS="--add ${name}")`);
  }
  // The platform replaces the token file every few minutes, so read it for each call. Locally
  // there is none: point the variable at a stub that does not check tokens.
  const tokenFile = `${process.env.SWHURL_TOKENS_DIR ?? "/var/run/swhurl/tokens"}/${name}/token`;
  return {
    url,
    fetch(path: string, init: RequestInit = {}): Promise<Response> {
      const headers = new Headers(init.headers);
      if (existsSync(tokenFile)) headers.set("authorization", `Bearer ${readFileSync(tokenFile, "utf8").trim()}`);
      return fetch(new URL(path, url), { signal: AbortSignal.timeout(10_000), ...init, headers });
    },
  };
}

export type Notification = { message?: string; priority?: "normal" | "high"; click?: string; key?: string };

/**
 * Send a message to the notification channel of the team that owns this app
 * (https://github.com/samclement/swhurl-platform/blob/main/docs/apps.md#notifications). It arrives
 * titled "<app>/<env>: <title>": the platform takes who sent it from this app's token. `key` makes a
 * repeat harmless (the same key is delivered once); `click` is an https link opened from the message.
 *
 * Resolves to whether the platform accepted it, and never throws: a notification must not break the
 * work that sent it. It is not accepted when the app has sent 30 in the last hour, and outside the
 * platform (SWHURL_NOTIFY_URL is not set) nothing is sent. A team without a channel accepts and
 * delivers nothing.
 */
export async function notify(title: string, options: Notification = {}): Promise<boolean> {
  const url = process.env.SWHURL_NOTIFY_URL;
  if (!url) return false;
  const refused = (reason: string): boolean => {
    console.warn(JSON.stringify({ level: "warn", msg: `notification not sent: ${reason}`, title }));
    return false;
  };
  // The platform replaces the token file every few minutes, so read it for each call.
  const tokenFile = `${process.env.SWHURL_TOKENS_DIR ?? "/var/run/swhurl/tokens"}/notify/token`;
  try {
    const headers = new Headers({ "content-type": "application/json" });
    if (existsSync(tokenFile)) headers.set("authorization", `Bearer ${readFileSync(tokenFile, "utf8").trim()}`);
    const reply = await fetch(new URL("/v1/notify", url), {
      method: "POST",
      headers,
      body: JSON.stringify({ title, ...options }),
      signal: AbortSignal.timeout(5_000),
    });
    if (reply.status === 202) return true;
    const answer = (await reply.json().catch(() => null)) as { error?: string } | null;
    return refused(`the notify service answered ${reply.status}${answer?.error ? `: ${answer.error}` : ""}`);
  } catch (error) {
    return refused((error as Error).message);
  }
}
