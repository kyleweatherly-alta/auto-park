import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  LOT_CODE: z.string().regex(/^[A-Za-z0-9]+$/).default("Q60x6xih"),
  LOT_NAME: z.string().default("MAC Member Parking"),
  /** Purchase method used when a device hasn't picked one. */
  PARK_ENGINE: z.enum(["auto", "api", "browser", "fake"]).default("auto"),
  RUN_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  FAKE_STEP_MS: z.coerce.number().int().nonnegative().default(700),
  /** Purchases each visitor (IP address) may start per hour. */
  RUNS_PER_HOUR: z.coerce.number().int().positive().default(30),
  /** Where browser-engine screenshots are kept (local runs only). */
  DATA_DIR: z.string().default("./data"),
  /** Use a system Chrome/Chromium instead of Playwright's download. */
  BROWSER_EXECUTABLE_PATH: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

/** Works with process.env (Node) and a Worker's env bindings alike. */
export function loadConfig(env: Record<string, unknown>): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration (see .env.example):\n${problems}`);
  }
  return parsed.data;
}
