import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { STEPS, type EngineMode, type EngineName, type Run, type RunEvent, type RunOutcome, type StartRunRequest, type Status } from "../../shared/types.ts";
import { EngineError, type Engine, type EngineContext } from "./engines/types.ts";
import type { Repo } from "./store/repo.ts";

/** How long a finished run stays in memory so a reconnecting phone can replay it. */
const KEEP_FINISHED_MS = 10 * 60 * 1000;
/** After an ambiguous run, ask before buying again for this long. */
const UNKNOWN_GRACE_MS = 30 * 60 * 1000;
const MAX_SCREENSHOTS = 30;

export const MESSAGES = {
  error: (why: string) => `Something went wrong talking to TapNPark: ${why} Nothing was bought.`,
  unknown:
    "The purchase may have gone through, but TapNPark didn't confirm it. Check your texts for a TapNPark receipt before trying again.",
  timeout: "TapNPark took too long, so Auto-Park stopped before checking out. Nothing was bought.",
  cancelled: "Cancelled. Nothing was bought.",
  restarted: "The server restarted during this run. Check your texts for a TapNPark receipt before trying again.",
};

type Listener = (e: RunEvent) => void;

interface LiveRun {
  run: Run;
  events: RunEvent[];
  listeners: Set<Listener>;
  controller: AbortController;
  committed: boolean;
}

export type StartResult =
  | { ok: true; run: Run; existing: boolean }
  | { ok: false; code: "busy"; run: Run }
  | { ok: false; code: "already_parked"; until: string; message: string }
  | { ok: false; code: "maybe_parked"; message: string }
  | { ok: false; code: "invalid"; message: string };

export interface RunManagerDeps {
  repo: Repo;
  engines: Record<EngineName, Engine>;
  lotCode: string;
  lotName: string;
  defaultEngine: EngineMode;
  timeoutMs: number;
  screenshotsDir: string;
  now?: () => number;
  log?: (msg: string) => void;
}

