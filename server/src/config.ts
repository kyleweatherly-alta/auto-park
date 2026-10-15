import { randomBytes } from "node:crypto";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  APP_PASSCODE: z.string().min(4, "APP_PASSCODE must be at least 4 characters"),
  SESSION_SECRET: z.string().optional(),
  LOT_CODE: z.string().regex(/^[A-Za-z0-9]+$/).default("Q60x6xih"),
  LOT_NAME: z.string().default("MAC Member Parking"),
  PARK_ENGINE: z.enum(["auto", "api", "browser", "fake"]).default("auto"),
  DEFAULT_PLATE: z.string().default(""),
  DEFAULT_PHONE: z.string().default(""),
  DEFAULT_PROMO: z.string().default(""),
  DEFAULT_RATE: z.string().default(""),
  DATA_DIR: z.string().default("./data"),
  RUN_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  FAKE_STEP_MS: z.coerce.number().int().nonnegative().default(700),
  /** Use a system Chrome/Chromium instead of Playwright's download. */
  BROWSER_EXECUTABLE_PATH: z.string().optional(),
});

export type Config = z.infer<typeof schema> & { sessionSecret: string; isProduction: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration (see .env.example):\n${problems}`);
  }
  const cfg = parsed.data;
  const isProduction = cfg.NODE_ENV === "production";
  if (isProduction && (!cfg.SESSION_SECRET || cfg.SESSION_SECRET.length < 32)) {
    throw new Error("SESSION_SECRET must be set to at least 32 characters in production.");
  }
  // In development a random secret is fine; you just log in again after a restart.
  const sessionSecret = cfg.SESSION_SECRET || randomBytes(32).toString("hex");
  return { ...cfg, sessionSecret, isProduction };
}
