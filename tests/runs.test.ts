import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Run, RunEvent, RunOutcome } from "../shared/types.ts";
import { FakeEngine } from "../server/src/engines/fake.ts";
import { EngineError, type Engine, type EngineContext } from "../server/src/engines/types.ts";
import { RunManager } from "../server/src/runs.ts";
import { MemoryKV } from "../server/src/store/kv.ts";
import { Repo } from "../server/src/store/repo.ts";

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

async function setup(opts: { engine?: "auto" | "api" | "browser" | "fake"; api?: Engine; browser?: Engine; timeoutMs?: number } = {}) {
  const repo = new Repo(new MemoryKV(), { plate: "ABC1234", phone: "414-555-0199", promo: "PROMO1", rate: "", engine: opts.engine ?? "auto" });
  const profile = await repo.getProfile();
  await repo.saveProfile(profile);
  const runs = new RunManager({
    repo,
    engines: { api: opts.api ?? stubEngine("api", ok), browser: opts.browser ?? stubEngine("browser", ok), fake: new FakeEngine(5) },
    lotCode: "Q60x6xih",
    lotName: "MAC Member Parking",
    defaultEngine: "auto",
    timeoutMs: opts.timeoutMs ?? 5000,
    screenshotsDir: path.join(await mkdtemp(path.join(tmpdir(), "ap-")), "shots"),
    log: () => {},
  });
  return { repo, runs, vehicleId: profile.vehicles[0]!.id };
}

function finished(runs: RunManager, id: string): Promise<Run> {
  return new Promise((resolve) => {
    void runs.subscribe(id, (e: RunEvent) => e.type === "done" && resolve(e.run));
  });
}

