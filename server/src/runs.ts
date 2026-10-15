import { STEPS, type EngineMode, type EngineName, type Run, type RunEvent, type RunOutcome } from "../../shared/types.ts";
import { EngineError, type Engine, type EngineContext, type PurchaseRequest } from "./engines/types.ts";
import type { ScreenshotStore } from "./screenshots.ts";

/** How long a run stays in memory so a reconnecting phone can replay it. */
const KEEP_FINISHED_MS = 30 * 60 * 1000;

export const MESSAGES = {
  error: (why: string) => `Something went wrong talking to TapNPark: ${why} Nothing was bought.`,
  unknown:
    "The purchase may have gone through, but TapNPark didn't confirm it. Check your texts for a TapNPark receipt before trying again.",
  timeout: "TapNPark took too long, so Auto-Park stopped before checking out. Nothing was bought.",
  cancelled: "Cancelled. Nothing was bought.",
};

type Listener = (e: RunEvent) => void;

interface LiveRun {
  run: Run;
  listeners: Set<Listener>;
  controller: AbortController;
  committed: boolean;
}

/** A validated purchase: plate/phone/promo are already normalized. Nothing here is persisted. */
export interface RunInput {
  plate: string;
  phone: string;
  promoCode: string;
  rateName: string;
  vehicleName: string;
  engine: EngineMode;
  dryRun: boolean;
  allowLotMismatch: boolean;
  idempotencyKey: string;
}

export type StartResult =
  | { ok: true; run: Run; existing: boolean }
  | { ok: false; code: "busy"; run: Run }
  | { ok: false; code: "too_many"; message: string };

export interface RunManagerDeps {
  engines: Record<EngineName, Engine>;
  lotCode: string;
  timeoutMs: number;
  screenshots: ScreenshotStore;
  /** Runs allowed at once across all plates (the app is public). */
  maxConcurrent?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

/**
 * Runs purchases in memory. One run per plate at a time; a repeated tap
 * (same idempotency key) returns the run it already started. Phone numbers and
 * promo codes only live inside the running engine call and are never stored.
 */
export class RunManager {
  private live = new Map<string, LiveRun>();
  private activeByPlate = new Map<string, LiveRun>();
  private idempotency = new Map<string, { runId: string; at: number }>();
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: RunManagerDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((m) => console.log(m));
  }

  get activeCount(): number {
    return this.activeByPlate.size;
  }

  start(input: RunInput): StartResult {
    this.prune();
    const seen = this.idempotency.get(input.idempotencyKey);
    const existing = seen && this.live.get(seen.runId);
    if (existing) return { ok: true, run: structuredClone(existing.run), existing: true };

    const busy = this.activeByPlate.get(input.plate);
    if (busy) return { ok: false, code: "busy", run: structuredClone(busy.run) };
    if (this.activeByPlate.size >= (this.deps.maxConcurrent ?? 5)) {
      return { ok: false, code: "too_many", message: "Auto-Park is busy right now. Try again in a few seconds." };
    }

    const primary: EngineName = input.engine === "auto" ? "api" : input.engine;
    const run: Run = {
      id: crypto.randomUUID(),
      createdAt: new Date(this.now()).toISOString(),
      plate: input.plate,
      vehicleName: input.vehicleName || input.plate,
      rateName: input.rateName,
      dryRun: input.dryRun,
      engine: primary,
      status: "running",
      steps: STEPS.map((s) => ({ id: s.id, status: "pending" })),
      hasScreenshot: false,
      logs: [],
    };
    const live: LiveRun = { run, listeners: new Set(), controller: new AbortController(), committed: false };
    this.live.set(run.id, live);
    this.activeByPlate.set(input.plate, live);
    this.idempotency.set(input.idempotencyKey, { runId: run.id, at: this.now() });
    this.log(`[run ${run.id.slice(0, 8)}] start ${run.dryRun ? "test " : ""}via ${primary}`);

    void this.execute(
      live,
      {
        lotCode: this.deps.lotCode,
        plate: input.plate,
        phone: input.phone,
        promoCode: input.promoCode,
        rateName: input.rateName,
        dryRun: input.dryRun,
        allowLotMismatch: input.allowLotMismatch,
      },
      input.engine === "auto",
    );
    return { ok: true, run: structuredClone(run), existing: false };
  }

  cancel(id: string): { ok: true } | { ok: false; code: "not_running" | "too_late" } {
    const live = this.live.get(id);
    if (!live || live.run.status !== "running") return { ok: false, code: "not_running" };
    if (live.committed) return { ok: false, code: "too_late" };
    live.controller.abort("user");
    return { ok: true };
  }

  getRun(id: string): Run | null {
    const live = this.live.get(id);
    return live ? structuredClone(live.run) : null;
  }

  /** Sends a snapshot, then live events until "done". Returns an unsubscribe function, or null if unknown. */
  subscribe(id: string, listener: Listener): (() => void) | null {
    const live = this.live.get(id);
    if (!live) return null;
    listener({ type: "snapshot", run: structuredClone(live.run) });
    if (live.run.status !== "running") {
      listener({ type: "done", run: structuredClone(live.run) });
      return () => {};
    }
    live.listeners.add(listener);
    return () => live.listeners.delete(listener);
  }

  readScreenshot(id: string) {
    return this.deps.screenshots.read(id);
  }

  private emit(live: LiveRun, e: RunEvent) {
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
          await this.deps.screenshots.save(run.id, png);
          run.hasScreenshot = true;
        } catch (err) {
          this.log(`[run ${run.id.slice(0, 8)}] couldn't save screenshot: ${(err as Error).message}`);
        }
      },
    };
  }

  private async execute(live: LiveRun, req: PurchaseRequest, allowFallback: boolean) {
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
    this.log(`[run ${run.id.slice(0, 8)}] ${run.status}`);
    this.activeByPlate.delete(run.plate);
    this.emit(live, { type: "done", run: structuredClone(run) });
    live.listeners.clear();
  }

  private async attempt(live: LiveRun, req: PurchaseRequest, allowFallback: boolean): Promise<RunOutcome> {
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
        return signal.reason === "timeout" ? { status: "timeout", message: MESSAGES.timeout } : { status: "cancelled", message: MESSAGES.cancelled };
      }
      const committed = live.committed || (err instanceof EngineError && err.committed);
      if (committed) return { status: "unknown", message: MESSAGES.unknown, committed: true };
      const why = (err as Error).message || String(err);

      if (allowFallback && run.engine === "api") {
        const reason = await this.deps.engines.browser.unavailableReason();
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
      }
      return { status: "error", message: MESSAGES.error(why) };
    }
  }

  /** Forget finished runs and stale idempotency keys after a while. */
  private prune() {
    const now = this.now();
    for (const [id, live] of this.live) {
      const done = live.run.finishedAt ? Date.parse(live.run.finishedAt) : null;
      if (done !== null && now - done > KEEP_FINISHED_MS) this.live.delete(id);
    }
    for (const [k, v] of this.idempotency) if (now - v.at > KEEP_FINISHED_MS) this.idempotency.delete(k);
  }
}
