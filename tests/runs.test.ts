import { describe, expect, it } from "vitest";
import type { Run, RunEvent, RunOutcome } from "../shared/types.ts";
import { FakeEngine } from "../server/src/engines/fake.ts";
import { EngineError, type Engine, type EngineContext } from "../server/src/engines/types.ts";
import { RunManager, type RunInput } from "../server/src/runs.ts";
import { MemoryScreenshots } from "../server/src/screenshots.ts";

function stubEngine(name: "api" | "browser", impl: (ctx: EngineContext) => Promise<RunOutcome>, unavailable: string | null = null): Engine & { calls: number } {
  const e = {
    name,
    calls: 0,
    unavailableReason: async () => unavailable,
    purchase: async (_req: unknown, ctx: EngineContext) => {
      e.calls++;
      return impl(ctx);
    },
  };
  return e;
}

const ok = async (ctx: EngineContext): Promise<RunOutcome> => {
  ctx.step("connect", "done");
  ctx.commit();
  return { status: "success", message: "Parked.", endTime: new Date(Date.now() + 3 * 3600_000).toISOString(), committed: true };
};

function setup(opts: { api?: Engine; browser?: Engine; timeoutMs?: number; maxConcurrent?: number } = {}) {
  return new RunManager({
    engines: { api: opts.api ?? stubEngine("api", ok), browser: opts.browser ?? stubEngine("browser", ok), fake: new FakeEngine(5) },
    lotCode: "Q60x6xih",
    timeoutMs: opts.timeoutMs ?? 5000,
    screenshots: new MemoryScreenshots(),
    maxConcurrent: opts.maxConcurrent,
    log: () => {},
  });
}

let n = 0;
function input(over: Partial<RunInput> = {}): RunInput {
  return {
    plate: "ABC1234",
    phone: "+14145550199",
    promoCode: "PROMO1",
    rateName: "",
    vehicleName: "",
    engine: "api",
    dryRun: false,
    allowLotMismatch: false,
    idempotencyKey: `key-${++n}-xxxxxx`,
    ...over,
  };
}

function finished(runs: RunManager, id: string): Promise<Run> {
  return new Promise((resolve) => {
    runs.subscribe(id, (e: RunEvent) => e.type === "done" && resolve(e.run));
  });
}

function started(r: ReturnType<RunManager["start"]>): Run {
  if (!r.ok) throw new Error(`expected a run, got ${r.code}`);
  return r.run;
}