describe("RunManager", () => {
  it("runs a purchase and records it in history", async () => {
    const { runs, repo, vehicleId } = await setup();
    const started = await runs.start({ vehicleId, idempotencyKey: "tap-1-xxxx" });
    expect(started.ok).toBe(true);
    const run = await finished(runs, (started as { run: Run }).run.id);
    expect(run.status).toBe("success");
    expect((await repo.listRuns())[0]).toMatchObject({ id: run.id, status: "success", plate: "ABC1234" });
  });

  it("only allows one purchase at a time", async () => {
    let release!: () => void;
    const slow = stubEngine("api", (ctx) => new Promise((r) => (release = () => r(ok(ctx)))));
    const { runs, vehicleId } = await setup({ engine: "api", api: slow });
    const a = await runs.start({ vehicleId, idempotencyKey: "tap-a-xxxx" });
    const b = await runs.start({ vehicleId, idempotencyKey: "tap-b-xxxx" });
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, code: "busy" });
    release();
    await finished(runs, (a as { run: Run }).run.id);
    expect(slow.calls).toBe(1);
  });

  it("returns the same run for a repeated tap (idempotency key)", async () => {
    const api = stubEngine("api", ok);
    const { runs, vehicleId } = await setup({ engine: "api", api });
    const a = await runs.start({ vehicleId, idempotencyKey: "same-key-1" });
    const b = await runs.start({ vehicleId, idempotencyKey: "same-key-1" });
    expect(b).toMatchObject({ ok: true, existing: true, run: { id: (a as { run: Run }).run.id } });
    await finished(runs, (a as { run: Run }).run.id);
    expect(api.calls).toBe(1);
  });

  it("asks before buying again while the plate is still parked", async () => {
    const { runs, vehicleId } = await setup({ engine: "api" });
    const first = await runs.start({ vehicleId, idempotencyKey: "first-tap-1" });
    await finished(runs, (first as { run: Run }).run.id);

    const second = await runs.start({ vehicleId, idempotencyKey: "second-tap-1" });
    expect(second).toMatchObject({ ok: false, code: "already_parked" });

    const forced = await runs.start({ vehicleId, idempotencyKey: "third-tap-1", force: true });
    expect(forced.ok).toBe(true);
    await finished(runs, (forced as { run: Run }).run.id);
  });

  it("test runs skip the already-parked check", async () => {
    const { runs, vehicleId } = await setup({ engine: "api" });
    const first = await runs.start({ vehicleId, idempotencyKey: "first-tap-2" });
    await finished(runs, (first as { run: Run }).run.id);
    expect((await runs.start({ vehicleId, idempotencyKey: "dry-tap-2", dryRun: true })).ok).toBe(true);
  });

  it("falls back to the browser when the fast engine breaks before checkout", async () => {
    const api = stubEngine("api", async () => {
      throw new EngineError("TapNPark /rates returned an unexpected response");
    });
    const browser = stubEngine("browser", ok);
    const { runs, vehicleId } = await setup({ engine: "auto", api, browser });
    const s = await runs.start({ vehicleId, idempotencyKey: "fallback-1" });
    const run = await finished(runs, (s as { run: Run }).run.id);
    expect(run).toMatchObject({ status: "success", engine: "browser", fellBackFrom: "api" });
    expect(run.logs[0]).toMatch(/Retrying in the browser/);
    expect(browser.calls).toBe(1);
  });

  it("never falls back after checkout started; reports the outcome as unknown", async () => {
    const api = stubEngine("api", async (ctx) => {
      ctx.commit();
      throw new EngineError("socket hang up", true);
    });
    const browser = stubEngine("browser", ok);
    const { runs, vehicleId } = await setup({ engine: "auto", api, browser });
    const s = await runs.start({ vehicleId, idempotencyKey: "unknown-1" });
    const run = await finished(runs, (s as { run: Run }).run.id);
    expect(run.status).toBe("unknown");
    expect(browser.calls).toBe(0);

    // ...and asks before buying again
    expect(await runs.start({ vehicleId, idempotencyKey: "unknown-2" })).toMatchObject({ ok: false, code: "maybe_parked" });
  });

  it("does not fall back in api-only mode", async () => {
    const api = stubEngine("api", async () => {
      throw new EngineError("boom");
    });
    const browser = stubEngine("browser", ok);
    const { runs, vehicleId } = await setup({ engine: "api", api, browser });
    const s = await runs.start({ vehicleId, idempotencyKey: "nofallback-1" });
    const run = await finished(runs, (s as { run: Run }).run.id);
    expect(run.status).toBe("error");
    expect(run.outcome?.message).toContain("Nothing was bought");
    expect(browser.calls).toBe(0);
  });

  it("can be cancelled before checkout, not after", async () => {
    const { runs, vehicleId } = await setup({ engine: "fake" });
    const s = await runs.start({ vehicleId, idempotencyKey: "cancel-1" });
    const id = (s as { run: Run }).run.id;
    expect(runs.cancel(id)).toEqual({ ok: true });
    const run = await finished(runs, id);
    expect(run.status).toBe("cancelled");

    let proceed!: () => void;
    const api = stubEngine("api", async (ctx) => {
      ctx.commit();
      await new Promise<void>((r) => (proceed = r));
      return { status: "success", message: "Parked.", committed: true };
    });
    const second = await setup({ engine: "api", api });
    const s2 = await second.runs.start({ vehicleId: second.vehicleId, idempotencyKey: "cancel-2" });
    await new Promise((r) => setTimeout(r, 0));
    expect(second.runs.cancel((s2 as { run: Run }).run.id)).toEqual({ ok: false, code: "too_late" });
    proceed();
    await finished(second.runs, (s2 as { run: Run }).run.id);
  });

  it("times out stuck runs without buying", async () => {
    const api = stubEngine("api", (ctx) => new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason))));
    const { runs, vehicleId } = await setup({ engine: "api", api, timeoutMs: 30 });
    const s = await runs.start({ vehicleId, idempotencyKey: "timeout-1" });
    const run = await finished(runs, (s as { run: Run }).run.id);
    expect(run.status).toBe("timeout");
  });

  it("marks runs interrupted by a restart as unknown", async () => {
    const { runs, repo } = await setup();
    await repo.saveRun({ id: "r1", createdAt: new Date().toISOString(), plate: "ABC1234", vehicleName: "ABC1234", rateName: "", dryRun: false, engine: "api", status: "running", steps: [], hasScreenshot: false, logs: [] });
    await runs.recoverInterrupted();
    expect((await repo.listRuns())[0]).toMatchObject({ id: "r1", status: "unknown" });
  });

  it("drives the simulated engine through every step", async () => {
    const { runs, vehicleId } = await setup({ engine: "fake" });
    const s = await runs.start({ vehicleId, idempotencyKey: "fake-1" });
    const run = await finished(runs, (s as { run: Run }).run.id);
    expect(run.status).toBe("success");
    expect(run.steps.every((st) => st.status === "done")).toBe(true);
  });
});
