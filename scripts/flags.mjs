// Generates src/flags.ts from the feature flags declared in swhurl.yaml: one typed accessor per flag.
// package.json runs it before every build, type-check, dev start and test, so swhurl.yaml is the only
// place a flag is written. It refuses what the platform refuses:
// https://github.com/samclement/swhurl-platform/blob/main/docs/apps.md#feature-flags
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

const ENVIRONMENTS = ["staging", "prod"];
const TYPES = { boolean: "boolean", integer: "number", number: "number", string: "string" };
const NAME = /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/;

/** Why one declared flag cannot be used, or "". */
export function problem(name, flag) {
  if (name.length > 40 || !NAME.test(name)) {
    return `flag name '${name}' must be kebab case, each part starting with a letter (new-checkout), at most 40 characters`;
  }
  if (typeof flag !== "object" || flag === null || Array.isArray(flag)) return `flags.${name} must be a mapping with type and default`;
  const type = flag.type;
  if (!(type in TYPES)) return `flags.${name}.type must be one of ${Object.keys(TYPES).join(", ")}`;
  const numeric = type === "integer" || type === "number";
  const allowed = ["type", "description", "default", ...ENVIRONMENTS, ...(numeric ? ["min", "max"] : []), ...(type === "string" ? ["enum"] : [])];
  const unknown = Object.keys(flag).filter((key) => !allowed.includes(key)).sort();
  if (unknown.length) return `flags.${name} may not set ${unknown.join(", ")} (a ${type} flag sets ${[...allowed].sort().join(", ")})`;
  if ("description" in flag && typeof flag.description !== "string") return `flags.${name}.description must be text`;
  if (!("default" in flag)) return `flags.${name}.default is required`;
  // An integer flag is an Int in Kotlin: 32 bits.
  const fits = (value) => typeof value === TYPES[type] && (!numeric || Number.isFinite(value))
    && (type !== "integer" || (Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31));
  for (const bound of ["min", "max"]) {
    if (bound in flag && !(typeof flag[bound] === "number" && (type === "number" || Number.isInteger(flag[bound])))) {
      return `flags.${name}.${bound} must be a${type === "integer" ? "n integer" : " number"}`;
    }
  }
  if ("min" in flag && "max" in flag && flag.min > flag.max) return `flags.${name}.min is above its max`;
  const choices = flag.enum;
  if (choices !== undefined && (!Array.isArray(choices) || !choices.length || !choices.every((v) => typeof v === "string")
    || new Set(choices).size !== choices.length)) {
    return `flags.${name}.enum must list distinct strings`;
  }
  for (const key of ["default", ...ENVIRONMENTS].filter((k) => k in flag)) {
    const value = flag[key];
    if (!fits(value)) return `flags.${name}.${key} must be a${type === "integer" ? "n" : ""} ${type}, not ${JSON.stringify(value)}`;
    if (numeric && (value < (flag.min ?? value) || value > (flag.max ?? value))) return `flags.${name}.${key} is outside min and max`;
    if (choices && !choices.includes(value)) return `flags.${name}.${key} must be one of ${choices.join(", ")}`;
  }
  return "";
}

const camel = (name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
const comment = (text) => text.replaceAll("*/", "*\\/").replace(/\s+/g, " ").trim();

/** The source of src/flags.ts for the flags of a parsed swhurl.yaml; throws naming the first problem. */
export function generate(declaration) {
  const flags = declaration?.flags ?? {};
  if (typeof flags !== "object" || Array.isArray(flags)) throw new Error("swhurl.yaml: flags must be a mapping");
  for (const [name, flag] of Object.entries(flags)) {
    const found = problem(name, flag);
    if (found) throw new Error(`swhurl.yaml: ${found}`);
  }
  const accessors = Object.entries(flags).map(([name, flag]) => [
    ...(flag.description ? [`  /** ${comment(flag.description)} */`] : []),
    `  get ${camel(name)}(): ${TYPES[flag.type]} { return store.value(${JSON.stringify(name)}) as ${TYPES[flag.type]}; },`,
  ].join("\n"));
  return [
    "// Generated from the flags in swhurl.yaml by scripts/flags.mjs: edit swhurl.yaml, not this file.",
    "// https://github.com/samclement/swhurl-platform/blob/main/docs/apps.md#feature-flags",
    'import { type WatchHooks, flagStore } from "./flagstore.js";',
    "",
    `const store = flagStore(${JSON.stringify(flags, null, 2)});`,
    "",
    "/** This app's feature flags: an override from the console, else the value swhurl.yaml declares for this environment. */",
    "export const flags = {",
    ...accessors,
    "};",
    "",
    "/** Watch this app's overrides on the platform (src/server.ts or src/worker.ts starts it). */",
    "export const watchFlags = (hooks?: WatchHooks): void => store.watch(hooks);",
    "/** Whether the stored overrides have arrived: /healthz reports not ready until then (at most 5 s). */",
    "export const flagsLoaded = (): boolean => store.loaded();",
    "",
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input = "swhurl.yaml", output = "src/flags.ts"] = process.argv.slice(2);
  try {
    writeFileSync(output, generate(parse(readFileSync(input, "utf8"))));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
