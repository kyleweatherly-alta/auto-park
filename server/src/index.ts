import path from "node:path";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { ApiEngine } from "./engines/api.ts";
import { BrowserEngine } from "./engines/browser.ts";
import { FakeEngine } from "./engines/fake.ts";
import { RatesService } from "./rates.ts";
import { RunManager } from "./runs.ts";
import { FileKV } from "./store/kv.ts";
import { Repo } from "./store/repo.ts";

const config = loadConfig();
const kv = new FileKV(config.DATA_DIR);
const repo = new Repo(kv, {
  plate: config.DEFAULT_PLATE,
  phone: config.DEFAULT_PHONE,
  promo: config.DEFAULT_PROMO,
  rate: config.DEFAULT_RATE,
  engine: config.PARK_ENGINE,
});

const engines = { api: new ApiEngine(), browser: new BrowserEngine(config.BROWSER_EXECUTABLE_PATH), fake: new FakeEngine(config.FAKE_STEP_MS) };
const runs = new RunManager({
  repo,
  engines,
  lotCode: config.LOT_CODE,
  lotName: config.LOT_NAME,
  defaultEngine: config.PARK_ENGINE,
  timeoutMs: config.RUN_TIMEOUT_MS,
  screenshotsDir: path.resolve(config.DATA_DIR, "screenshots"),
});
await runs.recoverInterrupted();

const app = createApp({
  config,
  repo,
  runs,
  rates: {
    live: new RatesService(config.LOT_CODE, () => engines.api),
    fake: new RatesService(config.LOT_CODE, () => engines.fake),
  },
  webDir: path.resolve("dist/web"),
});

app.listen(config.PORT, () => {
  const browser = engines.browser.unavailableReason();
  void browser.then((reason) => {
    console.log(`Auto-Park listening on http://localhost:${config.PORT}`);
    console.log(`  storage: ${kv.kind}  engine: ${config.PARK_ENGINE}  browser engine: ${reason ?? "ready"}`);
  });
});
