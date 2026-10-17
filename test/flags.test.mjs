// Feature flags: the generator (scripts/flags.mjs) refuses what the platform refuses and writes one
// typed accessor per flag; the store (src/flagstore.ts) picks the value for this environment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generate, problem } from "../scripts/flags.mjs";
import { flagStore } from "../dist/flagstore.js";

const declared = {
  "new-checkout": { type: "boolean", description: "Use the new checkout */ flow", default: false, staging: true },
  "max-basket-items": { type: "integer", min: 1, max: 100, default: 20, prod: 10 },
  "discount-rate": { type: "number", max: 0.5, default: 0, staging: 0.25 },
  banner: { type: "string", enum: ["none", "sale"], default: "none" },
};

test("each flag gets a typed accessor named in camel case", () => {
  const source = generate({ flags: declared });
  assert.match(source, /get newCheckout\(\): boolean \{ return store\.value\("new-checkout"\) as boolean; \}/);
  assert.match(source, /get maxBasketItems\(\): number/);
  assert.match(source, /get discountRate\(\): number/);
  assert.match(source, /get banner\(\): string/);
  assert.match(source, /\/\*\* Use the new checkout \*\\\/ flow \*\//);
  assert.match(generate({}), /export const flags = \{\n\};/);
});

test("the value is the one declared for this environment, otherwise the default", () => {
  const value = (env, name) => flagStore(declared, env).value(name);
  assert.equal(value("staging", "new-checkout"), true);
  assert.equal(value("prod", "new-checkout"), false);
  assert.equal(value(undefined, "new-checkout"), false);
  assert.equal(value("prod", "max-basket-items"), 10);
  assert.equal(value("staging", "max-basket-items"), 20);
  assert.equal(value("dev", "discount-rate"), 0);
  assert.throws(() => flagStore(declared, "staging").value("missing"), /no flag missing is declared/);
});

test("a flag that does not fit its type is refused", () => {
  const cases = [
    ["New", { type: "boolean", default: true }, "must be kebab case"],
    ["a-1", { type: "boolean", default: true }, "each part starting with a letter"],
    ["a", true, "flags.a must be a mapping"],
    ["a", { type: "json", default: 1 }, "flags.a.type must be one of boolean, integer, number, string"],
    ["a", { type: "boolean" }, "flags.a.default is required"],
    ["a", { type: "boolean", default: "yes" }, 'flags.a.default must be a boolean, not "yes"'],
    ["a", { type: "integer", default: 1.5 }, "flags.a.default must be an integer"],
    ["a", { type: "integer", default: 2 ** 31 }, "flags.a.default must be an integer"],
    ["a", { type: "number", default: Infinity }, "flags.a.default must be a number"],
    ["a", { type: "boolean", default: true, min: 1 }, "flags.a may not set min"],
    ["a", { type: "boolean", default: true, dev: false }, "flags.a may not set dev"],
    ["a", { type: "integer", default: 5, min: 10 }, "flags.a.default is outside min and max"],
    ["a", { type: "integer", default: 5, prod: 101, max: 100 }, "flags.a.prod is outside min and max"],
    ["a", { type: "integer", default: 5, min: 9, max: 1 }, "flags.a.min is above its max"],
    ["a", { type: "string", default: "x", enum: [] }, "flags.a.enum must list distinct strings"],
    ["a", { type: "string", default: "x", enum: ["y"] }, "flags.a.default must be one of y"],
  ];
  for (const [name, flag, message] of cases) {
    assert.ok(problem(name, flag).includes(message), `${name}: ${problem(name, flag)}`);
    assert.throws(() => generate({ flags: { [name]: flag } }), { message: `swhurl.yaml: ${problem(name, flag)}` });
  }
  for (const [name, flag] of Object.entries(declared)) assert.equal(problem(name, flag), "");
});

test("an override from the console wins until it is cleared, and must fit the declaration", () => {
  const store = flagStore(declared, "prod", "orders");
  assert.equal(store.apply("new-checkout", true), "");
  assert.equal(store.value("new-checkout"), true);
  assert.equal(store.apply("new-checkout", undefined), "");
  assert.equal(store.value("new-checkout"), false, "cleared: back to the declared value");
  assert.match(store.apply("new-checkout", "yes"), /new-checkout is not a boolean: ignored/);
  assert.match(store.apply("max-basket-items", 1.5), /not an integer/);
  assert.match(store.apply("max-basket-items", 500), /outside min and max/);
  assert.match(store.apply("banner", "loud"), /not one of none, sale/);
  assert.match(store.apply("gone", true), /gone, which swhurl.yaml does not declare/);
  assert.equal(store.value("max-basket-items"), 10, "an ignored override changes nothing");
  assert.equal(store.apply("banner", "sale"), "");
  assert.equal(store.value("banner"), "sale");
});

test("off the platform there is nothing to watch and the app is ready at once", () => {
  const store = flagStore(declared, undefined, undefined);
  store.watch();
  assert.equal(store.loaded(), true);
});
