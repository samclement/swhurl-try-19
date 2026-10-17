// Starts the built app (npm run build first) and checks the endpoint the platform probes.
// Uses only Node's built-in test runner and fetch, so it adds no dependencies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 18000 + Math.floor(Math.random() * 1000);

test("GET /healthz returns 200", async (t) => {
  const env = { ...process.env, PORT: String(port), DATABASE_PATH: join(mkdtempSync(join(tmpdir(), "app-")), "app.db") };
  const server = spawn(process.execPath, ["dist/main.js"], { env, stdio: "ignore" });
  t.after(() => server.kill());
  let response;
  for (let attempt = 0; attempt < 50 && !response; attempt++) {
    response = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined);
    if (!response) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(response, "server did not answer within 5 seconds");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
