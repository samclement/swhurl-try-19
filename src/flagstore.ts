// The values of this app's feature flags. src/flags.ts, generated from swhurl.yaml, reads them here.
// https://github.com/samclement/swhurl-platform/blob/main/docs/apps.md#feature-flags
//
// A flag is, in order: an override set from the console (watched on the platform's NATS, in the
// bucket flags-<env> under <env>.<app>.<flag>), the value swhurl.yaml declares for this environment
// (SWHURL_ENV), its default. An override survives a restart: the watch first delivers every stored
// value, then each change. Off the platform there is nothing to watch and the declared values apply.
import { connected, eventsEnabled } from "./events.js";

export type FlagValue = boolean | number | string;

const ENVIRONMENTS = ["staging", "prod"] as const;
type Environment = (typeof ENVIRONMENTS)[number];
/** How long a web app reports not ready while it waits for its stored overrides. */
const LOAD_TIMEOUT_MS = 5_000;

export type Declared = {
  type: "boolean" | "integer" | "number" | "string";
  description?: string;
  default: FlagValue;
  min?: number;
  max?: number;
  enum?: string[];
} & Partial<Record<Environment, FlagValue>>;

export type WatchHooks = {
  /** A flag's override was set (value) or cleared (undefined). */
  onChange?: (name: string, value: FlagValue | undefined) => void;
  /** A watch attempt failed (it is tried again) or an override was ignored. */
  onProblem?: (error: unknown) => void;
};

const isEnvironment = (env: string | undefined): env is Environment => ENVIRONMENTS.includes(env as Environment);

/** Why ``value`` cannot be this flag's value, or "". */
export function unfit(flag: Declared, value: unknown): string {
  const numeric = flag.type === "integer" || flag.type === "number";
  const kind = numeric ? "number" : flag.type;
  if (typeof value !== kind || (numeric && !Number.isFinite(value))) return `not a ${flag.type}`;
  if (flag.type === "integer" && !Number.isInteger(value)) return "not an integer";
  if (numeric && ((flag.min !== undefined && (value as number) < flag.min) || (flag.max !== undefined && (value as number) > flag.max))) {
    return "outside min and max";
  }
  if (flag.enum && !flag.enum.includes(value as string)) return `not one of ${flag.enum.join(", ")}`;
  return "";
}

export function flagStore(declared: Record<string, Declared>, env = process.env.SWHURL_ENV, app = process.env.SWHURL_APP) {
  const overrides = new Map<string, FlagValue>();
  let loaded = true;
  let watching = false;

  /** Take one watched entry: an override (value) or a cleared one (undefined). Returns why it was ignored, or "". */
  function apply(name: string, value: unknown): string {
    const flag = declared[name];
    if (!flag) return `override for ${name}, which swhurl.yaml does not declare: ignored`;
    if (value === undefined) {
      overrides.delete(name);
      return "";
    }
    const problem = unfit(flag, value);
    if (problem) return `override for ${name} is ${problem}: ignored`;
    overrides.set(name, value as FlagValue);
    return "";
  }

  return {
    value(name: string): FlagValue {
      const flag = declared[name];
      if (!flag) throw new Error(`no flag ${name} is declared in swhurl.yaml`);
      const override = overrides.get(name);
      if (override !== undefined) return override;
      const forEnvironment = isEnvironment(env) ? flag[env] : undefined;
      return forEnvironment ?? flag.default;
    },
    apply,
    /** Whether the stored overrides have arrived (or there is nothing to wait for, or waiting timed out). */
    loaded: () => loaded,
    /** Watch this app's overrides until the process ends; once, and only on the platform. */
    watch(hooks: WatchHooks = {}): void {
      if (watching || !Object.keys(declared).length || !eventsEnabled() || !isEnvironment(env) || !app) return;
      watching = true;
      loaded = false;
      const timeout = setTimeout(() => {
        if (!loaded) hooks.onProblem?.(new Error(`flag overrides not loaded after ${LOAD_TIMEOUT_MS} ms: using declared values`));
        loaded = true;
      }, LOAD_TIMEOUT_MS);
      timeout.unref();
      const prefix = `${env}.${app}.`;
      void (async () => {
        for (;;) {
          try {
            const { connection } = await connected();
            const kv = await connection.jetstream().views.kv(`flags-${env}`, { bindOnly: true });
            const entries = await kv.watch({
              key: `${prefix}>`,
              initializedFn: () => {
                loaded = true;
                clearTimeout(timeout);
              },
            });
            for await (const entry of entries) {
              const name = entry.key.slice(prefix.length);
              let value: unknown;
              try {
                value = entry.operation === "PUT" ? entry.json() : undefined;
              } catch {
                hooks.onProblem?.(new Error(`override for ${name} is not JSON: ignored`));
                continue;
              }
              const problem = apply(name, value);
              if (problem) hooks.onProblem?.(new Error(problem));
              else hooks.onChange?.(name, value as FlagValue | undefined);
            }
          } catch (error) {
            hooks.onProblem?.(error);
          }
          await new Promise((resolve) => setTimeout(resolve, 5_000).unref());
        }
      })();
    },
  };
}
