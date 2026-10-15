// Local entry point (this Mac): the API plus the built web app, all engines available.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApi, SECURITY_HEADERS } from "./app.ts";
import { loadConfig } from "./config.ts";
import { ApiEngine } from "./engines/api.ts";
import { BrowserEngine } from "./engines/browser.ts";
import { FakeEngine } from "./engines/fake.ts";
import { RatesService } from "./rates.ts";
import { RunManager } from "./runs.ts";
import { FileScreenshots } from "./screenshots-file.ts";

const config = loadConfig(process.env);
const engines = { api: new ApiEngine(), browser: new BrowserEngine(config.BROWSER_EXECUTABLE_PATH), fake: new FakeEngine(config.FAKE_STEP_MS) };
const browserReason = await engines.browser.unavailableReason();

const app = createApi({
  lotName: config.LOT_NAME,
  engines: browserReason ? ["api", "fake"] : ["auto", "api", "browser", "fake"],
  defaultEngine: browserReason && (config.PARK_ENGINE === "auto" || config.PARK_ENGINE === "browser") ? "api" : config.PARK_ENGINE,
  runs: new RunManager({
    engines,
    lotCode: config.LOT_CODE,
    timeoutMs: config.RUN_TIMEOUT_MS,
    screenshots: new FileScreenshots(path.resolve(config.DATA_DIR, "screenshots")),
  }),
  rates: {
    live: new RatesService(config.LOT_CODE, () => engines.api),
    fake: new RatesService(config.LOT_CODE, () => engines.fake),
  },
  runsPerHour: config.RUNS_PER_HOUR,
});

// Built web app (production). In development Vite serves it instead.
const webDir = path.resolve("dist/web");
app.use("*", async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!c.res.headers.has(k)) c.header(k, v);
});
app.use("/*", serveStatic({ root: path.relative(process.cwd(), webDir) || "." }));
app.get("*", async (c) => {
  try {
    return c.html(await readFile(path.join(webDir, "index.html"), "utf8"));
  } catch {
    return c.text("Web app not built. Run `npm run build`, or use `npm run dev`.", 404);
  }
});

serve({ fetch: app.fetch, port: config.PORT }, () => {
  console.log(`Auto-Park listening on http://localhost:${config.PORT}`);
  console.log(`  default engine: ${config.PARK_ENGINE}  browser engine: ${browserReason ?? "ready"}`);
});