describe("RunManager", () => {
  it("runs a purchase and never exposes the phone or promo code", async () => {
    const runs = setup();
    const run = started(runs.start(input()));
    const done = await finished(runs, run.id);
    expect(done.status).toBe("success");
    expect(JSON.stringify(done)).not.toContain("4145550199");
    expect(JSON.stringify(done)).not.toContain("PROMO1");
  });

  it("allows one purchase per plate at a time, but different plates in parallel", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = stubEngine("api", async (ctx) => {
      await gate;
      return ok(ctx);
    });
    const runs = setup({ api: slow });
    const a = started(runs.start(input()));
    expect(runs.start(input())).toMatchObject({ ok: false, code: "busy", run: { id: a.id } });
    const other = started(runs.start(input({ plate: "XYZ987" })));
    release();
    await Promise.all([finished(runs, a.id), finished(runs, other.id)]);
    expect(slow.calls).toBe(2);
    // The plate is free again once its run finishes.
    expect(runs.start(input()).ok).toBe(true);
  });

  it("caps how many purchases run at once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runs = setup({ api: stubEngine("api", async (ctx) => (await gate, ok(ctx))), maxConcurrent: 2 });
    const a = started(runs.start(input({ plate: "AAA111" })));
    const b = started(runs.start(input({ plate: "BBB222" })));
    expect(runs.start(input({ plate: "CCC333" }))).toMatchObject({ ok: false, code: "too_many" });
    release();
    await Promise.all([finished(runs, a.id), finished(runs, b.id)]);
  });

  it("returns the same run for a repeated tap (idempotency key)", async () => {
    const api = stubEngine("api", ok);
    const runs = setup({ api });
    const a = started(runs.start(input({ idempotencyKey: "same-key-1" })));
    expect(runs.start(input({ idempotencyKey: "same-key-1" }))).toMatchObject({ ok: true, existing: true, run: { id: a.id } });
    await finished(runs, a.id);
    expect(runs.start(input({ idempotencyKey: "same-key-1" }))).toMatchObject({ ok: true, existing: true, run: { id: a.id } });
    expect(api.calls).toBe(1);
  });

  it("falls back to the browser when the fast engine breaks before checkout (auto mode)", async () => {
    const api = stubEngine("api", async () => {
      throw new EngineError("TapNPark /rates returned an unexpected response");
    });
    const browser = stubEngine("browser", ok);
    const runs = setup({ api, browser });
    const run = await finished(runs, started(runs.start(input({ engine: "auto" }))).id);
    expect(run).toMatchObject({ status: "success", engine: "browser", fellBackFrom: "api" });
    expect(run.logs[0]).toMatch(/Retrying in the browser/);
    expect(browser.calls).toBe(1);
  });

  it("reports an error, not a fallback, when the browser engine isn't available (cloud)", async () => {
    const api = stubEngine("api", async () => {
      throw new EngineError("boom");
    });
    const browser = stubEngine("browser", ok, "The browser engine only runs on the Mac version.");
    const runs = setup({ api, browser });
    const run = await finished(runs, started(runs.start(input({ engine: "auto" }))).id);
    expect(run.status).toBe("error");
    expect(browser.calls).toBe(0);
  });

  it("never falls back after checkout started; reports the outcome as unknown", async () => {
    const api = stubEngine("api", async (ctx) => {
      ctx.commit();
      throw new EngineError("socket hang up", true);
    });
    const browser = stubEngine("browser", ok);
    const runs = setup({ api, browser });
    const run = await finished(runs, started(runs.start(input({ engine: "auto" }))).id);
    expect(run.status).toBe("unknown");
    expect(browser.calls).toBe(0);
  });

  it("does not fall back in fast-only mode", async () => {
    const runs = setup({
      api: stubEngine("api", async () => {
        throw new EngineError("boom");
      }),
    });
    const run = await finished(runs, started(runs.start(input())).id);
    expect(run.status).toBe("error");
    expect(run.outcome?.message).toContain("Nothing was bought");
  });

  it("can be cancelled before checkout, not after", async () => {
    const runs = setup();
    const a = started(runs.start(input({ engine: "fake" })));
    expect(runs.cancel(a.id)).toEqual({ ok: true });
    const cancelled = await finished(runs, a.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.steps.some((s) => s.status === "failed")).toBe(false);

    let proceed!: () => void;
    const api = stubEngine("api", async (ctx) => {
      ctx.commit();
      await new Promise<void>((r) => (proceed = r));
      return { status: "success", message: "Parked.", committed: true };
    });
    const second = setup({ api });
    const b = started(second.start(input()));
    await new Promise((r) => setTimeout(r, 0));
    expect(second.cancel(b.id)).toEqual({ ok: false, code: "too_late" });
    proceed();
    await finished(second, b.id);
  });

  it("times out stuck runs without buying", async () => {
    const api = stubEngine("api", (ctx) => new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason))));
    const runs = setup({ api, timeoutMs: 30 });
    const run = await finished(runs, started(runs.start(input())).id);
    expect(run.status).toBe("timeout");
  });

  it("drives the simulated engine through every step", async () => {
    const runs = setup();
    const run = await finished(runs, started(runs.start(input({ engine: "fake" }))).id);
    expect(run.status).toBe("success");
    expect(run.steps.every((st) => st.status === "done")).toBe(true);
  });

  it("returns null for runs it doesn't know", () => {
    const runs = setup();
    expect(runs.getRun("nope")).toBeNull();
    expect(runs.subscribe("nope", () => {})).toBeNull();
  });
});
