// Cloudflare entry point: static web app from Workers Assets, /api/* handled by one
// Durable Object so every request sees the same in-memory runs (per-plate locks,
// live progress). The Durable Object stores nothing; personal details arrive with
// each purchase request and are discarded when it finishes.
import { DurableObject } from "cloudflare:workers";
import { createApi } from "../server/src/app.ts";
import { loadConfig } from "../server/src/config.ts";
import { ApiEngine } from "../server/src/engines/api.ts";
import { FakeEngine } from "../server/src/engines/fake.ts";
import { UnavailableEngine } from "../server/src/engines/unavailable.ts";
import { RatesService } from "../server/src/rates.ts";
import { RunManager } from "../server/src/runs.ts";
import { NoScreenshots } from "../server/src/screenshots.ts";

export interface Env {
  AUTOPARK: DurableObjectNamespace<AutoParkDO>;
  ASSETS: Fetcher;
  [key: string]: unknown;
}

export class AutoParkDO extends DurableObject<Env> {
  private readonly app: ReturnType<typeof createApi>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const config = loadConfig(env);
    const engines = {
      api: new ApiEngine(),
      browser: new UnavailableEngine("browser", "The browser engine only runs on the Mac version."),
      fake: new FakeEngine(config.FAKE_STEP_MS),
    };
    this.app = createApi({
      lotName: config.LOT_NAME,
      engines: ["api", "fake"],
      defaultEngine: config.PARK_ENGINE === "fake" ? "fake" : "api",
      runs: new RunManager({ engines, lotCode: config.LOT_CODE, timeoutMs: config.RUN_TIMEOUT_MS, screenshots: new NoScreenshots() }),
      rates: {
        live: new RatesService(config.LOT_CODE, () => engines.api),
        fake: new RatesService(config.LOT_CODE, () => engines.fake),
      },
      runsPerHour: config.RUNS_PER_HOUR,
    });
  }

  override fetch(request: Request): Response | Promise<Response> {
    return this.app.fetch(request);
  }
}

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) {
      return env.AUTOPARK.get(env.AUTOPARK.idFromName("main")).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