export class RunManager {
  private active: LiveRun | null = null;
  private live = new Map<string, LiveRun>();
  private idempotency = new Map<string, { runId: string; at: number }>();
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: RunManagerDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((m) => console.log(m));
  }

  /** Mark runs that were in flight when the server stopped. */
  async recoverInterrupted(): Promise<void> {
    for (const run of await this.deps.repo.listRuns()) {
      if (run.status === "running" || run.status === "queued") {
        run.status = "unknown";
        run.finishedAt = new Date(this.now()).toISOString();
        run.outcome = { status: "unknown", message: MESSAGES.restarted };
        await this.deps.repo.saveRun(run);
      }
    }
  }

  get activeRun(): Run | null {
    return this.active?.run ?? null;
  }

  async status(): Promise<Status> {
    const profile = await this.deps.repo.getProfile();
    return {
      lotName: this.deps.lotName,
      engine: profile.engine,
      activeRun: this.activeRun,
      parkedUntil: await this.parkedUntil(),
    };
  }

  /** The latest real purchase whose session hasn't ended, optionally for one plate. */
  async parkedUntil(plate?: string): Promise<Status["parkedUntil"]> {
    const now = this.now();
    for (const run of await this.deps.repo.listRuns()) {
      if (run.dryRun || run.status !== "success" || !run.outcome?.endTime) continue;
      if (plate && run.plate !== plate) continue;
      if (Date.parse(run.outcome.endTime) > now) return { plate: run.plate, endTime: run.outcome.endTime, runId: run.id };
    }
    return null;
  }

  private async recentUnknown(plate: string): Promise<Run | null> {
    const now = this.now();
    for (const run of await this.deps.repo.listRuns()) {
      if (run.plate !== plate || run.dryRun) continue;
      if (now - Date.parse(run.createdAt) > UNKNOWN_GRACE_MS) break;
      if (run.status === "unknown") return run;
      if (run.status === "success") return null;
    }
    return null;
  }

  async start(req: StartRunRequest): Promise<StartResult> {
    // Same tap delivered twice (double-tap, flaky network retry): hand back the same run.
    this.pruneIdempotency();
    const seen = this.idempotency.get(req.idempotencyKey);
    if (seen) {
      const run = this.live.get(seen.runId)?.run ?? (await this.deps.repo.listRuns()).find((r) => r.id === seen.runId);
      if (run) return { ok: true, run, existing: true };
    }
    if (this.active) return { ok: false, code: "busy", run: this.active.run };

    const profile = await this.deps.repo.getProfile();
    const vehicle = profile.vehicles.find((v) => v.id === req.vehicleId);
    if (!vehicle) return { ok: false, code: "invalid", message: "Pick a vehicle first." };
    if (!profile.phone) return { ok: false, code: "invalid", message: "Add the phone number for receipts in Settings." };

    if (!req.dryRun && !req.force) {
      const parked = await this.parkedUntil(vehicle.plate);
      if (parked) {
        return { ok: false, code: "already_parked", until: parked.endTime, message: `${vehicle.plate} is already parked until ${parked.endTime}.` };
      }
      if (await this.recentUnknown(vehicle.plate)) {
        return { ok: false, code: "maybe_parked", message: "A recent purchase for this plate may have gone through. Check your texts before buying again." };
      }
    }

    const mode = profile.engine ?? this.deps.defaultEngine;
    const primary: EngineName = mode === "auto" ? "api" : mode;
    const rateName = req.rateName ?? profile.preferredRate;
    const run: Run = {
      id: randomUUID(),
      createdAt: new Date(this.now()).toISOString(),
      plate: vehicle.plate,
      vehicleName: vehicle.nickname || vehicle.plate,
      rateName,
      dryRun: !!req.dryRun,
      engine: primary,
      status: "running",
      steps: STEPS.map((s) => ({ id: s.id, status: "pending" })),
      hasScreenshot: false,
      logs: [],
    };
    const live: LiveRun = { run, events: [], listeners: new Set(), controller: new AbortController(), committed: false };
    this.active = live;
    this.live.set(run.id, live);
    this.idempotency.set(req.idempotencyKey, { runId: run.id, at: this.now() });
    await this.deps.repo.saveRun(run);
    this.log(`[run ${run.id.slice(0, 8)}] start ${run.dryRun ? "test " : ""}${vehicle.plate} via ${primary}`);

    void this.execute(live, {
      lotCode: this.deps.lotCode,
      plate: vehicle.plate,
      phone: profile.phone,
      promoCode: profile.promoCode,
      rateName,
      dryRun: !!req.dryRun,
      allowLotMismatch: !!req.allowLotMismatch,
    }, mode === "auto");
    return { ok: true, run: structuredClone(run), existing: false };
  }

  cancel(id: string): { ok: true } | { ok: false; code: "not_running" | "too_late" } {
    const live = this.active;
    if (!live || live.run.id !== id) return { ok: false, code: "not_running" };
    if (live.committed) return { ok: false, code: "too_late" };
    live.controller.abort("user");
    return { ok: true };
  }

  /** Replays everything so far, then streams new events. Returns an unsubscribe function. */
  async subscribe(id: string, listener: Listener): Promise<(() => void) | null> {
    const live = this.live.get(id);
    if (!live) {
      const run = (await this.deps.repo.listRuns()).find((r) => r.id === id);
      if (!run) return null;
      listener({ type: "snapshot", run });
      listener({ type: "done", run });
      return () => {};
    }
    listener({ type: "snapshot", run: structuredClone(live.run) });
    if (live.run.status !== "running") {
      listener({ type: "done", run: structuredClone(live.run) });
      return () => {};
    }
    live.listeners.add(listener);
    return () => live.listeners.delete(listener);
  }

  async getRun(id: string): Promise<Run | null> {
    return this.live.get(id)?.run ?? (await this.deps.repo.listRuns()).find((r) => r.id === id) ?? null;
  }

  screenshotPath(id: string): string {
    return path.join(this.deps.screenshotsDir, `${id.replace(/[^a-f0-9-]/gi, "")}.png`);
  }

  private emit(live: LiveRun, e: RunEvent) {
    live.events.push(e);
    for (const l of live.listeners) {
      try {
        l(e);
      } catch {
        // a broken listener must not break the run
      }
    }
  }

  private context(live: LiveRun): EngineContext {
    const { run } = live;
    return {
      signal: live.controller.signal,
      step: (id, status, detail) => {
        const s = run.steps.find((x) => x.id === id);
        if (s) {
          s.status = status;
          s.detail = detail;
        }
        this.emit(live, { type: "step", step: id, status, detail });
      },
      log: (message) => {
        this.log(`[run ${run.id.slice(0, 8)}] ${message}`);
        if (run.logs.length < 20) run.logs.push(message);
        this.emit(live, { type: "log", message });
      },
      commit: () => {
        if (live.controller.signal.aborted) return false;
        live.committed = true;
        return true;
      },
      saveScreenshot: async (png) => {
        try {
          await mkdir(this.deps.screenshotsDir, { recursive: true });
          await writeFile(this.screenshotPath(run.id), png);
          run.hasScreenshot = true;
          await this.pruneScreenshots();
        } catch (err) {
          this.log(`[run ${run.id.slice(0, 8)}] couldn't save screenshot: ${(err as Error).message}`);
        }
      },
    };
  }

  private async execute(live: LiveRun, req: Parameters<Engine["purchase"]>[0], allowFallback: boolean) {
    const { run } = live;
    const timer = setTimeout(() => live.controller.abort("timeout"), this.deps.timeoutMs);
    let result: RunOutcome;
    try {
      result = await this.attempt(live, req, allowFallback);
    } finally {
      clearTimeout(timer);
    }
    run.status = result.status;
    run.outcome = result;
    run.finishedAt = new Date(this.now()).toISOString();
    for (const s of run.steps) if (s.status === "active") s.status = result.status === "cancelled" ? "skipped" : "failed";
    try {
      await this.deps.repo.saveRun(run);
    } catch (err) {
      this.log(`[run ${run.id.slice(0, 8)}] couldn't save run: ${(err as Error).message}`);
    }
    this.log(`[run ${run.id.slice(0, 8)}] ${run.status}`);
    this.active = null;
    this.emit(live, { type: "done", run: structuredClone(run) });
    live.listeners.clear();
    setTimeout(() => this.live.delete(run.id), KEEP_FINISHED_MS).unref?.();
  }

  private async attempt(live: LiveRun, req: Parameters<Engine["purchase"]>[0], allowFallback: boolean): Promise<RunOutcome> {
    const { run } = live;
    const engine = this.deps.engines[run.engine];
    try {
      const reason = await engine.unavailableReason();
      if (reason) throw new EngineError(reason);
      return await engine.purchase(req, this.context(live));
    } catch (err) {
      const signal = live.controller.signal;
      if (signal.aborted) {
        if (live.committed) return { status: "unknown", message: MESSAGES.unknown, committed: true };
        return signal.reason === "timeout"
          ? { status: "timeout", message: MESSAGES.timeout }
          : { status: "cancelled", message: MESSAGES.cancelled };
      }
      const committed = live.committed || (err instanceof EngineError && err.committed);
      if (committed) return { status: "unknown", message: MESSAGES.unknown, committed: true };
      const why = (err as Error).message || String(err);

      if (allowFallback && run.engine === "api") {
        const browser = this.deps.engines.browser;
        const reason = await browser.unavailableReason();
        if (!reason) {
          this.context(live).log(`Fast engine failed (${why}). Retrying in the browser.`);
          run.fellBackFrom = "api";
          run.engine = "browser";
          for (const s of run.steps) {
            s.status = "pending";
            s.detail = undefined;
          }
          this.emit(live, { type: "engine", engine: "browser", fellBackFrom: "api" });
          return this.attempt(live, req, false);
        }
        this.context(live).log(`Fast engine failed and the browser engine isn't available: ${reason}`);
      }
      return { status: "error", message: MESSAGES.error(why) };
    }
  }

  private pruneIdempotency() {
    const cutoff = this.now() - 60 * 60 * 1000;
    for (const [k, v] of this.idempotency) if (v.at < cutoff) this.idempotency.delete(k);
  }

  private async pruneScreenshots() {
    const files = (await readdir(this.deps.screenshotsDir)).filter((f) => f.endsWith(".png"));
    if (files.length <= MAX_SCREENSHOTS) return;
    const runs = await this.deps.repo.listRuns();
    const keep = new Set(runs.slice(0, MAX_SCREENSHOTS).map((r) => `${r.id}.png`));
    keep.add(`${this.active?.run.id}.png`);
    await Promise.all(files.filter((f) => !keep.has(f)).map((f) => rm(path.join(this.deps.screenshotsDir, f), { force: true })));
  }
}
