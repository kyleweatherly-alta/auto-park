import type { Run } from "./types.ts";

/** After an unclear checkout, ask before buying again for this long. */
export const UNKNOWN_GRACE_MS = 30 * 60 * 1000;
export const MAX_HISTORY = 100;

/** The latest real purchase whose session hasn't ended yet (optionally for one plate). */
export function parkedUntil(runs: Run[], plate?: string, now = Date.now()): { plate: string; endTime: string; runId: string } | null {
  for (const run of runs) {
    if (run.dryRun || run.status !== "success" || !run.outcome?.endTime) continue;
    if (plate && run.plate !== plate) continue;
    if (Date.parse(run.outcome.endTime) > now) return { plate: run.plate, endTime: run.outcome.endTime, runId: run.id };
  }
  return null;
}

/** A recent purchase for this plate that may or may not have gone through. */
export function recentUnknown(runs: Run[], plate: string, now = Date.now()): Run | null {
  for (const run of runs) {
    if (run.plate !== plate || run.dryRun) continue;
    if (now - Date.parse(run.createdAt) > UNKNOWN_GRACE_MS) break;
    if (run.status === "unknown") return run;
    if (run.status === "success") return null;
  }
  return null;
}

/** Insert or replace a run, newest first, capped. */
export function upsertRun(runs: Run[], run: Run, max = MAX_HISTORY): Run[] {
  const rest = runs.filter((r) => r.id !== run.id);
  return [run, ...rest].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, max);
}
